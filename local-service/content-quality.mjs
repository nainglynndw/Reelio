export const SCRIPT_VOICE_EXAMPLES = `<writing_examples>
These examples demonstrate specificity, spoken rhythm, and a controlling question. They are style references only. Never copy their facts, names, or wording into another topic.

<example>
<weak>Did you know skyscrapers can move in the wind? Let's dive into the amazing science behind how engineers keep them stable.</weak>
<strong>Near the top of Taipei 101, a 660-ton steel sphere moves when the tower sways. That sounds like extra motion—the exact thing an engineer should avoid. So why does letting one part swing make the whole building feel steadier?</strong>
<why>The strong version begins inside a visible mechanism, identifies the contradiction, and earns its question without hype.</why>
</example>

<example>
<weak>Bees are fascinating creatures that make surprisingly intelligent group decisions without a leader.</weak>
<strong>A scout bee returns with a location. Another returns with a different one. Neither bee is in charge, yet the swarm still has to choose a single new home. The decision emerges from what each scout does next.</strong>
<why>The strong version creates a scene, withholds the mechanism until it matters, and uses ordinary spoken language.</why>
</example>

<example>
<weak>This discovery changes everything and proves that the solution was hiding in plain sight all along.</weak>
<strong>The result is narrower—and more useful. The method works under these conditions, which tells you exactly when the apparent shortcut stops being one.</strong>
<why>The strong version preserves the caveat and turns it into the payoff instead of manufacturing importance.</why>
</example>
</writing_examples>`;

export const CONVERSATION_VOICE_EXAMPLE = `<dialogue_example>
This is a fictional style example only. Do not copy its story or wording.
Participants: owner "Mara"; other "Jonah".
[
  {"type":"text","participantId":"mara","text":"You still have my spare key?","delayBeforeMs":500,"typingMs":900,"holdMs":1200,"displayTime":"21:08","receipt":"sent"},
  {"type":"text","participantId":"jonah","text":"define “have”","delayBeforeMs":850,"typingMs":650,"holdMs":1100,"displayTime":"21:08","receipt":"none"},
  {"type":"text","participantId":"mara","text":"Jonah.","delayBeforeMs":400,"typingMs":350,"holdMs":850,"displayTime":"21:08","receipt":"delivered"},
  {"type":"text","participantId":"jonah","text":"it is being held hostage by my laundry basket","delayBeforeMs":1000,"typingMs":1300,"holdMs":1500,"displayTime":"21:09","receipt":"none"}
]
Why it works: Mara is direct and punctuated; Jonah is evasive, lowercase, and oddly specific. Each message changes the situation. The messages do not explain emotions the reader can infer.
</dialogue_example>`;

export function modelProvenance(result) {
  if (!result) return null;
  return {
    provider: result.provider,
    model: result.model,
    task: result.task ?? "creative",
    ...(result.fallback ? { fallback: result.fallback } : {}),
  };
}

export function parseScriptPatches(value) {
  const raw = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!raw) return [];
  const candidates = [raw];
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(raw.slice(firstBracket, lastBracket + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map((patch) => ({
          find: String(patch?.find ?? ""),
          replace: String(patch?.replace ?? ""),
          reason: String(patch?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
        }))
        .filter((patch) => patch.find && patch.replace !== patch.find)
        .slice(0, 10);
    } catch {
      // Try the bracket-delimited candidate when the provider added a preamble.
    }
  }
  return [];
}

export function applyScriptPatches(script, patches) {
  let text = String(script ?? "");
  const applied = [];
  const rejected = [];
  for (const patch of Array.isArray(patches) ? patches : []) {
    const find = String(patch?.find ?? "");
    const replace = String(patch?.replace ?? "");
    const first = find ? text.indexOf(find) : -1;
    const unique = first >= 0 && text.indexOf(find, first + find.length) === -1;
    const bounded = find.length >= 3 && replace.length <= Math.max(600, find.length * 3);
    if (!unique || !bounded) {
      rejected.push({ ...patch, issue: !unique ? "find text was missing or ambiguous" : "replacement was too expansive" });
      continue;
    }
    text = `${text.slice(0, first)}${replace}${text.slice(first + find.length)}`;
    applied.push(patch);
  }
  return { text, applied, rejected };
}
