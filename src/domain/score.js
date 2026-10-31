// Scene schema, mood presets, transition rules, OCR line filtering.

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
const MUSIC_ACTIONS = ["keep", "change", "pause", "resume"];
const ACTIONS = ["continue", "change", "silence", "non_story"];

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
  particle: { p: ["density", "drop_size", "-"], variants: ["glass", "soil", "metal", "wood", "leaf"] },
  bio: { p: ["pitch", "chirp_rate", "distance"], variants: ["songbird", "cricket", "owl", "seagull", "crow", "wolf", "cicada"] },
  urban: { p: ["density", "activity", "distance"], variants: ["cafe", "traffic", "cabin", "kitchen", "crowd", "clockwork"] },
  psycho: { p: ["heartbeat_bpm", "tinnitus", "-"], variants: [] },
};
// One-shots fired when the reader reaches paragraph `p`. p1 = strength.
export const SFX = [
  "door_creak", "door_slam", "footsteps", "clock_ticks", "knock",
  "impact_wood", "impact_metal", "glass_shatter", "sub_drop", "sudden_silence",
  "chopping", "sizzle", "glass_clink", "coin_drop", "phone_ring", "camera_shutter", "keyboard",
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
      maxItems: 2,
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

const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** A decision with every field present and in range. Room comes from the mood; the composer owns tempo and instruments. */
export function normalizeSegment(s) {
  const mood = pick(s.mood, Object.keys(MOODS), "calm");
  const seen = new Set();
  const ambience = (Array.isArray(s.ambience) ? s.ambience : [])
    .filter((a) => AMBIENCE[a?.engine] && !seen.has(a.engine) && seen.add(a.engine))
    .slice(0, 2)
    .map((a) => {
      const vs = AMBIENCE[a.engine].variants;
      return {
        engine: a.engine,
        ...(vs.length ? { variant: pick(a.variant, vs, vs[0]) } : {}),
        p1: clamp(a.p1, 0, 1, 0.5),
        p2: clamp(a.p2, 0, 1, 0.5),
        p3: clamp(a.p3, 0, 1, 0.5),
      };
    });
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

const ambKey = (a) => a.engine + (a.variant ? `.${a.variant}` : "");
/** True when the ambience layers or their levels differ enough to be worth a crossfade. */
export function ambienceChanged(a, b) {
  if (a.map(ambKey).sort().join("+") !== b.map(ambKey).sort().join("+")) return true;
  return b.some((x) => { const y = a.find((p) => ambKey(p) === ambKey(x)); return ["p1", "p2", "p3"].some((k) => Math.abs(x[k] - y[k]) >= 0.2); });
}

/** FNV-1a, for cache keys. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function splitTwoPageSpread(ok, lh, width = 0) {
  if (ok.length < 2) return [ok];
  const minX = Math.min(...ok.map((l) => l.bbox.x0 ?? 0));
  const maxX = Math.max(...ok.map((l) => l.bbox.x1 ?? 0));
  const spanW = maxX - minX;
  if (spanW < Math.max(160, lh * 8)) return [ok];
  const center = width > 0 && width * 0.5 > minX + spanW * 0.25 && width * 0.5 < maxX - spanW * 0.25
    ? width * 0.5
    : (minX + maxX) * 0.5;
  const tol = lh * 1.2;
  const leftPure = ok.filter((l) => (l.bbox.x1 ?? 0) <= center + tol);
  const rightPure = ok.filter((l) => (l.bbox.x0 ?? 0) >= center - tol);
  const spanning = ok.filter((l) => (l.bbox.x0 ?? 0) < center - tol && (l.bbox.x1 ?? 0) > center + tol);
  if (!leftPure.length || !rightPure.length || spanning.length > Math.floor(ok.length * 0.1)) return [ok];
  const leftMaxX = Math.max(...leftPure.map((l) => l.bbox.x1 ?? 0));
  const rightMinX = Math.min(...rightPure.map((l) => l.bbox.x0 ?? 0));
  if (rightMinX - leftMaxX < Math.max(12, lh * 0.6)) return [ok];
  const leftMinY = Math.min(...leftPure.map((l) => l.bbox.y0 ?? 0));
  const leftMaxY = Math.max(...leftPure.map((l) => l.bbox.y1 ?? 0));
  const rightMinY = Math.min(...rightPure.map((l) => l.bbox.y0 ?? 0));
  const rightMaxY = Math.max(...rightPure.map((l) => l.bbox.y1 ?? 0));
  const yOverlap = Math.min(leftMaxY, rightMaxY) > Math.max(leftMinY, rightMinY) - lh * 2;
  if (!yOverlap && (leftPure.length < 2 || rightPure.length < 2)) return [ok];
  const gutterMid = (leftMaxX + rightMinX) * 0.5;
  const leftCol = [];
  const rightCol = [];
  for (const l of ok) {
    const cx = ((l.bbox.x0 ?? 0) + (l.bbox.x1 ?? 0)) * 0.5;
    if (cx < gutterMid) leftCol.push(l);
    else rightCol.push(l);
  }
  return leftCol.length && rightCol.length ? [leftCol, rightCol] : [ok];
}

function columnToParagraphs(colLines, height, lh, yOffset = 0) {
  const sorted = [...colLines].sort((a, b) => a.bbox.y0 - b.bbox.y0 || (a.bbox.x0 ?? 0) - (b.bbox.x0 ?? 0));
  if (!sorted.length) return [];
  const gaps = sorted.slice(1).map((l, i) => l.bbox.y0 - sorted[i].bbox.y1);
  const tight = gaps.length ? Math.min(...gaps.filter((g) => g > 0), Infinity) : lh;
  const right = Math.max(...sorted.map((l) => l.bbox.x1 ?? 0));
  const left = Math.min(...sorted.map((l) => l.bbox.x0 ?? 0));
  const groups = [];
  sorted.forEach((l, i) => {
    const prev = sorted[i - 1];
    const split =
      !prev ||
      l.bbox.y0 - prev.bbox.y1 > Math.max(tight * 1.5, lh * 0.5) ||
      (prev.bbox.x1 ?? right) < right - lh * 2 ||
      (l.bbox.x0 ?? left) > left + lh * 0.6;
    if (split) groups.push({ lines: [], y0: l.bbox.y0, y1: l.bbox.y1 });
    const gr = groups.at(-1);
    gr.lines.push(l.text.trim());
    gr.y1 = l.bbox.y1;
  });
  const margin = Math.max(6, lh * 0.6);
  return groups
    .filter((gr, i) => groups.length === 1 || (!(i === 0 && gr.y0 < margin) && !(i === groups.length - 1 && gr.y1 > height - margin)))
    .map((gr) => ({ text: gr.lines.join(" ").replace(/\s+/g, " ").trim(), y0: gr.y0 + yOffset }))
    .filter((p) => p.text.length >= 4);
}

/**
 * Tesseract often lumps a whole screen of evenly spaced prose into one "paragraph" that touches both edges, so
 * paragraphs are rebuilt from lines. On a two-page spread (left page + right page side-by-side), lines are partitioned
 * across the central gutter so the left page is read top-to-bottom first, followed by the right page top-to-bottom.
 * Pure: lines are [{text, bbox: {x0, y0, x1, y1}, confidence}].
 */
export function linesToParagraphs(lines, height, width = 0) {
  const ok = lines.filter((l) => (l.confidence ?? 100) >= 30 && (l.text ?? "").trim().length >= 2);
  if (!ok.length) return [];
  const mid = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const lh = Math.max(8, mid(ok.map((l) => (l.bbox.y1 ?? 0) - (l.bbox.y0 ?? 0))));
  const columns = splitTwoPageSpread(ok, lh, width);
  return columns.flatMap((col, idx) => columnToParagraphs(col, height, lh, idx * Math.max(height || 0, 1000)));
}

/** First-stage OCR filter. Narrative without UI markers is left to the model's non_story decision. */
export function filterOcrLines(lines) {
  const kept = [];
  let cutoff = null, removed = 0;
  for (const line of [...lines].sort((a,b) => a.bbox.y0-b.bbox.y0)) {
    const t = (line.text ?? "").trim();
    if (/^(?:베스트\s*댓글|전체\s*댓글|댓글|BEST\s*(?:댓글|COMMENTS?)|COMMENTS?)(?:\s*[\d,]+|\s*\([\d,]+\))?\s*$/i.test(t)) { cutoff=line.bbox.y0; break; }
    const metadata = /^(?:\d{4}[.\/-]\s*\d{1,2}[.\/-]\s*\d{1,2}.*|\d+\s*(?:초|분|시간|일|주|개월|년)\s*전|(?:좋아요|답글|추천|신고)\s*\d*|[♡♥👍]\s*\d+)\s*$/.test(t);
    const ui = /^(?:이전|다음|목록|메뉴|설정|공유|로그인|등록|최신순|인기순|\d+\s*\/\s*\d+|[-–—]?\s*\d{1,4}\s*(?:p|쪽|페이지)?\s*[-–—]?|[←→]\s*(?:이전|다음)|(?:이전|다음)\s*[←→])$/i.test(t);
    if (metadata || ui || t.replace(/\s/g, "").length < 3) { removed++; continue; }
    kept.push(line);
  }
  return { lines: kept, cutoff, removed };
}

/** Minimum gap between sound effects, in seconds. */
export const SFX_GAP_S = 8;

/** Safe metadata shared by a screen's decision. */
export function decisionMeta(raw) {
  return {
    context_summary: typeof raw?.context_summary === "string" ? raw.context_summary.slice(0, 160) : "",
    reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 60) : "",
    sfx_interval_s: SFX_GAP_S,
  };
}

/** One screen, one decision. Keep/pause/resume inherit the playing music; paragraph bounds belong to the caller. */
export function screenDecision(raw, from, to, prev) {
  if (!raw || typeof raw !== "object" || !ACTIONS.includes(raw.action) || !MUSIC_ACTIONS.includes(raw.music_action)) throw new Error("모델 응답에 올바른 action/music_action이 없습니다");
  const first = !prev && raw.music_action !== "pause" && !!MOODS[raw.mood];
  const music_action = first || (raw.music_action === "keep" && prev && MOODS[raw.mood] && raw.mood !== prev.mood) ? "change" : raw.music_action;
  if (music_action === "change" && !MOODS[raw.mood]) throw new Error("음악 변경 응답에 mood가 없습니다");
  const inherited = music_action === "change" || !prev ? {} : { mood: prev.mood, intensity: raw.intensity ?? prev.intensity };
  return { ...normalizeSegment({ ...raw, ...inherited, music_action, start_p: from, end_p: to }), ...decisionMeta(raw) };
}

/** Combine overlapping OCR fragments without repeating their shared text. Null means unrelated paragraphs. */
export function mergeOcrText(a, b) {
  const x=a.replace(/\s/g,""), y=b.replace(/\s/g,"");
  if (!x) return b;
  if (!y) return a;
  if (x.includes(y)) return a;
  if (y.includes(x)) return b;
  const join=(left,right,l,r)=>{
    for (let n=Math.min(l.length,r.length);n>=8;n--) {
      if (!l.endsWith(r.slice(0,n))) continue;
      let count=0, at=0;
      while (at<right.length && count<n) { if (!/\s/.test(right[at])) count++; at++; }
      return `${left.trimEnd()} ${right.slice(at).trimStart()}`.trim();
    }
    return null;
  };
  return join(a,b,x,y) ?? join(b,a,y,x) ?? (x.slice(0,12)===y.slice(0,12) && x.length>=12 ? (x.length>=y.length ? a : b) : null);
}

/** Last path component changes are episode turns; a different work/origin ends the reader session. */
export function navigationKind(before, after) {
  try {
    const a=new URL(before), b=new URL(after);
    if (a.origin!==b.origin) return "leave";
    if (a.pathname===b.pathname) return "same";
    const x=a.pathname.split("/").filter(Boolean), y=b.pathname.split("/").filter(Boolean);
    return x.length>=2 && x.length===y.length && x.slice(0,-1).every((v,i)=>v===y[i]) ? "episode" : "leave";
  } catch { return "leave"; }
}

/** Parse only finished top-level JSON values; incomplete streaming strings/arrays are never applied. */
export function completeJsonFields(source) {
  const out=Object.create(null);
  let i=source.indexOf("{");
  if (i<0) return out;
  i++;
  const quoted=start=>{
    let escaped=false;
    for (let j=start+1;j<source.length;j++) {
      const c=source[j];
      if (escaped) {escaped=false;continue;}
      if (c === "\\") escaped=true;
      else if (c === '"') return j+1;
    }
    return -1;
  };
  while (i<source.length) {
    while (/[\s,]/.test(source[i] ?? "") && i<source.length) i++;
    if (source[i] !== '"') break;
    const keyEnd=quoted(i);
    if (keyEnd<0) break;
    const key=JSON.parse(source.slice(i,keyEnd));
    i=keyEnd;
    while (/\s/.test(source[i] ?? "") && i<source.length) i++;
    if (source[i++] !== ":") break;
    while (/\s/.test(source[i] ?? "") && i<source.length) i++;
    const start=i;
    let end=-1;
    if (source[i] === '"') end=quoted(i);
    else if (source[i] === "[" || source[i] === "{") {
      let depth=0;
      for (let j=i;j<source.length;j++) {
        if (source[j] === '"') {const q=quoted(j); if(q<0) break; j=q-1;continue;}
        if (source[j] === "[" || source[j] === "{") depth++;
        if (source[j] === "]" || source[j] === "}") {if(--depth===0){end=j+1;break;}}
      }
    } else {
      let j=i; while(j<source.length && !/[,}]/.test(source[j])) j++;
      if(j<source.length) end=j;
    }
    if(end<0) break;
    try {out[key]=JSON.parse(source.slice(start,end));} catch {break;}
    i=end;
  }
  return out;
}

