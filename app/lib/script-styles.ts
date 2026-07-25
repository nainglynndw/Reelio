import type { ScriptStyle } from "./types";

export const scriptStyles: Array<{ id: ScriptStyle; label: string; detail: string }> = [
  { id: "clear-explainer", label: "Clear explainer", detail: "Direct hook → explanation → payoff" },
  { id: "story-led", label: "Story-led", detail: "Scene → tension → insight" },
  { id: "problem-solution", label: "Problem → solution", detail: "Problem → cause → practical fix" },
  { id: "myth-fact", label: "Myth vs fact", detail: "Belief → correction → better model" },
  { id: "list-format", label: "List format", detail: "Signposted takeaways → conclusion" },
  { id: "question-led", label: "Question-led", detail: "Guiding questions → earned answer" },
  { id: "case-study", label: "Case study", detail: "Example → analysis → lesson" },
  { id: "compare-contrast", label: "Compare & contrast", detail: "Two sides → differences → takeaway" },
  { id: "timeline", label: "Timeline", detail: "Beginning → turning points → meaning" },
  { id: "practical-guide", label: "Practical guide", detail: "Goal → steps → realistic result" },
];
