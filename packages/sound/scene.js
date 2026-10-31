// The scene contract: mood presets, ambience and SFX catalogs, the scene JSON schema, and music transition rules.

const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10], LYDIAN = [0, 2, 4, 6, 7, 9, 11];

/**
 * The model picks a mood and an intensity; the composer turns the preset into a piece.
 * lead plays the melody (pads/bass only hold harmony), support accompanies, the second support joins at high intensity.
 * bpm is a range: each composed piece picks a tempo inside it, near the previous tempo.
 * family groups moods close enough that a switch between them only reshapes the current piece.
 */
// Quiet acoustic-only palette: bowed strings, cello, harp, piano, and soft mallet percussion.
// Even tense scenes keep a gentle timbre; intensity comes from harmony, rhythm and dynamics.
export const MOODS = {
  calm:      { family: "warm",   lead: "piano",   support: ["strings", "harp"],    bpm: [58, 78],  scale: MAJOR,    style: "arp",      register: 69, room: 0.45 },
  hope:      { family: "warm",   lead: "harp",    support: ["strings", "piano"],   bpm: [75, 100], scale: MAJOR,    style: "arp",      register: 72, room: 0.45 },
  romance:   { family: "warm",   lead: "cello",   support: ["piano", "strings"], bpm: [56, 78],  scale: MAJOR,    style: "broken",   register: 67, room: 0.55 },
  comedy:    { family: "bright", lead: "marimba", support: ["harp", "strings"],  bpm: [92, 120], scale: MAJOR,    style: "bounce",   register: 73, room: 0.30 },
  adventure: { family: "bright", lead: "harp",    support: ["strings", "marimba"],bpm: [83, 112], scale: MAJOR,    style: "broken",   register: 71, room: 0.45 },
  growth:    { family: "bright", lead: "strings", support: ["piano", "harp"],   bpm: [75, 102], scale: MAJOR,    style: "broken",   register: 67, room: 0.50 },
  epic:      { family: "grand",  lead: "strings", support: ["cello", "harp"],    bpm: [70, 104], scale: MINOR,    style: "sustain",  register: 66, room: 0.65 },
  sad:       { family: "sorrow", lead: "cello",   support: ["piano", "strings"], bpm: [48, 68],  scale: MINOR,    style: "sustain",  register: 62, room: 0.55 },
  tragic:    { family: "sorrow", lead: "cello",   support: ["strings", "piano"], bpm: [48, 72],  scale: MINOR,    style: "sustain",  register: 60, room: 0.65 },
  dark:      { family: "sorrow", lead: "cello",   support: ["strings", "harp"],  bpm: [48, 72],  scale: MINOR,    style: "sparse",   register: 57, room: 0.65 },
  tension:   { family: "fear",   lead: "marimba", support: ["cello", "strings"], bpm: [66, 94],  scale: PHRYGIAN,style: "pulse",    register: 62, room: 0.48 },
  horror:    { family: "fear",   lead: "cello",   support: ["strings", "marimba"],bpm: [50, 80],  scale: PHRYGIAN,style: "sparse",   register: 55, room: 0.65 },
  mystery:   { family: "fear",   lead: "harp",    support: ["cello", "marimba"], bpm: [56, 83],  scale: DORIAN,   style: "sparse",   register: 64, room: 0.50 },
  battle:    { family: "fight",  lead: "strings", support: ["cello", "marimba"], bpm: [98, 126], scale: MINOR,    style: "drive",    register: 64, room: 0.45 },
  anger:     { family: "fight",  lead: "cello",   support: ["strings", "marimba"],bpm: [85, 112], scale: PHRYGIAN,style: "drive",    register: 60, room: 0.45 },
  mystic:    { family: "wonder", lead: "harp",    support: ["marimba", "strings"],bpm: [52, 80],  scale: LYDIAN,   style: "arp",      register: 74, room: 0.65 },
};
export const MUSIC_ACTIONS = ["keep", "change", "pause", "resume"];
export const ACTIONS = ["continue", "change", "silence", "non_story"];

