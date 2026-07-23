import type { LocalJob, TtsEngine } from "./types";

export const voiceLanguages = [
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Malay", "Norwegian",
  "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Tagalog", "Thai", "Turkish", "Vietnamese",
];
export const speechLanguages = [...voiceLanguages].sort();
const geminiSpeechLanguages = new Set(speechLanguages.filter((language) => !["Khmer", "Tagalog"].includes(language)));

export function defaultTtsEngine(language: string): TtsEngine {
  return language === "English" ? "kokoro" : "voxcpm2";
}

export function ttsEngineOptions(language: string): Array<{ value: TtsEngine; label: string }> {
  if (language === "English") return [
    { value: "kokoro", label: "Kokoro — local" },
    { value: "gemini", label: "Gemini TTS — cloud" },
  ];
  const options: Array<{ value: TtsEngine; label: string }> = [{ value: "voxcpm2", label: "VoxCPM2 — local" }];
  if (geminiSpeechLanguages.has(language)) options.push({ value: "gemini", label: "Gemini TTS — cloud" });
  return options;
}

export function ttsEngineLabel(engine: TtsEngine | undefined, language: string) {
  const value = engine ?? defaultTtsEngine(language);
  return value === "kokoro" ? "Kokoro" : value === "voxcpm2" ? "VoxCPM2" : "Gemini TTS";
}

export function jobTtsEngineLabel(job: LocalJob) {
  if (job.request.ttsEngine) return ttsEngineLabel(job.request.ttsEngine, job.request.language);
  const provider = String(job.metadata?.voiceProvider ?? "");
  if (/voxcpm/i.test(provider)) return "VoxCPM2";
  if (/gemini|google/i.test(provider)) return "Gemini TTS";
  if (/kokoro/i.test(provider)) return "Kokoro";
  return ttsEngineLabel(undefined, job.request.language);
}
