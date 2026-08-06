import { GoogleGenAI } from "@google/genai";

const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.6-flash";
const DEFAULT_GEMINI_CREATIVE_MODEL = "gemini-3.6-flash";
const DEFAULT_GEMINI_CONVERSATION_MODEL = "gemini-3.6-flash";
const DEFAULT_GEMINI_UTILITY_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free";

export function textProviderConfig(task = "creative") {
  const preferred = String(process.env.REELIO_TEXT_PROVIDER ?? "google").trim().toLowerCase();
  const googleReady = Boolean(geminiApiKey());
  const openrouterReady = Boolean(process.env.OPENROUTER_API_KEY);
  const provider = preferred === "openrouter" && openrouterReady
    ? "openrouter"
    : googleReady
      ? "google"
      : openrouterReady
        ? "openrouter"
        : "studio";
  return {
    provider,
    preferred,
    ready: provider !== "studio",
    googleReady,
    openrouterReady,
    model: provider === "google"
      ? googleModelForTask(task)
      : provider === "openrouter"
      ? process.env.OPENROUTER_TEXT_MODEL ?? DEFAULT_OPENROUTER_MODEL
      : "built-in English fallback",
    creativeModel: provider === "google" ? googleModelForTask("creative") : null,
    conversationModel: provider === "google" ? googleModelForTask("conversation") : null,
    utilityModel: provider === "google" ? googleModelForTask("utility") : null,
  };
}

export async function generateText({ system, user, maxTokens = 700, temperature = 0.7, thinkingLevel = "medium", task = "creative" }) {
  const config = textProviderConfig(task);
  if (config.provider === "studio") return null;

  if (config.provider === "google") {
    try {
      return await callGemini({ system, user, maxTokens, temperature, thinkingLevel, model: config.model, task });
    } catch (primaryError) {
      if (process.env.OPENROUTER_API_KEY) {
        try {
          const fallback = await callOpenRouter({
            system,
            user,
            maxTokens,
            temperature,
            model: process.env.OPENROUTER_FALLBACK_MODEL ?? DEFAULT_OPENROUTER_FALLBACK_MODEL,
            task,
          });
          return {
            ...fallback,
            fallback: {
              provider: "google",
              model: config.model,
              reason: conciseProviderError(primaryError),
            },
          };
        } catch {
          // Continue to the optional hosted fallback below.
        }
      }
      throw primaryError;
    }
  }

  if (config.provider === "openrouter") {
    try {
      return await callOpenRouter({ system, user, maxTokens, temperature, model: config.model, task });
    } catch (primaryError) {
      const fallbackModel = String(process.env.OPENROUTER_FALLBACK_MODEL ?? DEFAULT_OPENROUTER_FALLBACK_MODEL).trim();
      if (fallbackModel && fallbackModel !== config.model) {
        try {
          const fallback = await callOpenRouter({ system, user, maxTokens, temperature, model: fallbackModel, task });
          return {
            ...fallback,
            fallback: {
              provider: "openrouter",
              model: config.model,
              reason: conciseProviderError(primaryError),
            },
          };
        } catch {
          // Continue to the explicitly configured hosted fallback below.
        }
      }
      throw primaryError;
    }
  }
  return null;
}

export async function generateGroundedText({ system, user, maxTokens = 320, temperature = 0.35, recentDays = 7, thinkingLevel = "medium", task = "research" }) {
  const key = geminiApiKey();
  if (!key) return null;
  const hasTimeWindow = Number.isFinite(recentDays);
  const end = new Date();
  const start = hasTimeWindow ? new Date(end.getTime() - Math.max(1, recentDays) * 86_400_000) : null;
  const toSecondPrecision = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return callGemini({
    system,
    user,
    maxTokens,
    temperature,
    thinkingLevel,
    model: googleModelForTask(task),
    task,
    grounded: true,
    searchWindow: start ? { startTime: toSecondPrecision(start), endTime: toSecondPrecision(end) } : null,
  });
}