/** Shortest time a piece plays before another mood may replace it; same-family moods wait longer. */
export const MUSIC_HOLD_S = 6, FAMILY_HOLD_S = 10;
/** Moods that may cut in before the hold expires: a sudden attack should not wait. */
const URGENT = new Set(["battle", "horror"]);

/**
 * Whether a proposed mood replaces the playing piece. Below the hold time, or for a nearby mood, the current piece
 * only follows the new intensity. `heldS` is how long the current mood has played.
 */
export function musicHoldSeconds(playing, next) {
  return MOODS[next.mood].family === MOODS[playing.mood].family ? FAMILY_HOLD_S : MUSIC_HOLD_S;
}
export function shouldChangeMusic(playing, next, heldS) {
  if (!playing) return true;
  if (next.music_action !== "change" || next.mood === playing.mood) return false;
  if (URGENT.has(next.mood) && !URGENT.has(playing.mood)) return true;
  return heldS >= musicHoldSeconds(playing, next);
}

export const AMBIENCE = {
  aero: { p: ["wind_speed", "howling", "gust_rate"], variants: ["breeze", "wind", "blizzard"] },
  water: { p: ["intensity", "movement", "depth"], variants: ["waves", "stream", "underwater", "waterfall"] },
  particle: { p: ["density", "drop_size", "-"], variants: ["glass", "soil", "metal", "leaf"] },
  bio: { p: ["pitch", "chirp_rate", "distance"], variants: ["songbird", "cricket", "owl", "seagull", "crow", "wolf", "cicada"] },
  urban: { p: ["density", "activity", "distance"], variants: ["cafe", "traffic", "cabin", "kitchen", "crowd", "clockwork"] },
  psycho: { p: ["heartbeat_bpm", "tinnitus", "-"], variants: [] },
  // v2 settings. Fire moved out of `particle` so it can sound under rain.
  fire: { p: ["size", "pops", "distance"], variants: [] },
  storm: { p: ["frequency", "loudness", "distance"], variants: ["distant", "close"] },
  hooves: { p: ["pace", "hard_ground", "distance"], variants: ["trot", "carriage"] },
  tavern: { p: ["crowd", "liveliness", "distance"], variants: [] },
  cave: { p: ["drips", "drop_size", "distance"], variants: [] },
  ship: { p: ["sea_roughness", "creak_level", "distance"], variants: [] },
  room: { p: ["level", "-", "-"], variants: [] },
};
/** Most layers a scene can hold at once. */
export const MAX_AMBIENCE = 4;
/** One slot per generator, except animals: birds and crickets can sing together. */
export const ambienceSlot = (a) => (a.engine === "bio" ? `bio.${a.variant ?? ""}` : a.engine);
/** Older names that still arrive from cached decisions or the model. */
const AMBIENCE_ALIASES = { "particle.wood": { engine: "fire" } };
export const unalias = (a) => (a && AMBIENCE_ALIASES[`${a.engine}.${a.variant}`] ? { ...a, ...AMBIENCE_ALIASES[`${a.engine}.${a.variant}`], variant: undefined } : a);
// One-shots fired when the reader reaches paragraph `p`. p1 = strength.
export const SFX = [
  "door_creak", "door_slam", "footsteps", "clock_ticks", "knock",
  "impact_wood", "impact_metal", "glass_shatter", "sub_drop", "sudden_silence",
  "chopping", "sizzle", "glass_clink", "phone_ring", "camera_shutter", "keyboard",
  "sword_clash", "arrow_shot", "magic_blast", "slap_punch", "whoosh",
  "gunshot", "explosion", "collapse", "car_crash", "tire_screech", "siren",
  "thunder", "water_splash", "crow_caw", "dog_bark", "gasp", "heartbeat_thump",
  "airplane", "car_horn", "train_horn", "bell", "page_turn", "crowd_cheer",
  "scream", "evil_laugh", "sigh", "chain_rattle", "body_fall", "blade_draw", "flame_burst", "low_rumble",
];

