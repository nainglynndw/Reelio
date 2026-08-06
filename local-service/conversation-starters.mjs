const SAFE_CHOICE = /^[\p{L}\p{N} '&/.,:+()-]{1,80}$/u;

export const CONVERSATION_STARTER_OPTIONS = Object.freeze({
  relationships: ["You choose", "Close friends", "Couple", "Siblings", "Coworkers", "Former friends", "Strangers"],
  genres: ["You choose", "Comedy", "Mystery", "Drama", "Wholesome", "Suspense"],
  situations: ["You choose", "Unexpected discovery", "Misunderstanding", "Risky request", "Hidden mistake", "Old promise", "Wrong recipient"],
  endings: ["You choose", "Revealing twist", "Reconciliation", "Difficult decision", "Comic reversal", "Cliffhanger"],
});

const CURATED_STARTERS = [
  {
    title: "The borrowed key",
    premise: "Two close friends realize the spare key one of them supposedly lost was used last night, and each message narrows down who actually entered the apartment.",
    relationship: "Close friends",
    genre: "Mystery",
    situation: "Unexpected discovery",
    ending: "End when the quieter friend admits they used the key to return something they had hidden for years.",
    tone: "restrained, uneasy, and increasingly personal",
    cast: [
      { name: "Mara", role: "phone owner who notices precise inconsistencies", isSelf: true },
      { name: "Jonah", role: "friend who jokes when cornered", isSelf: false },
    ],
  },
  {
    title: "Sent to the wrong person",
    premise: "A coworker sends a sarcastic complaint to the colleague it describes, then discovers that the recipient agrees with every word for a reason neither expected.",
    relationship: "Coworkers",
    genre: "Comedy",
    situation: "Wrong recipient",
    ending: "Finish with the recipient proposing that they send the message to their manager together.",
    tone: "dry, awkward, and fast-moving",
    cast: [
      { name: "Nia", role: "phone owner trying to contain the mistake", isSelf: true },
      { name: "Eli", role: "coworker whose calm replies make the mistake stranger", isSelf: false },
    ],
  },
  {
    title: "The yearly reminder",
    premise: "Two siblings receive the same scheduled message from their late grandfather, but one recognizes a detail that means the message was edited recently.",
    relationship: "Siblings",
    genre: "Drama",
    situation: "Old promise",
    ending: "Reveal that one sibling kept updating the reminder because neither was ready for the tradition to end.",
    tone: "warm, restrained, and emotionally honest",
    cast: [
      { name: "Leah", role: "phone owner who asks direct questions", isSelf: true },
      { name: "Noah", role: "sibling who hides tenderness behind practical details", isSelf: false },
    ],
  },
  {
    title: "One impossible favor",
    premise: "An estranged friend asks for help retrieving a box before sunrise, while refusing to explain why the address belongs to someone both promised never to contact again.",
    relationship: "Former friends",
    genre: "Suspense",
    situation: "Risky request",
    ending: "End with the phone owner deciding whether to go after learning what is inside the box.",
    tone: "urgent, guarded, and specific",
    cast: [
      { name: "Ari", role: "phone owner who refuses vague answers", isSelf: true },
      { name: "Ren", role: "former friend revealing the truth in reluctant fragments", isSelf: false },
    ],
  },
  {
    title: "The review nobody wrote",
    premise: "A couple finds a detailed online review of their first date posted under one partner’s name, although both insist they never wrote it.",
    relationship: "Couple",
    genre: "Mystery",
    situation: "Unexpected discovery",
    ending: "Reveal that a restaurant employee remembered the date for a small act neither partner noticed at the time.",
    tone: "playful, curious, and quietly affectionate",
    cast: [
      { name: "Sofia", role: "phone owner who remembers exact details", isSelf: true },
      { name: "Cal", role: "partner who tests theories through jokes", isSelf: false },
    ],
  },
  {
    title: "The package swap",
    premise: "Two strangers discover their nearly identical packages were switched, but each is reluctant to describe what should have been inside.",
    relationship: "Strangers",
    genre: "Comedy",
    situation: "Misunderstanding",
    ending: "Finish when both admit they ordered the same embarrassing item for completely different reasons.",
    tone: "wary, deadpan, and increasingly ridiculous",
    cast: [
      { name: "Priya", role: "phone owner who communicates in careful complete sentences", isSelf: true },
      { name: "Max", role: "stranger who answers too briefly until forced to explain", isSelf: false },
    ],
  },
  {
    title: "The missing presentation",
    premise: "Minutes before a client call, two coworkers discover that the final presentation has been replaced by an old private draft containing comments about everyone attending.",
    relationship: "Coworkers",
    genre: "Suspense",
    situation: "Hidden mistake",
    ending: "End when they realize the client already downloaded the file and has started typing.",
    tone: "compressed, sharp, and darkly funny",
    cast: [
      { name: "Iris", role: "phone owner triaging the damage", isSelf: true },
      { name: "Dev", role: "coworker whose short replies reveal escalating panic", isSelf: false },
    ],
  },
  {
    title: "The plant-sitting confession",
    premise: "A friend sends daily photos proving they watered the phone owner’s favorite plant, until one photo reveals they have quietly replaced it three times.",
    relationship: "Close friends",
    genre: "Wholesome",
    situation: "Hidden mistake",
    ending: "Finish with the owner admitting the original plant was artificial.",
    tone: "gentle, teasing, and affectionate",
    cast: [
      { name: "Tess", role: "phone owner who lets the evidence accumulate", isSelf: true },
      { name: "Owen", role: "friend whose explanations become increasingly elaborate", isSelf: false },
    ],
  },
];

export function normalizeStarterCriteria(value = {}) {
  const targetSeconds = Number(value.targetSeconds ?? 60);
  const participantCount = Number(value.participantCount ?? 2);
  return {
    relationship: choice(value.relationship, CONVERSATION_STARTER_OPTIONS.relationships),
    genre: choice(value.genre, CONVERSATION_STARTER_OPTIONS.genres),
    situation: choice(value.situation, CONVERSATION_STARTER_OPTIONS.situations),
    endingStyle: choice(value.endingStyle, CONVERSATION_STARTER_OPTIONS.endings),
    language: clean(value.language, 80, "English"),
    targetSeconds: Number.isFinite(targetSeconds) ? Math.max(15, Math.round(targetSeconds)) : 60,
    participantCount: Number.isFinite(participantCount) ? Math.max(2, Math.min(12, Math.round(participantCount))) : 2,
  };
}

export function curatedConversationPitches(criteriaValue = {}, recentPremises = []) {
  const criteria = normalizeStarterCriteria(criteriaValue);
  const recent = recentPremises.map((item) => String(item).toLowerCase()).filter(Boolean);
  const score = (pitch) => [
    criteria.relationship === "You choose" || pitch.relationship === criteria.relationship,
    criteria.genre === "You choose" || pitch.genre === criteria.genre,
    criteria.situation === "You choose" || pitch.situation === criteria.situation,
    !recent.some((item) => similarityKey(pitch.premise).includes(similarityKey(item).slice(0, 28))),
  ].reduce((total, match, index) => total + (match ? [3, 3, 2, 2][index] : 0), 0);
  return CURATED_STARTERS
    .map((pitch, index) => ({ pitch, index, score: score(pitch) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(({ pitch, index }) => normalizeConversationPitch({ ...pitch, id: `curated-${index + 1}` }, criteria, index));
}

export function parseConversationPitches(value, criteriaValue = {}) {
  const criteria = normalizeStarterCriteria(criteriaValue);
  const raw = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 3).map((pitch, index) => normalizeConversationPitch(pitch, criteria, index)).filter(Boolean);
}

export function guidedConversationPitch(criteriaValue = {}) {
  const criteria = normalizeStarterCriteria(criteriaValue);
  const relationship = criteria.relationship === "You choose" ? "two people with unfinished history" : relationshipSubject(criteria.relationship);
  const situation = {
    "Unexpected discovery": "one of them finds evidence that contradicts a story they both accepted",
    Misunderstanding: "a small misunderstanding exposes a larger assumption neither had questioned",
    "Risky request": "one asks for a favor that becomes harder to justify with every reply",
    "Hidden mistake": "an ordinary mistake reveals that one person has been hiding a second problem",
    "Old promise": "an old promise becomes relevant in a way neither expected",
    "Wrong recipient": "a message reaches the one person who was never meant to see it",
    "You choose": "an ordinary message uncovers a specific problem neither can ignore",
  }[criteria.situation];
  const ending = {
    "Revealing twist": "a final concrete detail changes the meaning of the opening message",
    Reconciliation: "they make one believable choice that begins repairing the relationship",
    "Difficult decision": "the phone owner must make a clear decision with a real cost",
    "Comic reversal": "the apparent problem reverses for an earned, character-based reason",
    Cliffhanger: "the last incoming message creates one precise unanswered consequence",
    "You choose": "the final exchange changes what one participant will do next",
  }[criteria.endingStyle];
  return normalizeConversationPitch({
    id: "guided",
    title: "Your guided story",
    premise: `${capitalize(relationship)} begin messaging when ${situation}; the exchange escalates through specific discoveries until ${ending}.`,
    relationship: criteria.relationship,
    genre: criteria.genre,
    situation: criteria.situation,
    ending,
    tone: criteria.genre === "Comedy" ? "dry, character-led, and naturally paced" : criteria.genre === "Wholesome" ? "warm, understated, and sincere" : "natural, specific, and steadily escalating",
    cast: [],
  }, criteria, 0);
}

function normalizeConversationPitch(value, criteria, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const premise = clean(value.premise, 700);
  if (premise.length < 20) return null;
  const cast = Array.isArray(value.cast) ? value.cast.slice(0, criteria.participantCount).map((member, castIndex) => ({
    name: clean(member?.name, 40, `Character ${castIndex + 1}`),
    role: clean(member?.role, 160, castIndex === 0 ? "phone owner" : "participant"),
    isSelf: castIndex === 0,
  })) : [];
  return {
    id: clean(value.id, 80, `pitch-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "-"),
    title: clean(value.title, 80, `Story ${index + 1}`),
    premise,
    relationship: clean(value.relationship, 80, criteria.relationship),
    genre: clean(value.genre, 80, criteria.genre),
    situation: clean(value.situation, 80, criteria.situation),
    ending: clean(value.ending, 220, criteria.endingStyle === "You choose" ? "End with a meaningful change or reveal." : criteria.endingStyle),
    tone: clean(value.tone, 80, "natural, specific, and character-led"),
    cast,
  };
}

function choice(value, options) {
  const candidate = String(value ?? "You choose").trim();
  return options.includes(candidate) ? candidate : "You choose";
}

function clean(value, max, fallback = "") {
  const candidate = String(value ?? fallback).replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  if (!candidate) return String(fallback);
  return candidate.slice(0, max);
}

function relationshipSubject(value) {
  return {
    "Close friends": "two close friends",
    Couple: "a couple",
    Siblings: "two siblings",
    Coworkers: "two coworkers",
    "Former friends": "two former friends",
    Strangers: "two strangers",
  }[value] ?? "two people";
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function similarityKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function validStarterChoice(value) {
  return SAFE_CHOICE.test(String(value ?? ""));
}