const AMBIENCE_RULES = [
  { engine: "psycho", variant: undefined, p1: 0.68, p2: 0.45, p3: 0, re: /heart\s*(?:beat|pound|thump)|(?:heart|pulse).{0,25}(?:pound|throb|racing|beat|quicken)|ears?.{0,12}(?:rang|ring)|ringing.{0,20}ears|tinnitus|심장.{0,15}(?:뛰|두근|소리|쿵쾅|터질|조여)|맥박|고동|이명|귓.{0,12}(?:삐|울림|먹먹)|숨이\s*(?:막히|가빠|턱)|식은땀|\b(?:cold\s*sweat|suffocating\s*dread|blood\s*pounding)\b/i },
  { engine: "aero", variant: "blizzard", p1: 0.8, p2: 0.75, p3: 0.7, re: /눈보라|폭풍설|매서운\s*눈|눈발이\s*휘몰아|설원|혹한|얼어붙은\s*바람|\b(?:blizzard|snowstorm|howling\s*snow|frozen\s*wasteland)\b/i },
  { engine: "aero", variant: "wind", p1: 0.65, p2: 0.55, p3: 0.5, re: /바람\s*소리|거센\s*바람|강풍|칼바람|찬바람|밤바람|돌풍|바람이\s*(?:불|휘몰아|울부짖|세차)|절벽|옥상|황야|폐허|던전|동굴\s*안|심연|\b(?:strong\s*wind|howling\s*wind|fierce\s*wind|wind\s*howled|wind\s*blew|cold\s*wind|night\s*wind|cliff|rooftop|wasteland|ruins|dungeon|cave)\b/i },
  { engine: "aero", variant: "breeze", p1: 0.45, p2: 0.28, p3: 0.35, re: /산들바람|미풍|선선한\s*바람|부드러운\s*바람|바람이\s*스치|정원|들판|언덕|테라스|발코니|창가으로\s*바람|\b(?:gentle\s*breeze|soft\s*breeze|cool\s*breeze|breeze\s*blew|meadow|terrace|balcony)\b/i },
  { engine: "water", variant: "waterfall", p1: 0.75, p2: 0.7, p3: 0.6, re: /폭포|쏟아지는\s*물줄기|급류|\b(?:waterfall|cascading\s*water|rapids)\b/i },
  { engine: "water", variant: "underwater", p1: 0.6, p2: 0.4, p3: 0.85, re: /물속|수중|심해|깊은\s*물\s*아래|가라앉으며|\b(?:underwater|submerged|deep\s*beneath\s*the\s*water)\b/i },
  { engine: "water", variant: "stream", p1: 0.52, p2: 0.55, p3: 0.35, re: /시냇물|계곡|강물|강가|졸졸\s*흐르|개울|호수|연못|분수|물방울이?\s*떨어|하수구|\b(?:flowing\s*stream|babbling\s*brook|creek|river|lakeside|fountain|dripping\s*water|sewer)\b/i },
  { engine: "water", variant: "waves", p1: 0.6, p2: 0.5, p3: 0.5, re: /파도|철썩|바닷가|해변|해안|바다|항구|부두|갑판|배\s*위|\b(?:ocean\s*waves|waves?\s*crashed|waves?\s*lapped|seashore|beach|harbor|ship\s*deck)\b/i },
  { engine: "particle", variant: "wood", p1: 0.58, p2: 0.52, p3: 0, re: /장작|모닥불|벽난로|불꽃이?\s*타|타닥타닥|화로|횃불|불길|화염이?\s*타오르|\b(?:campfire|fireplace|crackling\s*fire|burning\s*logs|torch|flames?\s*crackled|blaze)\b/i },
  { engine: "particle", variant: "leaf", p1: 0.48, p2: 0.42, p3: 0, re: /낙엽|나뭇잎|수풀|풀숲|덤불|숲속|우거진\s*나무|산길|\b(?:rustling\s*leaves|dry\s*leaves|bushes|thick\s*forest|woods)\b/i },
  { engine: "particle", variant: "glass", p1: 0.52, p2: 0.48, p3: 0, re: /창문.{0,12}비|창가.{0,12}빗|유리창.{0,12}빗|\b(?:rain\s*against\s*the\s*window|raindrops?\s*on\s*the\s*glass)\b/i },
  { engine: "particle", variant: "soil", p1: 0.58, p2: 0.52, p3: 0, re: /비가\s*내리|빗소리|빗방울|빗줄기|장대비|소나기|폭우|우산|빗물|젖은\s*거리|먹구름|\b(?:rain\s*fell|raining|downpour|drizzle|sound\s*of\s*rain|rainstorm|wet\s*pavement)\b/i },
  { engine: "bio", variant: "crow", p1: 0.58, p2: 0.48, p3: 0.4, re: /까마귀|까악|시체더미|황량한\s*전장|공동묘지|\b(?:crows?\s*caw|ravens?|graveyard|corpse-strewn)\b/i },
  { engine: "bio", variant: "wolf", p1: 0.62, p2: 0.45, p3: 0.5, re: /늑대|하울링|들개|짐승의?\s*울음|마수의?\s*울음|\b(?:wolf\s*howl|wolves\s*howling|beast\s*howled)\b/i },
  { engine: "bio", variant: "cicada", p1: 0.55, p2: 0.6, p3: 0.3, re: /매미|맴맴|한여름\s*낮|\b(?:cicadas?\s*buzz|cicadas?\s*chirp)\b/i },
  { engine: "bio", variant: "owl", p1: 0.5, p2: 0.38, p3: 0.5, re: /부엉이|올빼미|자정|깊은\s*밤\s*숲|\b(?:owl\s*hooted|night\s*owl|dead\s*of\s*night)\b/i },
  { engine: "bio", variant: "seagull", p1: 0.5, p2: 0.45, p3: 0.4, re: /갈매기|바닷새|\b(?:seagulls?\s*cried|gulls?\s*overhead)\b/i },
  { engine: "bio", variant: "cricket", p1: 0.46, p2: 0.5, p3: 0.3, re: /풀벌레|귀뚜라미|밤벌레|고요한\s*밤하늘|별빛\s*아래|\b(?:crickets?\s*chirp|night\s*insects|quiet\s*night\s*sky)\b/i },
  { engine: "bio", variant: "songbird", p1: 0.46, p2: 0.5, p3: 0.3, re: /새소리|새가\s*지저귀|산새|참새|아침\s*햇살|\b(?:birds?\s*chirp|birdsong|singing\s*birds|morning\s*sunlight)\b/i },
  { engine: "urban", variant: "kitchen", p1: 0.5, p2: 0.55, p3: 0.3, re: /주방|부엌|요리하는|냄비가\s*끓|식탁\s*위|\b(?:in\s*the\s*kitchen|kitchen\s*clatter|dining\s*table)\b/i },
  { engine: "urban", variant: "cafe", p1: 0.48, p2: 0.48, p3: 0.35, re: /카페|커피숍|찻집|선술집|주점|객잔|여관\s*1층|레스토랑|식당\s*안|\b(?:cafe|coffee\s*shop|tavern|inn|pub|restaurant)\b/i },
  { engine: "urban", variant: "traffic", p1: 0.55, p2: 0.5, p3: 0.4, re: /도로|차도|오가는\s*차|거리의\s*소음|교차로|빌딩\s*숲|도심|아스팔트|골목길|\b(?:street\s*traffic|passing\s*cars|city\s*traffic|busy\s*road|downtown|city\s*street|alleyway)\b/i },
  { engine: "urban", variant: "cabin", p1: 0.5, p2: 0.42, p3: 0.3, re: /기차\s*안|열차|비행기\s*기내|차\s*안|마차\s*안|선실|객실|\b(?:train\s*cabin|inside\s*the\s*train|airplane\s*cabin|inside\s*the\s*(?:car|carriage))\b/i },
  { engine: "urban", variant: "crowd", p1: 0.56, p2: 0.56, p3: 0.4, re: /군중|인파|시장|광장|웅성거리는|시끌벅적|연회장|무도회장|경기장|관중석|길드\s*홀|로비|복도|교실|\b(?:noisy\s*crowd|bustling\s*market|crowded\s*hall|murmur\s*of\s*the\s*crowd|banquet\s*hall|arena|stadium|guild\s*hall|corridor)\b/i },
  { engine: "urban", variant: "clockwork", p1: 0.48, p2: 0.5, p3: 0.3, re: /시계탑|태엽|톱니바퀴|기계실|연구실|실험실|공장|\b(?:clock\s*tower|ticking\s*gears|clockwork|laboratory|machinery)\b/i },
];

