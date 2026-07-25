import { GoogleGenAI } from "@google/genai";

const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free";

export function textProviderConfig() {
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
      ? process.env.GEMINI_TEXT_MODEL ?? DEFAULT_GEMINI_TEXT_MODEL
      : provider === "openrouter"
      ? process.env.OPENROUTER_TEXT_MODEL ?? DEFAULT_OPENROUTER_MODEL
      : "built-in English fallback",
  };
}

export async function generateText({ system, user, maxTokens = 700, temperature = 0.7, thinkingLevel = "medium" }) {
  const config = textProviderConfig();
  if (config.provider === "studio") return null;

  if (config.provider === "google") {
    try {
      return await callGemini({ system, user, maxTokens, temperature, thinkingLevel, model: config.model });
    } catch (primaryError) {
      if (process.env.OPENROUTER_API_KEY) {
        try {
          return await callOpenRouter({ system, user, maxTokens, temperature, model: process.env.OPENROUTER_FALLBACK_MODEL ?? DEFAULT_OPENROUTER_FALLBACK_MODEL });
        } catch {
          // Continue to the optional hosted fallback below.
        }
      }
      throw primaryError;
    }
  }

  if (config.provider === "openrouter") {
    try {
      return await callOpenRouter({ system, user, maxTokens, temperature, model: config.model });
    } catch (primaryError) {
      const fallbackModel = String(process.env.OPENROUTER_FALLBACK_MODEL ?? DEFAULT_OPENROUTER_FALLBACK_MODEL).trim();
      if (fallbackModel && fallbackModel !== config.model) {
        try {
          return await callOpenRouter({ system, user, maxTokens, temperature, model: fallbackModel });
        } catch {
          // Continue to the explicitly configured hosted fallback below.
        }
      }
      throw primaryError;
    }
  }
  return null;
}

export async function generateGroundedText({ system, user, maxTokens = 320, temperature = 0.35, recentDays = 7, thinkingLevel = "medium" }) {
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
    model: process.env.GEMINI_TEXT_MODEL ?? DEFAULT_GEMINI_TEXT_MODEL,
    grounded: true,
    searchWindow: start ? { startTime: toSecondPrecision(start), endTime: toSecondPrecision(end) } : null,
  });
}

async function callGemini({ system, user, maxTokens, temperature, thinkingLevel = "medium", model, grounded = false, searchWindow }) {
  const client = new GoogleGenAI({ apiKey: geminiApiKey() });
  const response = await withTimeout(client.models.generateContent({
    model,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens: Math.min(16_384, Math.max(8_192, maxTokens * 6)),
      temperature,
      thinkingConfig: { thinkingLevel: normalizeThinkingLevel(thinkingLevel) },
      ...(grounded ? { tools: [{ googleSearch: searchWindow ? { timeRangeFilter: searchWindow } : {} }] } : {}),
    },
  }), Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000), "Google Gemini text generation");
  const text = typeof response.text === "string" ? response.text : "";
  if (!text.trim()) throw new Error("Google Gemini returned an empty response.");
  const sources = (response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk?.web)
    .filter((source) => source?.uri)
    .map((source) => ({ title: String(source.title ?? "Source"), url: String(source.uri) }))
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 5);
  return { text: text.trim(), provider: "google", model, sources };
}

export function normalizeThinkingLevel(value) {
  const level = String(value ?? "medium").trim().toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(level) ? level : "medium";
}

async function callOpenRouter({ system, user, maxTokens, temperature, model }) {
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
  return { text: text.trim(), provider: "openrouter", model: data.model ?? model };
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
      model: process.env.GEMINI_TEXT_MODEL ?? DEFAULT_GEMINI_TEXT_MODEL,
      contents: "Reply OK",
      config: { maxOutputTokens: 4, temperature: 0 },
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

export { DEFAULT_GEMINI_TEXT_MODEL, DEFAULT_OPENROUTER_MODEL };
