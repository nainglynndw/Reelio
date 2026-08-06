import { IDEA_SYSTEM_PROMPT, NEWS_RESEARCH_SYSTEM_PROMPT, NEWS_SYSTEM_PROMPT, normalizeIdeaOutput } from "./idea-generator.mjs";
import { generateGroundedText, generateText, textProviderConfig } from "./text-provider.mjs";
import { ValidationError } from "./validation.mjs";

export async function generateAutomationBrief(automation, recentBriefs = []) {
  if (!textProviderConfig().ready) {
    throw new ValidationError("Add a Gemini or OpenRouter API key in Settings before generating automation briefs.", 503);
  }
  const exclusions = recentBriefs
    .map((brief) => firstLine(brief))
    .filter(Boolean)
    .slice(-20);
  const avoid = exclusions.length
    ? `\nDo not repeat or closely paraphrase any of these recent video angles:\n${exclusions.map((line) => `- ${line}`).join("\n")}`
    : "";
  const focus = automation.topicFocus?.trim();
  const category = automation.template.category ?? "Knowledge";
  const duration = automation.template.duration ?? "60–90 sec";
  const language = automation.template.language ?? "English";

  if (automation.briefSource === "news") {
    const today = new Date().toISOString().slice(0, 10);
    const research = await generateGroundedText({
      system: NEWS_RESEARCH_SYSTEM_PROMPT,
      user: focus
        ? `Today is ${today}. Research the latest verifiable news about "${focus}" (within ${category}) for a factual knowledge video.${avoid}`
        : `Today is ${today}. Research current ${category} news now for a factual knowledge video.${avoid}`,
      maxTokens: 700,
      temperature: 0.18,
      recentDays: 7,
      thinkingLevel: "high",
    });
    if (!research) throw new ValidationError("Latest News automation requires a Gemini API key with Google Search.", 503);
    if (!research.sources?.length) throw new ValidationError("No verified recent story was found for this calendar entry.", 502);
    const generated = await generateText({
      system: NEWS_SYSTEM_PROMPT,
      user: `Today is ${today}. Create one ${duration} brief in ${language} using only this source-grounded research. Choose an angle unlike the recent topics listed below.${avoid}\n\nResearch:\n${research.text}`,
      maxTokens: 650,
      temperature: 0.25,
      thinkingLevel: "medium",
      task: "creative",
    });
    const brief = normalizeIdeaOutput(generated?.text);
    if (!brief) throw new ValidationError("No usable current-news brief was produced.", 502);
    return { brief, title: firstLine(brief), provider: generated.provider, model: generated.model, fallback: generated.fallback ?? null, sources: research.sources };
  }

  const generated = await generateText({
    system: IDEA_SYSTEM_PROMPT,
    user: focus
      ? `Suggest a new, fact-safe, specific ${duration} knowledge-video brief about "${focus}". Keep it in the "${category}" style. Write it in ${language}.${avoid}`
      : `Suggest a new, fact-safe ${duration} knowledge-video brief for the "${category}" category. Write it in ${language}.${avoid}`,
    maxTokens: 650,
    temperature: 0.72,
    thinkingLevel: "medium",
    task: "creative",
  });
  const brief = normalizeIdeaOutput(generated?.text);
  if (!brief) throw new ValidationError("The AI did not return a usable automation brief.", 502);
  return { brief, title: firstLine(brief), provider: generated.provider, model: generated.model, fallback: generated.fallback ?? null, sources: [] };
}

export function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 180) ?? "";
}