const AMBIENCE_END_RE = /그쳤|멈췄|사라졌|조용해졌|잦아들|안으로\s*들어|실내로\s*들어|방을\s*나와|건물\s*안으로|다음\s*날|이튿날|며칠\s*뒤|\b(?:stopped\s*raining|wind\s*died|fell\s*silent|stepped\s*indoors|went\s*inside|the\s*next\s*day)\b/i;

/**
 * Grounds ambience in scene descriptions and model context:
 * 1. Starts/keeps a layer when matched in text OR proposed by the model (except `psycho`, which requires explicit body-sound cues).
 * 2. Allows an active layer to continue while `action === "continue"` in the same ongoing situation without an ending cue.
 * 3. Clears ambience (`[]`) when `AMBIENCE_END_RE` triggers or when the scene changes without new environmental cues.
 */
export function groundAmbience(ambience, text, prevAmbience = [], action = "change") {
  const list = Array.isArray(ambience) ? ambience : [];
  const prevList = Array.isArray(prevAmbience) ? prevAmbience : [];
  const ended = AMBIENCE_END_RE.test(text);
  const matchedByEngine = new Map();
  if (!ended) {
    for (const rule of AMBIENCE_RULES) {
      if (!matchedByEngine.has(rule.engine) && rule.re.test(text)) {
        matchedByEngine.set(rule.engine, rule);
      }
    }
  }
  const canContinuePrev = action === "continue" && !ended;
  const prevEngines = new Set(prevList.map((a) => a?.engine).filter(Boolean));
  const guards = [];
  const kept = [];
  const seen = new Set();

  for (const item of list) {
    if (!item?.engine || !AMBIENCE[item.engine] || seen.has(item.engine)) continue;
    const matched = matchedByEngine.get(item.engine);
    if (matched) {
      seen.add(item.engine);
      kept.push({
        engine: item.engine,
        ...(matched.variant ? { variant: item.variant && AMBIENCE[item.engine]?.variants.includes(item.variant) ? item.variant : matched.variant } : {}),
        p1: clamp(item.p1, 0.3, 0.9, matched.p1),
        p2: clamp(item.p2, 0.25, 0.9, matched.p2),
        p3: clamp(item.p3, 0, 0.9, matched.p3),
      });
    } else if (item.engine === "psycho") {
      guards.push("psycho 제외");
    } else if (!ended && (canContinuePrev && prevEngines.has(item.engine))) {
      seen.add(item.engine);
      kept.push(item);
    } else if (!ended && item.variant && AMBIENCE[item.engine]?.variants.includes(item.variant) && text.trim().length >= 35) {
      seen.add(item.engine);
      kept.push({
        engine: item.engine,
        variant: item.variant,
        p1: clamp(item.p1, 0.3, 0.85, 0.5),
        p2: clamp(item.p2, 0.25, 0.85, 0.45),
        p3: clamp(item.p3, 0, 0.85, 0.35),
      });
    } else {
      guards.push(`${item.engine} 제외`);
    }
  }

  // If the text explicitly describes an environment that the model missed, add it automatically.
  for (const [engine, rule] of matchedByEngine) {
    if (kept.length >= 2) break;
    if (seen.has(engine)) continue;
    seen.add(engine);
    kept.push({
      engine,
      ...(rule.variant ? { variant: rule.variant } : {}),
      p1: rule.p1,
      p2: rule.p2,
      p3: rule.p3,
    });
  }

  return { ambience: kept.slice(0, 2), guards };
}