const VARIANTS = [...new Set(Object.values(AMBIENCE).flatMap((a) => a.variants))];
const unit = { type: "number", minimum: 0, maximum: 1 };


/** JSON Schema for Prompt API responseConstraint. */
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "music_action", "mood", "intensity", "ambience", "sfx", "reason", "context_summary"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    music_action: { type: "string", enum: MUSIC_ACTIONS },
    mood: { type: "string", enum: Object.keys(MOODS) },
    intensity: unit,
    ambience: {
      type: "array",
      maxItems: MAX_AMBIENCE,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["engine", "p1", "p2", "p3"],
        properties: {
          engine: { type: "string", enum: Object.keys(AMBIENCE) },
          variant: { type: "string" },
          p1: unit,
          p2: unit,
          p3: unit,
          indoor: { type: "boolean" },
        },
      },
    },
    sfx: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["p", "type", "p1"],
        properties: { p: { type: "integer" }, type: { type: "string", enum: SFX }, p1: unit },
      },
    },
    reason: { type: "string", maxLength: 60 },
    context_summary: { type: "string", maxLength: 160 },
  },
};

export const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** A decision with every field present and in range. Room comes from the mood; the composer owns tempo and instruments. */
export function normalizeSegment(s) {
  const mood = pick(s.mood, Object.keys(MOODS), "calm");
  const seen = new Set();
  const ambience = (Array.isArray(s.ambience) ? s.ambience : [])
    .map(unalias)
    .filter((a) => AMBIENCE[a?.engine])
    .map((a) => {
      const vs = AMBIENCE[a.engine].variants;
      return {
        engine: a.engine,
        ...(vs.length ? { variant: pick(a.variant, vs, vs[0]) } : {}),
        p1: clamp(a.p1, 0, 1, 0.5),
        p2: clamp(a.p2, 0, 1, 0.5),
        p3: clamp(a.p3, 0, 1, 0.5),
        ...(a.indoor === true ? { indoor: true } : {}),
      };
    })
    .filter((a) => !seen.has(ambienceSlot(a)) && seen.add(ambienceSlot(a)))
    .slice(0, MAX_AMBIENCE);
  const sfx = (Array.isArray(s.sfx) ? s.sfx : [])
    .filter((x) => SFX.includes(x?.type) && Number.isInteger(x.p))
    .slice(0, 1)
    .map((x) => ({ p: x.p, type: x.type, p1: clamp(x.p1, 0, 1, 0.7) }));
  return {
    action: pick(s.action, ACTIONS, "change"),
    music_action: pick(s.music_action, MUSIC_ACTIONS, s.action === "continue" ? "keep" : "change"),
    start_p: s.start_p | 0,
    end_p: s.end_p | 0,
    mood,
    intensity: clamp(s.intensity, 0, 1, 0.5),
    muffle: clamp(s.muffle, 0, 1, 0),
    room: clamp(s.room, 0, 1, MOODS[mood].room),
    ambience,
    sfx: ["non_story", "silence"].includes(s.action) ? [] : sfx,
  };
}

const ambKey = (a) => a.engine + (a.variant ? `.${a.variant}` : "") + (a.indoor ? "@in" : "");
/** True when the ambience layers or their levels differ enough to be worth a crossfade. */
export function ambienceChanged(a, b) {
  if (a.map(ambKey).sort().join("+") !== b.map(ambKey).sort().join("+")) return true;
  return b.some((x) => { const y = a.find((p) => ambKey(p) === ambKey(x)); return ["p1", "p2", "p3"].some((k) => Math.abs(x[k] - y[k]) >= 0.2); });
}

/** Minimum gap between sound effects, in seconds. */
export const SFX_GAP_S = 8;