async function callGemini({ system, user, maxTokens, temperature, thinkingLevel = "medium", model, task = "creative", grounded = false, searchWindow }) {
  const client = new GoogleGenAI({ apiKey: geminiApiKey() });
  const generationConfig = {
    systemInstruction: system,
    maxOutputTokens: geminiOutputTokenLimit(maxTokens, thinkingLevel),
    thinkingConfig: { thinkingLevel: normalizeThinkingLevel(thinkingLevel) },
    ...(usesDefaultGeminiSampling(model) ? {} : { temperature }),
    ...(grounded ? { tools: [{ googleSearch: searchWindow ? { timeRangeFilter: searchWindow } : {} }] } : {}),
  };
  const response = await withTimeout(client.models.generateContent({
    model,
    contents: user,
    config: generationConfig,
  }), Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000), "Google Gemini text generation");
  const text = typeof response.text === "string" ? response.text : "";
  if (!text.trim()) throw new Error("Google Gemini returned an empty response.");
  const sources = (response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk?.web)
    .filter((source) => source?.uri)
    .map((source) => ({ title: String(source.title ?? "Source"), url: String(source.uri) }))
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 5);
  return { text: text.trim(), provider: "google", model, task, sources };
}

export function normalizeThinkingLevel(value) {
  const level = String(value ?? "medium").trim().toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(level) ? level : "medium";
}

async function callOpenRouter({ system, user, maxTokens, temperature, model, task = "creative" }) {
  const baseUrl = String(process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Reelio",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens,
      temperature,
    }),
  }, Number(process.env.OPENROUTER_TIMEOUT_MS ?? 90_000));
  if (!response.ok) {
    const detail = await safeError(response);
    throw new Error(`OpenRouter text generation failed (${response.status})${detail ? `: ${detail}` : "."}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("")
      : "";
  if (!text.trim()) throw new Error("OpenRouter returned an empty response.");
  return { text: text.trim(), provider: "openrouter", model: data.model ?? model, task };
}

export function googleModelForTask(task = "creative") {
  const normalized = String(task ?? "creative").trim().toLowerCase();
  const shared = String(process.env.GEMINI_TEXT_MODEL ?? "").trim();
  if (normalized === "utility" || normalized === "mechanical") {
    return String(process.env.GEMINI_UTILITY_MODEL ?? shared ?? DEFAULT_GEMINI_UTILITY_MODEL).trim() || DEFAULT_GEMINI_UTILITY_MODEL;
  }
  if (normalized === "conversation") {
    return String(process.env.GEMINI_CONVERSATION_MODEL ?? process.env.GEMINI_CREATIVE_MODEL ?? shared ?? DEFAULT_GEMINI_CONVERSATION_MODEL).trim() || DEFAULT_GEMINI_CONVERSATION_MODEL;
  }
  return String(process.env.GEMINI_CREATIVE_MODEL ?? shared ?? DEFAULT_GEMINI_CREATIVE_MODEL).trim() || DEFAULT_GEMINI_CREATIVE_MODEL;
}

export function usesDefaultGeminiSampling(model) {
  return /^gemini-3(?:[.-]|$)/i.test(String(model ?? "").trim());
}

export function geminiOutputTokenLimit(maxTokens, thinkingLevel = "medium") {
  const requested = Number.isFinite(Number(maxTokens)) ? Math.max(64, Math.round(Number(maxTokens))) : 700;
  const multiplier = {
    minimal: 1.5,
    low: 2,
    medium: 3,
    high: 4,
  }[normalizeThinkingLevel(thinkingLevel)] ?? 3;
  return Math.min(16_384, Math.max(512, Math.ceil(requested * multiplier)));
}

function conciseProviderError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Provider request failed");
  return message.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function safeError(response) {
  try {
    const data = await response.json();
    return String(data?.error?.message ?? data?.message ?? "").slice(0, 300);
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Text provider timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function geminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
}

export async function validateGeminiApiKey(key = geminiApiKey()) {
  if (!key) return { ready: false, error: "Gemini API key is not configured." };
  try {
    const client = new GoogleGenAI({ apiKey: key });
    await withTimeout(client.models.generateContent({
      model: googleModelForTask("utility"),
      contents: "Reply OK",
      config: { maxOutputTokens: 16 },
    }), 15_000, "Gemini credential check");
    return { ready: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini credential check failed.";
    return { ready: false, error: /API_KEY_INVALID|API key not valid/i.test(message) ? "Google rejected this API key. Use a Gemini API key from Google AI Studio." : message.slice(0, 240) };
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs); timer.unref(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export {
  DEFAULT_GEMINI_CONVERSATION_MODEL,
  DEFAULT_GEMINI_CREATIVE_MODEL,
  DEFAULT_GEMINI_TEXT_MODEL,
  DEFAULT_GEMINI_UTILITY_MODEL,
  DEFAULT_OPENROUTER_MODEL,
};