const SFX_ALIASES = {
  crash: "car_crash", accident: "car_crash", car_accident: "car_crash", collision: "car_crash",
  brake: "tire_screech", screech: "tire_screech", skid: "tire_screech",
  shatter: "glass_shatter", glass_break: "glass_shatter", broken_glass: "glass_shatter",
  slam: "door_slam", door_close: "door_slam", creak: "door_creak",
  sword: "sword_clash", blade: "sword_clash", blades: "sword_clash", slash: "sword_clash",
  draw: "blade_draw", unsheathe: "blade_draw", sheath: "blade_draw",
  gun: "gunshot", shot: "gunshot", rifle: "gunshot",
  crow: "crow_caw", caw: "crow_caw", bark: "dog_bark", dog: "dog_bark",
  punch: "slap_punch", slap: "slap_punch", hit: "slap_punch", kick: "slap_punch",
  ring: "phone_ring", phone: "phone_ring", horn: "car_horn",
  heartbeat: "heartbeat_thump", pulse: "heartbeat_thump", splash: "water_splash",
  cheer: "crowd_cheer", cheering: "crowd_cheer", applause: "crowd_cheer", roar: "crowd_cheer",
  shriek: "scream", cry: "scream", yell: "scream", scream: "scream",
  laugh: "evil_laugh", chuckle: "evil_laugh", sneer: "evil_laugh",
  sigh: "sigh", exhale: "sigh", breath: "gasp",
  chain: "chain_rattle", chains: "chain_rattle", shackle: "chain_rattle",
  fall: "body_fall", thud: "body_fall", drop: "body_fall",
  fire: "flame_burst", flame: "flame_burst", burn: "flame_burst",
  rumble: "low_rumble", tremor: "low_rumble", quake: "low_rumble",
  step: "footsteps", walk: "footsteps", run: "footsteps",
};

