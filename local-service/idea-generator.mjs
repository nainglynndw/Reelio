const FIELD_LABELS = /^(?:idea|topic|hook|visuals?|curiosity gap|payoff|title)\s*:\s*/i;

export const IDEA_SYSTEM_PROMPT = `You suggest subjects for factual knowledge videos.
Return exactly one JSON object on one line: {"idea":"..."}.
The idea value must be one natural sentence of 18-34 words in the requested language.
Describe only what the video should investigate, explain, compare, or demonstrate.
Do not write a hook, title, script, visual plan, curiosity gap, payoff, answer, statistic, or causal explanation.
Do not present a surprising or uncertain claim as established fact; frame it as a question or an investigation.
Use no Markdown, labels, headings, lists, or emoji.`;

export const NEWS_RESEARCH_SYSTEM_PROMPT = `You are a careful current-news researcher.
You MUST use Google Search before answering.
Find three factual developments relevant to the requested category, preferring the last 72 hours and never older than seven days.
For each development, give its exact publication or event date and a concise factual summary supported by the search sources.
Prefer authoritative primary sources and reputable reporting. Do not fill gaps from memory or invent details.`;

export const NEWS_SYSTEM_PROMPT = `You turn supplied, source-grounded news research into a monetizable knowledge-video subject.
Choose one genuinely recent development from the supplied research.
Avoid rumors, allegations, partisan politics, graphic events, celebrity gossip, medical advice, and financial advice.
Return exactly one JSON object on one line: {"idea":"..."}.
The idea value must be one natural sentence of 20-38 words in the requested language that says what happened and what the video should explain.
Do not add details, dates, quotes, statistics, or causal explanations that are absent from the research. Use no Markdown, labels, headings, lists, or emoji.`;

export function normalizeIdeaOutput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let candidate = unfenced;
  try {
    const parsed = JSON.parse(unfenced);
    if (typeof parsed?.idea === "string") candidate = parsed.idea;
  } catch {
    // A strict prompt normally returns JSON; keep a safe plain-text fallback.
  }

  return candidate
    .replace(/\*\*/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•#\s]+/, "").replace(FIELD_LABELS, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

export function studioIdea(category) {
  const ideas = [
    "Investigate why unfinished tasks can remain active in memory, then demonstrate one evidence-based technique viewers can use to regain focus.",
    "Explain how scout bees reach group decisions without a leader, using their observable behavior to introduce distributed decision-making.",
    "Explore how engineers reduce uncomfortable skyscraper movement in strong wind, using real structural solutions and simple physical demonstrations.",
    "Examine why the passage of time can feel different as people age, separating established findings from popular explanations and offering a practical reflection exercise.",
  ];
  const seed = String(category).split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  return ideas[seed % ideas.length];
}
