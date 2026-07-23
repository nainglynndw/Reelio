const FIELD_LABELS = /^(?:idea|topic|hook|visuals?|curiosity gap|payoff|title)\s*:\s*/i;

export const IDEA_SYSTEM_PROMPT = `You suggest subjects for factual knowledge videos and return a short structured brief.
Write plain text in the requested language, formatted exactly like this:
- First line: one natural sentence (18-32 words) stating what the video investigates, explains, compares, or demonstrates, including its angle. Frame any surprising or uncertain idea as a question or investigation, never as established fact.
- Then 2 to 4 lines, each starting with "• ", naming a concrete aspect the video should cover.
- Make the last "• " line the takeaway: what the viewer should understand or do.
Do not invent specific statistics, dates, names, quotes, or causal explanations. Do not write the script, narration, or on-screen text. Use no Markdown headings, bold, numbering, JSON, or emoji.`;

export const NEWS_RESEARCH_SYSTEM_PROMPT = `You are a careful current-news researcher.
You MUST use Google Search before answering.
Find three factual developments relevant to the requested category, preferring the last 72 hours and never older than seven days.
For each development, give its exact publication or event date and a concise factual summary supported by the search sources.
Prefer authoritative primary sources and reputable reporting. Do not fill gaps from memory or invent details.`;

export const NEWS_SYSTEM_PROMPT = `You turn supplied, source-grounded news research into a monetizable knowledge-video brief.
Choose one genuinely recent development from the supplied research.
Avoid rumors, allegations, partisan politics, graphic events, celebrity gossip, medical advice, and financial advice.
Write plain text in the requested language, formatted exactly like this:
- First line: one sentence (20-36 words) saying what happened and what the video should explain.
- Then 2 to 4 lines, each starting with "• ", listing key facts drawn ONLY from the supplied research.
- Make the last "• " line why it matters to the viewer.
Do not add details, dates, quotes, statistics, or causal explanations that are absent from the research. Use no Markdown headings, bold, numbering, JSON, or emoji.`;

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

  // Preserve the structured brief (angle line + "• " points); strip only markup and stray labels.
  const lines = candidate
    .replace(/\*\*|__/g, "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      const isBullet = /^[-*•]\s+/.test(trimmed);
      const cleaned = trimmed.replace(/^[-*•#]+\s*/, "").replace(FIELD_LABELS, "").replace(/\s+/g, " ").trim();
      if (!cleaned) return "";
      return isBullet ? `• ${cleaned}` : cleaned;
    })
    .filter(Boolean);
  return lines.join("\n").slice(0, 700);
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