const SFX_TEXT_RULES = [
  ["scream", 0.92, /(?:으+아+악*|꺄+아+악*|크+아+악*|끼+야+악*|까+아+악*|아+아+악+)|(?:으악|꺄악|크악|끼약|까악)(?:!|\s|$)|비명을?\s*(?:지르|질렀|내지르|내질렀|터뜨리|터뜨렸|토해)|비명이?\s*(?:터져|터졌|울려|울렸|메아리)|절규(?:했|하며|가\s*터|를\s*토)|단말마|비명\s*소리|악을\s*쓰며\s*(?:외치|소리)|외마디\s*(?:비명|소리)|목이\s*터져라\s*(?:소리|외치)|\b(?:scream(?:ed|ing|s)?|shriek(?:ed|ing|s)?|let\s*out\s*a\s*(?:shriek|scream|cry)|piercing\s*scream|howl(?:ed)?\s*in\s*(?:pain|agony|terror)|aa+r*gh|kya+h*)\b/i],
  ["glass_shatter", 0.95, /유리(?:창|잔|병|문|컵|파편|조각)?이?\s*(?:박살|산산조각|깨지|깨져|깨졌|부서|파열|튀)|(?:창문|거울|쇼윈도|수정)이?\s*(?:박살|산산조각|깨지|깨져|깨졌|부서|파열)|유리.{0,10}(?:파열|깨지|박살|산산조각)|파열음과\s*함께.{0,12}(?:유리|창|거울)|와장창|쨍그랑|쨍\s*하고\s*(?:깨|금|부서)|\b(?:glass\s*(?:shatter|broke|break|cracked|burst)|shattered\s*into\s*pieces|window\s*(?:shattered|broke|burst))\b/i],
  ["crowd_cheer", 0.88, /함성이?\s*(?:터져|울려|터졌|쏟아|메아리)|환호성이?\s*(?:터져|울려|터졌|쏟아)|우레와\s*같은\s*(?:박수|함성|환호)|(?:와아+아*|우와+아+)(?:!|\s|하고)|열광적인\s*(?:환호|함성)|박수갈채|\b(?:crowd\s*cheered|erupted\s*in\s*cheers|roar\s*of\s*the\s*crowd|thunderous\s*applause|cheering\s*erupted)\b/i],
  ["car_crash", 0.92, /교통사고|차량.{0,8}충돌|정면.{0,6}충돌|추돌|들이받|차에\s*치이|차가\s*전복|트럭이.{0,15}(?:들이받|덮치|충돌)|\b(?:car\s*crash|traffic\s*accident|collided\s*with|smashed\s*into|head-on\s*collision)\b/i],
  ["tire_screech", 0.88, /급브레이크|타이어.{0,10}(?:비명|마찰|끌리)|끼이익.{0,12}(?:멈추|차|타이어|브레이크)|\b(?:tire\s*screech|screeching\s*halt|slammed\s*on\s*the\s*brakes|tires?\s*skidded)\b/i],
  ["siren", 0.85, /사이렌\s*소리|사이렌이\s*울리|구급차.{0,10}사이렌|경찰차.{0,10}사이렌|\b(?:siren\s*wail|sirens?\s*blar|ambulance\s*siren|police\s*siren)\b/i],
  ["gunshot", 0.92, /총성|총소리|방아쇠를\s*당기|탕\s*하는\s*총|총탄이\s*발사|\b(?:gunshot|fired\s*a\s*shot|pulled\s*the\s*trigger)\b/i],
  ["explosion", 0.92, /폭발음|폭음|폭발했|터져\s*나갔|콰아앙|쾅\s*하고\s*터|대폭발|\b(?:explosion|exploded\s*with\s*a\s*roar|detonated)\b/i],
  ["flame_burst", 0.88, /화염이\s*(?:치솟|폭발|뿜어)|불길이\s*치솟|불꽃이\s*터져|화르륵|불덩이가|\b(?:flames?\s*erupted|burst\s*into\s*flames|fireball\s*blasted|roaring\s*flames)\b/i],
  ["collapse", 0.88, /무너져\s*내리|붕괴되|천장이\s*무너|건물이\s*무너|벽이\s*무너|\b(?:collapsed\s*with\s*a\s*roar|ceiling\s*caved\s*in|walls?\s*crumbled)\b/i],
  ["low_rumble", 0.85, /땅이\s*흔들|지진이|진동이\s*울리|쿠구구궁|우르르\s*울리|살기가\s*진동|마력이\s*소용돌이|\b(?:ground\s*trembled|earth\s*shook|deep\s*rumble|ominous\s*tremor)\b/i],
  ["blade_draw", 0.84, /검을\s*뽑|칼을\s*뽑|발도했|검집에서|스릉|차르륵\s*검|\b(?:drew\s*(?:his|her)\s*sword|unsheathed\s*the\s*blade|steel\s*slid\s*from)\b/i],
  ["sword_clash", 0.88, /검이\s*부딪|칼이\s*맞부딪|칼날이\s*(?:부딪|교차)|검격|칼싸움|챙그랑|검을\s*휘둘러\s*막|캉\s*하고|\b(?:swords?\s*clash|blades?\s*clashed|steel\s*rang|parried\s*the\s*blade)\b/i],
  ["arrow_shot", 0.82, /화살이\s*날아|시위를\s*떠난|활시위|화살을\s*쏘|\b(?:arrow\s*whistled|released\s*the\s*arrow|bowstring\s*twanged)\b/i],
  ["magic_blast", 0.86, /마법이?\s*(?:발동|터져|작렬)|마력이?\s*폭발|주문.{0,8}외우자\s*빛|섬광이\s*터|\b(?:magic\s*blast|spell\s*erupted|mana\s*exploded|arcane\s*burst)\b/i],
  ["slap_punch", 0.85, /뺨을\s*때리|주먹으로\s*치|주먹이\s*꽂히|턱을\s*가격|발로\s*차|걷어차|짝\s*소리와\s*함께\s*뺨|\b(?:slapped\s*(?:his|her)\s*face|punched\s*(?:him|her)|struck\s*(?:his|her)\s*jaw)\b/i],
  ["body_fall", 0.84, /바닥에\s*쓰러|그대로\s*쓰러|무릎을\s*꿇으며\s*쓰러|쿵\s*하고\s*쓰러|바닥에\s*나뒹굴|추락했|\b(?:collapsed\s*to\s*the\s*floor|fell\s*heavily|thudded\s*to\s*the\s*ground|dropped\s*to\s*(?:his|her)\s*knees)\b/i],
  ["whoosh", 0.8, /허공을\s*가르|바람을\s*가르며|휙\s*소리를\s*내며|순식간에\s*몸을\s*날려|\b(?:sliced\s*through\s*the\s*air|whooshed\s*past|lunged\s*forward)\b/i],
  ["chain_rattle", 0.82, /쇠사슬|사슬이\s*짤랑|수갑|족쇄가\s*끌리|철창|\b(?:chains?\s*rattled|shackles?\s*clinked|iron\s*chains)\b/i],
  ["evil_laugh", 0.82, /비웃음을?\s*흘리|광소를?\s*터뜨리|소름\s*끼치는\s*웃음|낮게\s*비웃|낄낄|크크크|\b(?:sinister\s*laugh|laughed\s*maniacally|cold\s*chuckle|mocking\s*laugh)\b/i],
  ["gasp", 0.8, /숨을\s*삼켰|숨을\s*들이켰|헉\s*하고|숨이\s*턱\s*막혔|경악하며\s*숨|\b(?:gasped\s*in\s*shock|sharp\s*intake\s*of\s*breath|caught\s*(?:his|her)\s*breath)\b/i],
  ["sigh", 0.76, /한숨을?\s*(?:내쉬|쉬었|푹)|탄식을?\s*(?:내뱉|흘렸)|후우\s*하고\s*숨|\b(?:let\s*out\s*a\s*(?:deep\s*|heavy\s*)?sigh|sighed\s*deeply)\b/i],
  ["heartbeat_thump", 0.84, /심장이\s*(?:철렁|쿵\s*내려|미친\s*듯이\s*뛰|두근거렸)|가슴이\s*철렁|\b(?:heart\s*skipped\s*a\s*beat|heart\s*thumped\s*wildly)\b/i],
  ["sub_drop", 0.85, /절망감이?\s*덮치|눈앞이\s*아득해|세상이\s*무너지는\s*듯|머릿속이\s*하얘|나락으로\s*떨어|\b(?:sank\s*into\s*despair|blood\s*ran\s*cold|world\s*crumbled)\b/i],
  ["sudden_silence", 0.8, /순간\s*정적이|찬물을\s*끼얹은\s*듯|침묵이\s*내려앉|숨소리조차\s*사라|\b(?:dead\s*silence\s*fell|sudden\s*silence|everything\s*went\s*silent)\b/i],
  ["thunder", 0.88, /천둥\s*소리|천둥이\s*치|벼락이\s*내리|뇌성|우르릉\s*쾅|번개가\s*번쩍|\b(?:thunder\s*clapped|thunder\s*rumbled|lightning\s*struck)\b/i],
  ["crow_caw", 0.78, /까마귀가?\s*울|까악까악|까마귀\s*소리|\b(?:crow\s*cawed|crows?\s*croaked)\b/i],
  ["dog_bark", 0.78, /개가\s*짖|멍멍\s*짖|사납게\s*짖|\b(?:dog\s*barked|barked\s*fiercely)\b/i],
  ["chopping", 0.75, /도마\s*소리|칼질\s*소리|탁탁탁\s*썰|\b(?:chopping\s*on\s*the\s*board|knife\s*chopped)\b/i],
  ["sizzle", 0.75, /지글지글|프라이팬에\s*굽|\b(?:sizzled\s*in\s*the\s*pan|sizzling\s*sound)\b/i],
  ["glass_clink", 0.78, /잔을\s*부딪|술잔을\s*기울|찻잔을\s*내려놓|얼음이\s*부딪|건배를|\b(?:clinked\s*glasses|set\s*down\s*the\s*teacup|ice\s*clinked)\b/i],
  ["coin_drop", 0.78, /동전이?\s*떨어|금화를?\s*던지|짤랑거리며\s*동전|\b(?:coin\s*dropped|tossed\s*a\s*gold\s*coin)\b/i],
  ["door_slam", 0.84, /문을?\s*쾅\s*닫|문이\s*쾅\s*닫히|거칠게\s*문을\s*열어젖|\b(?:slammed\s*the\s*door|door\s*slammed\s*shut|flung\s*the\s*door\s*open)\b/i],
  ["door_creak", 0.76, /문이\s*삐걱|삐거덕.{0,6}문|끼이익.{0,6}문이\s*열|조심스럽게\s*문을\s*열|\b(?:door\s*creaked|slowly\s*opened\s*the\s*door)\b/i],
  ["knock", 0.78, /노크\s*소리|문을\s*두드리|똑똑\s*문|\b(?:knocked\s*on\s*the\s*door|knock\s*at\s*the\s*door)\b/i],
  ["footsteps", 0.76, /발걸음\s*소리|발소리가\s*(?:들려|다가|울려)|타박타박\s*걸|성큼성큼\s*다가|급히\s*달려가|\b(?:footsteps?\s*(?:echoed|approached)|hurried\s*steps)\b/i],
  ["clock_ticks", 0.74, /시계\s*초침|째깍째깍|초침\s*소리|\b(?:clock\s*ticked|ticking\s*of\s*the\s*clock)\b/i],
  ["page_turn", 0.72, /책장을?\s*넘기|서류를?\s*넘기|편지를?\s*펼치|바스락거리며\s*종이|\b(?:turned\s*the\s*page|unfolded\s*the\s*letter|flipped\s*through\s*the\s*papers)\b/i],
  ["keyboard", 0.74, /키보드를?\s*두드리|타자\s*소리|타닥타닥\s*키보드|\b(?:typed\s*on\s*the\s*keyboard|clatter\s*of\s*keys)\b/i],
  ["camera_shutter", 0.78, /셔터\s*소리|찰칵\s*사진|카메라\s*플래시|\b(?:camera\s*shutter|flashed\s*and\s*clicked)\b/i],
  ["phone_ring", 0.78, /전화벨이?\s*울리|벨\s*소리가\s*울리|따르릉|휴대폰이\s*울리|\b(?:phone\s*rang|telephone\s*ringing)\b/i],
  ["car_horn", 0.84, /경적\s*소리|클랙슨|빵빵\s*경적|\b(?:car\s*horn\s*honked|blared\s*the\s*horn)\b/i],
  ["train_horn", 0.84, /기적\s*소리|열차\s*경적|\b(?:train\s*horn|train\s*whistle)\b/i],
  ["airplane", 0.78, /비행기\s*소리|제트기\s*소리|\b(?:airplane\s*roared|jet\s*engine)\b/i],
  ["bell", 0.8, /종소리가?\s*울리|성당\s*종|\b(?:bell\s*tolled|church\s*bell\s*rang)\b/i],
  ["water_splash", 0.8, /물보라|물에\s*뛰어들|풍덩|물살을\s*가르|\b(?:splashed\s*into\s*the\s*water|huge\s*splash)\b/i],
];

