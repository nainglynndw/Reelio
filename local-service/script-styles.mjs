export const DEFAULT_SCRIPT_STYLE = "clear-explainer";

export const SCRIPT_STYLES = Object.freeze([
  {
    id: "clear-explainer",
    label: "Clear explainer",
    direction: "Use a direct curiosity hook, explain the central idea in a logical sequence, then finish with a useful payoff.",
  },
  {
    id: "story-led",
    label: "Story-led",
    direction: "Open inside one concrete scene, create tension around the unanswered question, reveal the explanation through the scene, then land the lesson.",
  },
  {
    id: "problem-solution",
    label: "Problem → solution",
    direction: "Make the viewer recognize one specific problem, explain its cause without blame, present a practical solution, then show the expected payoff and limits.",
  },
  {
    id: "myth-fact",
    label: "Myth vs fact",
    direction: "State one belief found in the brief, carefully correct or qualify it, explain the evidence-based reality, then give the viewer a more accurate mental model. Never invent a supposedly popular myth.",
  },
  {
    id: "list-format",
    label: "List format",
    direction: "Organize the explanation into three to five clearly signposted takeaways. Do not imply a ranking unless the brief supports one, and connect the items into one conclusion.",
  },
  {
    id: "question-led",
    label: "Question-led",
    direction: "Use a short sequence of guiding questions that build on each other, answer every question directly, and make the final answer feel earned rather than delayed.",
  },
  {
    id: "case-study",
    label: "Case study",
    direction: "Center the script on one specific example from the brief, analyze what happened, identify the transferable lesson, and state its limits. If the brief has no real case, use a clearly hypothetical everyday scenario without invented names or data.",
  },
  {
    id: "compare-contrast",
    label: "Compare & contrast",
    direction: "Introduce two relevant ideas or approaches, compare them on consistent dimensions supported by the brief, explain the meaningful difference, then give a nuanced takeaway without manufacturing a winner.",
  },
  {
    id: "timeline",
    label: "Timeline",
    direction: "Explain the topic as an ordered progression with a clear beginning, meaningful turning points, and present-day relevance. Never invent dates or historical events absent from the brief.",
  },
  {
    id: "practical-guide",
    label: "Practical guide",
    direction: "Begin with a concrete goal, walk through a small sequence of safe actionable steps, explain why each step matters, then finish with a realistic result and limitation.",
  },
]);

const stylesById = new Map(SCRIPT_STYLES.map((style) => [style.id, style]));

export function scriptStyleProfile(value) {
  return stylesById.get(String(value ?? "").trim()) ?? stylesById.get(DEFAULT_SCRIPT_STYLE);
}
