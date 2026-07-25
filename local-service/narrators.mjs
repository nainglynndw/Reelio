export const DEFAULT_NARRATOR_ID = "maya";

export const NARRATORS = Object.freeze([
  {
    id: "maya",
    name: "Maya",
    role: "Warm guide",
    voice: "Warm feminine",
    tone: "Reassuring",
    character: "Friendly teacher",
    pace: "Measured",
    sampleLine: "Let’s make the complicated part feel simple.",
    kokoroVoice: "af_heart",
    speedScale: 0.98,
    geminiVoice: "Sulafat",
    delivery: "Use a warm, reassuring feminine guide voice. Sound patient, intelligent, and conversational, with gentle emphasis and a measured natural pace.",
    voxDescription: "A warm adult woman with a reassuring, intelligent voice. She sounds like a friendly teacher: patient, conversational, gently expressive, and measured without becoming sleepy.",
    voxSeed: 104729,
    voxReferenceText: "Let’s take this one clear step at a time. Why does that small detail matter so much? Because once you notice it, the whole idea finally makes sense.",
  },
  {
    id: "theo",
    name: "Theo",
    role: "Curious analyst",
    voice: "Clear masculine",
    tone: "Thoughtful",
    character: "Evidence-minded investigator",
    pace: "Deliberate",
    sampleLine: "The interesting clue is what the evidence leaves out.",
    kokoroVoice: "am_adam",
    speedScale: 0.94,
    geminiVoice: "Charon",
    delivery: "Use a clear, thoughtful masculine analyst voice. Sound curious, precise, and evidence-minded, with deliberate pacing and subtle emphasis on important clues.",
    voxDescription: "A clear adult man with a thoughtful, precise voice. He sounds like an evidence-minded investigator: curious, composed, articulate, and deliberately paced.",
    voxSeed: 130363,
    voxReferenceText: "The strongest explanation begins with the evidence. So what does this particular clue actually rule out? Follow it carefully, and the answer narrows on its own.",
  },
  {
    id: "nova",
    name: "Nova",
    role: "Energetic host",
    voice: "Bright feminine",
    tone: "Lively",
    character: "Confident creator",
    pace: "Brisk",
    sampleLine: "Here’s the twist that changes the whole story.",
    kokoroVoice: "af_nova",
    speedScale: 1.08,
    geminiVoice: "Puck",
    delivery: "Use a bright, lively feminine host voice. Sound confident, quick, and naturally excited, with crisp articulation, expressive contrast, and a brisk pace that never feels rushed.",
    voxDescription: "A bright adult woman with a lively, confident creator voice. She is quick, expressive, crisp, and energetic, using strong contrast while never sounding rushed or exaggerated.",
    voxSeed: 155921,
    voxReferenceText: "Okay, here is the surprising part. Did you catch what just changed? That one detail flips the whole story, and it happens faster than you’d expect.",
  },
  {
    id: "ellis",
    name: "Ellis",
    role: "Calm documentarian",
    voice: "Mature masculine",
    tone: "Composed",
    character: "Cinematic storyteller",
    pace: "Unhurried",
    sampleLine: "Step back, and the larger pattern becomes clear.",
    kokoroVoice: "am_onyx",
    speedScale: 0.88,
    geminiVoice: "Gacrux",
    delivery: "Use a mature, composed masculine documentary voice. Sound grounded, cinematic, and quietly authoritative, with restrained emotion, clear pauses, and an unhurried pace.",
    voxDescription: "A mature adult man with a grounded, composed documentary voice. He sounds cinematic and quietly authoritative, with restrained emotion, clear pauses, and an unhurried pace.",
    voxSeed: 181081,
    voxReferenceText: "Across time, small details gather into a larger pattern. What does that pattern finally reveal? Step back far enough, and the shape of it becomes unmistakable.",
  },
]);

const narratorsById = new Map(NARRATORS.map((narrator) => [narrator.id, narrator]));

export function narratorProfile(value) {
  return narratorsById.get(String(value ?? "").trim()) ?? narratorsById.get(DEFAULT_NARRATOR_ID);
}

export function brandVoiceOverrideEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.REELIO_BRAND_VOICE_OVERRIDE ?? "").trim());
}