/** Normalizes model SFX and supplements with explicit text cues so sound events trigger reliably. */
export function groundSfx(rawSfx, paragraphs, allIds, currentIds) {
  const currentSet = new Set(currentIds);
  const allSet = new Set(allIds);
  const list = Array.isArray(rawSfx) ? rawSfx : [];
  const normalized = [];
  const usedP = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rawType = String(item.type ?? "").trim().toLowerCase();
    const type = SFX.includes(rawType) ? rawType : SFX_ALIASES[rawType];
    if (!type) continue;
    let p = Number.isInteger(item.p) ? item.p : -1;
    if (!currentSet.has(p)) {
      if (allSet.has(p)) continue; // explicitly points to an earlier/historical paragraph
      if (p >= 0 && p < currentIds.length) p = currentIds[p];
      else if (p >= 1 && p <= currentIds.length) p = currentIds[p - 1];
      else if (currentIds.length) p = currentIds[0];
    }
    if (currentSet.has(p) && !usedP.has(p)) {
      usedP.add(p);
      normalized.push({ p, type, p1: clamp(item.p1, 0, 1, 0.78) });
    }
  }
  for (const row of paragraphs) {
    if (normalized.length >= 2) break;
    if (!currentSet.has(row.id) || usedP.has(row.id)) continue;
    for (const [type, p1, regex] of SFX_TEXT_RULES) {
      if (regex.test(row.text)) {
        usedP.add(row.id);
        normalized.push({ p: row.id, type, p1 });
        break;
      }
    }
  }
  return normalized.slice(0, 2);
}
