export function parseSubtitles(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("The subtitle file is empty.");
  const normalized = text.replace(/^WEBVTT[^\n]*\n+/i, "");
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/)?.[0];
    if (!timing) continue;
    const [startText, endText] = timing.split("-->").map((value) => value.trim().split(/\s+/)[0]);
    const cueText = lines.slice(timingIndex + 1).join("\n").trim();
    if (!cueText) continue;
    cues.push({ start: subtitleSeconds(startText), end: subtitleSeconds(endText), text: cueText });
  }
  if (!cues.length) throw new Error("No timed subtitle cues were found. Upload an SRT or VTT file.");
  return cues;
}

export function formatSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text.trim()}\n`).join("\n");
}

export function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function subtitleSeconds(value) {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) throw new Error(`Invalid subtitle timestamp: ${value}`);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
