import type { NarratorId } from "./types";

export const narrators: Array<{
  id: NarratorId;
  initial: string;
  name: string;
  role: string;
  voice: string;
  tone: string;
  character: string;
  pace: string;
  sampleLine: string;
}> = [
  { id: "maya", initial: "M", name: "Maya", role: "Warm guide", voice: "Warm feminine", tone: "Reassuring", character: "Friendly teacher", pace: "Measured", sampleLine: "Let’s make the complicated part feel simple." },
  { id: "theo", initial: "T", name: "Theo", role: "Curious analyst", voice: "Clear masculine", tone: "Thoughtful", character: "Evidence-minded investigator", pace: "Deliberate", sampleLine: "The interesting clue is what the evidence leaves out." },
  { id: "nova", initial: "N", name: "Nova", role: "Energetic host", voice: "Bright feminine", tone: "Lively", character: "Confident creator", pace: "Brisk", sampleLine: "Here’s the twist that changes the whole story." },
  { id: "ellis", initial: "E", name: "Ellis", role: "Calm documentarian", voice: "Mature masculine", tone: "Composed", character: "Cinematic storyteller", pace: "Unhurried", sampleLine: "Step back, and the larger pattern becomes clear." },
];
