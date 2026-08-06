const FIELD_LABELS = /^(?:idea|topic|hook|visuals?|curiosity gap|payoff|title)\s*:\s*/i;

export const IDEA_SYSTEM_PROMPT = `You develop distinctive subjects for factual knowledge videos and return a compact research-ready brief.
Write plain text in the requested language, formatted exactly like this:
- First line: one natural sentence (18-32 words) with a narrow controlling question, a visible real-world situation, and the specific tension or misconception the video will resolve.
- Then exactly 4 lines, each starting with "• ".
- Bullet 1 names the concrete process, comparison, behavior, object, or event the research should establish.
- Bullet 2 names a real case, demonstration, or counterexample worth finding and verifying.
- Bullet 3 names the important boundary or competing explanation the video must not ignore.
- Bullet 4 states a non-obvious viewer payoff: what the viewer should understand, notice, or responsibly do.
Make the angle specific enough that it could not be reused for an unrelated topic. Frame uncertain ideas as questions or investigations, never as established facts. Do not invent statistics, dates, quotes, causal explanations, or unfamiliar proper names. Do not write narration or on-screen text. Use no headings, bold, numbering, JSON, or emoji.

Quality reference:
Weak: "Explore the fascinating science of sleep and discover tips that could change your life."
Strong:
Why can an unfinished task keep returning to mind after you stop working, and under what conditions does making a concrete completion plan reduce that mental interruption?
• Establish what researchers actually measured when comparing unfinished and completed tasks.
• Find a controlled demonstration that separates memory activation from popular productivity folklore.
• Preserve the boundary between a laboratory effect and a universal explanation for distraction.
• Give viewers a responsible way to test whether a specific written plan reduces their own task-switching.

The strong example earns curiosity through a precise unresolved mechanism, identifies what must be verified, and makes its caveat part of the value. Copy that level of specificity, never its topic or wording. Avoid interchangeable phrases such as "hidden truth", "changes everything", "you won't believe", "power of", "fascinating world", and "let's dive in".`;

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
  return clampBriefLength(lines);
}

export const BRIEF_MAX_CHARS = 1200;

// The prompts ask for an angle line plus four bullets, which regularly exceeds 700 characters. The
// old hard slice cut mid-word and usually removed the last bullet — the viewer payoff — so the
// script writer never saw it. Drop whole lines instead, keeping the angle line and as many bullets
// as fit.
function clampBriefLength(lines, max = BRIEF_MAX_CHARS) {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const addition = kept.length ? line.length + 1 : line.length;
    if (kept.length && length + addition > max) break;
    kept.push(line);
    length += addition;
  }
  const joined = kept.join("\n");
  if (joined.length <= max) return joined;
  // A single over-long first line still has to fit; cut it on a word boundary.
  return joined.slice(0, max).replace(/\s+\S*$/, "").trim();
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
