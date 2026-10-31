// Music: a mood preset becomes a composed 16- or 32-bar piece (chords, melody, arrangement); the sequencer plays
// pieces back to back and crossfades between moods at a bar line. No browser globals at module scope.
import { MOODS } from "./scene.js";
import { acousticVoices } from "./acoustic.js";

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** env: gain node going 0 → peak over `a`, then exponential decay to silence by `t + len`. */
function env(ctx, t, peak, a, len) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.02, len));
  return g;
}
function osc(ctx, type, f, t, end, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.detune.value = detune;
  o.start(t);
  o.stop(end + 0.05);
  return o;
}
function lp(ctx, f, q = 0.7) {
  const b = ctx.createBiquadFilter();
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}
/** FM pair: modulator at ratio×f with a decaying index; returns the carrier. */
function fm(ctx, f, ratio, index, t, len) {
  const c = osc(ctx, "sine", f, t, t + len);
  const mo = osc(ctx, "sine", f * ratio, t, t + len);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.01 + 0.01, t + len);
  mo.connect(mg).connect(c.frequency);
  return c;
}

// voice(ctx, out, t, midi, dur, vel) schedules one note.
const INSTRUMENT_VOICES = {
  piano(ctx, out, t, n, dur, v) {
    const len = Math.min(dur + 1.35, 3.6);
    const g = env(ctx, t, 0.21 * v, 0.005, len);
    const f = lp(ctx, 1100 + v * 1200, 0.85);
    f.frequency.setValueAtTime(1600 + v * 1400, t);
    f.frequency.exponentialRampToValueAtTime(520, t + len);
    osc(ctx, "triangle", hz(n), t, t + len, -3).connect(f);
    osc(ctx, "sine", hz(n), t, t + len, 3).connect(f);
    const h2 = ctx.createGain();
    h2.gain.value = 0.24;
    osc(ctx, "sine", hz(n) * 2, t, t + len * 0.7).connect(h2).connect(f);
    const hammer = env(ctx, t, 0.05 * v, 0.001, 0.035);
    osc(ctx, "triangle", hz(n) * 4, t, t + 0.04).connect(hammer).connect(f);
    f.connect(g).connect(out);
  },
  rhodes(ctx, out, t, n, dur, v) {
    const len = Math.min(dur + 0.95, 3.2);
    const g = env(ctx, t, 0.19 * v, 0.008, len);
    const f = lp(ctx, 2100 + v * 700, 0.9);
    fm(ctx, hz(n), 1, 1.3 + v * 0.6, t, len).connect(f);
    const tine = env(ctx, t, 0.055 * v, 0.002, Math.min(0.45, len * 0.4));
    osc(ctx, "sine", hz(n) * 7, t, t + 0.45).connect(tine).connect(f);
    f.connect(g).connect(out);
  },
  music_box(ctx, out, t, n, dur, v) {
    const len = 1.75;
    const g = env(ctx, t, 0.14 * v, 0.002, len);
    const f = lp(ctx, 3800);
    fm(ctx, hz(n + 24), 3.5, 0.85, t, len).connect(f);
    const chime = env(ctx, t, 0.06 * v, 0.001, 0.5);
    osc(ctx, "sine", hz(n + 12), t, t + 0.5).connect(chime).connect(f);
    f.connect(g).connect(out);
  },
  strings(ctx, out, t, n, dur, v) {
    const len = dur + 0.95;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.058 * v, t + Math.min(0.42, dur * 0.45));
    g.gain.setValueAtTime(0.058 * v, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const f = lp(ctx, 1500 + v * 650, 0.8);
    for (const d of [-11, -4, 4, 11]) osc(ctx, "sawtooth", hz(n), t, t + len, d).connect(f);
    const sub = ctx.createGain();
    sub.gain.value = 0.35;
    osc(ctx, "triangle", hz(n), t, t + len).connect(sub).connect(f);
    f.connect(g).connect(out);
  },
  cello(ctx, out, t, n, dur, v) {
    const len = dur + 0.55;
    const o = osc(ctx, "sawtooth", hz(n - 12), t, t + len);
    const body = osc(ctx, "triangle", hz(n - 12), t, t + len, 4);
    const vib = osc(ctx, "sine", 5.2, t, t + len);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(1, t);
    vg.gain.linearRampToValueAtTime(10, t + Math.min(0.35, dur * 0.5));
    vib.connect(vg).connect(o.detune);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13 * v, t + Math.min(0.16, dur * 0.35));
    g.gain.setValueAtTime(0.125 * v, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const f = lp(ctx, 780 + v * 320, 1.6);
    o.connect(f);
    body.connect(f);
    f.connect(g).connect(out);
  },
  /** Soft mallet percussion: tuned wooden bars, no noise or metallic transient. */
  marimba(ctx, out, t, n, dur, v) {
    const len = Math.min(dur + 0.5, 1.8);
    const g = env(ctx, t, 0.15 * v, 0.009, len);
    const filter = lp(ctx, 1550, 0.6);
    osc(ctx, "sine", hz(n), t, t + len).connect(filter);
    const overtone = ctx.createGain();
    overtone.gain.value = 0.18;
    osc(ctx, "sine", hz(n) * 3, t, t + len).connect(overtone).connect(filter);
    filter.connect(g).connect(out);
  },
  harp(ctx, out, t, n, dur, v) {
    const len = 1.55;
    const g = env(ctx, t, 0.19 * v, 0.002, len);
    const f = lp(ctx, 3200);
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(620, t + len);
    osc(ctx, "triangle", hz(n), t, t + len, -3).connect(f);
    const pluck = env(ctx, t, 0.08 * v, 0.001, 0.18);
    osc(ctx, "sawtooth", hz(n), t, t + 0.2, 3).connect(pluck).connect(f);
    f.connect(g).connect(out);
  },
  pulse_bass(ctx, out, t, n, dur, v) {
    const len = Math.min(Math.max(dur, 0.18), 0.32);
    const g = env(ctx, t, 0.11 * v, 0.006, len);
    const f = lp(ctx, 380, 1.5);
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(190, t + len);
    osc(ctx, "sawtooth", hz(n - 12), t, t + len, -5).connect(f);
    osc(ctx, "square", hz(n - 12), t, t + len, 5).connect(f);
    const sub = ctx.createGain();
    sub.gain.value = 0.55;
    osc(ctx, "sine", hz(n - 12), t, t + len).connect(sub).connect(g);
    f.connect(g).connect(out);
  },
  /** Soft harmony bed: sine and triangle only under a fixed gentle lowpass; no filter sweep, barely any detune. */
  pad(ctx, out, t, n, dur, v) {
    const len = dur + 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06 * v, t + Math.min(1.6, dur * 0.4));
    g.gain.setValueAtTime(0.06 * v, t + dur);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    const f = lp(ctx, 1400, 0.5);
    osc(ctx, "sine", hz(n), t, t + len, -2.5).connect(f);
    const tri = ctx.createGain();
    tri.gain.value = 0.5;
    osc(ctx, "triangle", hz(n), t, t + len, 2.5).connect(tri).connect(f);
    f.connect(g).connect(out);
  },
  /** Dark harmony bed: a low triangle and a quiet sub sine, dark but not buzzy; unease comes from the harmony, not the timbre. */
  dark_pad(ctx, out, t, n, dur, v) {
    const len = dur + 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.065 * v, t + Math.min(2, dur * 0.45));
    g.gain.setValueAtTime(0.065 * v, t + dur);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    const f = lp(ctx, 650, 0.5);
    osc(ctx, "triangle", hz(n - 12), t, t + len, -2).connect(f);
    const mid = ctx.createGain();
    mid.gain.value = 0.3;
    osc(ctx, "sine", hz(n), t, t + len, 2).connect(mid).connect(f);
    const sub = ctx.createGain();
    sub.gain.value = 0.35;
    osc(ctx, "sine", hz(n - 12), t, t + len).connect(sub).connect(g);
    f.connect(g).connect(out);
  },
};
// Substitute locally rendered acoustic-inspired instruments without changing the music scene contract.
Object.assign(INSTRUMENT_VOICES, acousticVoices);
export const INSTRUMENTS = Object.keys(INSTRUMENT_VOICES);

// ---- composition ----

const PADS = new Set(["pad", "dark_pad"]);
const melodic = (i) => !PADS.has(i) && i !== "pulse_bass";
const pickOf = (rnd, list) => list[Math.floor(rnd() * list.length)];
const triad = (scale, deg) => [0, 2, 4].map((i) => scale[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7));
const diminished = (c) => c[1] - c[0] === 3 && c[2] - c[1] === 3;

// Melody rhythms, one bar of [beat, length] pairs, by how much the mood moves.
const RHYTHMS = {
  slow: [[[0, 2], [2, 2]], [[0, 3], [3, 1]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 4]]],
  flow: [[[0, 1], [1, 1], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]], [[0, 2], [2, 1], [3, 1]], [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]]],
  busy: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]], [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1]], [[0, 0.75], [0.75, 0.25], [1, 1], [2, 2]]],
};
const RHYTHM_OF = { sustain: "slow", sparse: "slow", arp: "flow", broken: "flow", pulse: "flow", drive: "busy", bounce: "busy" };

/** Four chord degrees: tonic start, free move, then a half (…→V) or full (V→I) cadence. */
function phrase(rnd, scale, end, start) {
  const ok = (ds) => ds.filter((d) => !diminished(triad(scale, d)));
  const tonic = ok([0, 5, 2]), pre = ok([3, 1]);
  let dom = ok([4, 6]);
  if (!dom.length) dom = ok([1, 6]);
  const a = start ?? pickOf(rnd, tonic);
  const b = pickOf(rnd, [...tonic, ...pre].filter((d) => d !== a));
  return end === "half" ? [a, b, pickOf(rnd, pre), pickOf(rnd, dom)] : [a, b, pickOf(rnd, dom), 0];
}

/** Scale notes (absolute MIDI) around the mood's register, for the melody to move through. */
function ladder(key, scale, register) {
  const out = [];
  for (let n = register - 10; n <= register + 10; n++) if (scale.includes((((n - key) % 12) + 12) % 12)) out.push(n);
  return out;
}

/** A memorable seed for each section. Reuse with development so A actually sounds like A. */
function makeTheme(rnd) {
  return {
    contour: [0, rnd() < 0.5 ? 1 : 2, rnd() < 0.6 ? -1 : 1, rnd() < 0.5 ? 2 : -2, 0],
    answer: [0, -1, 1, rnd() < 0.5 ? -2 : 2, 0],
  };
}

function nearestTone(notes, chord, key, around, preferTonic = false) {
  const pcs = new Set((preferTonic ? [chord[0]] : chord).map(c => ((c % 12) + 12) % 12));
  // chord degrees are relative to key; chord[0] in these calls has not yet been transposed.
  const want = notes.map((n, i) => ({ i, pc: ((n - key) % 12 + 12) % 12 }))
    .filter(({pc}) => pcs.has(pc));
  if (!want.length) return Math.max(0, Math.min(notes.length - 1, around));
  return want.reduce((best, cur) => Math.abs(cur.i - around) < Math.abs(best.i - around) ? cur : best).i;
}

/** Four-bar question and answer: phrase shapes repeat, while pitch and timing develop gently. */
function melodyPhrase(rnd, rhythm, chords, key, notes, from, theme, variation, mood) {
  let index = notes.indexOf(from);
  if (index < 0) index = notes.length >> 1;
  const quiet = ["sad", "tragic", "dark", "mystery", "horror", "calm", "romance"].includes(mood);
  return chords.map((chord, bar) => {
    const contour = bar % 2 === 0 ? theme.contour : theme.answer;
    // Answer the motif with a slightly sparser cadence; preserve some recognizable rhythms.
    let pattern = rhythm.map(([beat, len]) => ({beat, len}));
    if (bar === 3) pattern = quiet ? [{beat:0,len:2}, {beat:2,len:2}] : [{beat:0,len:1.5}, {beat:1.5,len:.5}, {beat:2,len:2}];
    if (quiet && bar === 1 && pattern.length > 2) pattern = pattern.filter((e, i) => i !== 1);
    // Don't hit every beat: phrases breathe, especially when the story is reflective.
    if (bar === 2 && pattern.length > 3 && rnd() < .65) pattern = pattern.filter((e, i) => i !== 1);
    const target = Math.max(0, Math.min(notes.length - 1, index + [1, -1, 2, -1][bar]));
    const output = pattern.map(({beat,len}, i) => {
      const last = bar === 3 && i === pattern.length - 1;
      const start = beat === 0;
      if (start) index = nearestTone(notes, chord, key, target + (variation ? 1 : 0));
      else if (last) index = nearestTone(notes, chord, key, index, true);
      else index = Math.max(0, Math.min(notes.length - 1, index + contour[i % contour.length] + (variation && i === 1 ? -1 : 0)));
      if (!start && !last && beat === Math.floor(beat) && rnd() < .35)
        index = nearestTone(notes, chord, key, index);
      const isPickup = !start && !last;
      const strength = Math.max(.52, Math.min(1, (start ? .89 : isPickup ? .70 : .83) + (rnd() - .5) * .13));
      return { beat, len: last ? 4 - beat : len * (quiet ? .94 : .91), note: notes[index], vel: strength };
    });
    return output;
  });
}

/**
 * Composes one piece for `mood`. The key and tempo stay close to the previous piece so a change of piece glides.
 * Returns { mood, key, bpm, bars: [{ chord (absolute MIDI triad), melody: [{beat, len, note}], section }] }.
 * @param {string} mood @param {() => number} [rnd] @param {number | null} [prevKey] @param {number | null} [prevBpm]
 */
export function compose(mood, rnd = Math.random, prevKey = null, prevBpm = null) {
  const m = MOODS[mood] ?? MOODS.calm;
  const wrap = (k) => 46 + ((((k - 46) % 12) + 12) % 12);
  const key = prevKey == null ? 46 + Math.floor(rnd() * 12) : wrap(prevKey + pickOf(rnd, [0, 0, 5, 7, -5, -7]));
  const [lo, hi] = m.bpm;
  const bpm = Math.round(prevBpm == null ? lo + (hi - lo) * (0.3 + 0.4 * rnd()) : Math.min(hi, Math.max(lo, prevBpm + (rnd() - 0.5) * 8)));
  const section = (start) => [...phrase(rnd, m.scale, "half", start), ...phrase(rnd, m.scale, "full")];
  const A = section(0), B = section(pickOf(rnd, [3, 5]));
  const form = rnd() < 0.5 ? [["A", A], ["B", B]] : [["A", A], ["A", A], ["B", B], ["A", [...A.slice(0, 4), ...phrase(rnd, m.scale, "full")]]];
  const notes = ladder(key, m.scale, m.register);
  const rhythms = RHYTHMS[RHYTHM_OF[m.style]];
  const motifs = { A: pickOf(rnd, rhythms), B: pickOf(rnd, rhythms) };
  const themes = { A: makeTheme(rnd), B: makeTheme(rnd) };
  const bars = [];
  let from = notes[notes.length >> 1];
  const occurrences = { A: 0, B: 0 };
  for (const [name, degrees] of form) {
    const occurrence = occurrences[name]++;
    for (let p = 0; p < degrees.length; p += 4) {
      const chords = degrees.slice(p, p + 4).map((d, i) => {
        const c = triad(m.scale, d);
        if (d === 4 && i >= 2 && c[1] - c[0] === 3) c[1]++; // major V at a cadence in minor keys
        return c;
      });
      // the second phrase of a section answers the first with the same rhythm, occasionally a fresh one
      const melody = melodyPhrase(rnd, motifs[name], chords, key, notes, from,
        themes[name], occurrence > 0 || p > 0, mood);
      from = melody[3].at(-1)?.note ?? from;
      chords.forEach((c, i) => bars.push({
        chord: c.map((n) => n + key), melody: melody[i], section: name,
        // Rising/falling four-bar arc: human-like phrasing, not one static velocity.
        dynamics: ([.78, .92, 1.03, .73][i] * (name === "B" ? 1.06 : 1)),
      }));
    }
  }
  preventShortMelodyLoops(bars, bpm, notes);
  return { mood, key, bpm, bars };
}

/** Prevent an identical entire bar melody from repeating within eight seconds.
 * Adjust a note to a nearby scale tone; never shorten the underlying 16/32-bar form.
 */
export function preventShortMelodyLoops(bars, bpm, scaleNotes) {
  const secondsPerBar = 240 / bpm;
  const signature = (bar) => bar.melody.map(({ beat, len, note }) => `${beat}:${len}:${note}`).join("|");
  for (let i = 0; i < bars.length; i++) {
    const current = bars[i];
    if (!current?.melody?.length) continue;
    const collides = () => {
      for (let j = i - 1; j >= 0 && (i - j) * secondsPerBar < 8; j--)
        if (signature(bars[j]) === signature(current)) return true;
      return false;
    };
    if (!collides()) continue;
    const first = current.melody[0];
    const original = first.note;
    // Prefer an alternate chord tone in the same register; otherwise a nearby scale note.
    const pitches = scaleNotes.filter((n) => n !== original);
    const chordPitches = pitches.filter((n) => current.chord.some((chord) => ((chord - n) % 12 + 12) % 12 === 0));
    for (const n of [...chordPitches, ...pitches].sort((a, b) => Math.abs(a - original) - Math.abs(b - original))) {
      first.note = n;
      if (!collides()) break;
    }
  }
}

/** Places chord notes within an octave around `center` so successive chords move by small steps. */
const voice = (chord, center) => chord.map((n) => { let x = n; while (x < center - 6) x += 12; while (x >= center + 6) x -= 12; return x; }).sort((a, b) => a - b);

/** Notes for one bar of an accompaniment `role`: [{beat, note, len, vel}]. */
export function accompany(role, chord, center, energy, rnd = Math.random) {
  const c = voice(chord, center), root = voice([chord[0]], center - 12)[0], up = [...c, ...c.map((n) => n + 12)];
  switch (role) {
    case "sustain": return c.map((note) => ({ beat: 0, note, len: 4, vel: 0.55 }));
    case "arp": {
      const step = energy < 0.4 ? 1 : 0.5;
      return Array.from({ length: 4 / step }, (_, i) => ({ beat: i * step, note: up[i % up.length], len: step + 0.3, vel: i === 0 ? 0.6 : 0.45 }));
    }
    case "broken": return [c[0], c[2], c[1] + 12, c[2]].map((note, i) => ({ beat: i, note, len: 1, vel: i === 0 ? 0.6 : 0.45 }));
    case "bounce": return [{ beat: 0, note: root, len: 0.4, vel: 0.6 }, { beat: 2, note: root + 7, len: 0.4, vel: 0.5 }, ...[1, 3].flatMap((beat) => c.map((note) => ({ beat, note, len: 0.3, vel: 0.35 })))];
    case "sparse": return Array.from({ length: 2 + Math.floor(rnd() * 2) }, () => ({ beat: Math.floor(rnd() * 8) / 2, note: pickOf(rnd, up), len: 1.5, vel: 0.45 }));
    case "pulse": return Array.from({ length: 8 }, (_, i) => ({ beat: i / 2, note: root, len: 0.4, vel: i % 4 === 0 ? 0.85 : 0.55 }));
    case "drive_bass": return Array.from({ length: 16 }, (_, i) => ({ beat: i / 4, note: i % 8 === 6 ? root + 12 : root, len: 0.2, vel: i % 4 === 0 ? 0.9 : 0.55 }));
    case "drive": return Array.from({ length: 8 }, (_, i) => ({ beat: i / 2, note: c[i % 2 ? 2 : 1], len: 0.45, vel: i % 2 ? 0.4 : 0.55 }));
    case "bass": return energy < 0.45 ? [{ beat: 0, note: root, len: 4, vel: 0.6 }] : [{ beat: 0, note: root, len: 2, vel: 0.65 }, { beat: 2, note: root + 7, len: 2, vel: 0.5 }];
    case "arp_slow": return up.slice(0, 4).map((note, i) => ({ beat: i, note, len: 1.6, vel: i === 0 ? 0.55 : 0.4 }));
  }
  return [];
}

/** Who plays what: a pad bed, one melody voice, and one or two accompaniments by role. */
export function arrangement(mood) {
  const m = MOODS[mood] ?? MOODS.calm;
  const all = [m.lead, ...m.support];
  // The foundation is always bowed strings; synthetic pad voices are excluded.
  const bed = m.lead === "strings" ? "cello" : "strings";
  const lead = all.find(melodic) ?? null;
  const role = (i) =>
    i === "pulse_bass" ? (m.style === "drive" ? "drive_bass" : "pulse")
    : i === "cello" ? "bass"
    : i === "strings" ? (m.style === "drive" ? "drive" : "sustain")
    : m.style === "sustain" ? "arp_slow"
    : ["pulse", "drive"].includes(m.style) ? "broken" : m.style;
  const parts = all.filter((i) => i !== bed && i !== lead).map((instrument) => ({ instrument, role: role(instrument) }));
  // a lone melody instrument also carries the accompaniment
  if (!parts.length && lead) parts.push({ instrument: lead, role: role(lead) });
  // The percussion section is orchestral, and intentionally absent from reflective scenes.
  const percussion = ({
    battle: ["bass_drum", "frame_drum", "timpani"],
    anger: ["frame_drum", "bass_drum"],
    epic: ["timpani", "bass_drum"],
    tension: ["timpani", "frame_drum"],
    horror: ["timpani"],
    adventure: ["frame_drum"],
    growth: ["frame_drum"],
  })[mood] ?? [];
  return { bed, lead, parts, percussion };
}

/** Restrained orchestral percussion. 4/4 beats; no drum-machine beat or perpetual loop.
 * Every note has a distinct musical function, and quiet passages omit the percussion entirely.
 */
export function percussionPattern(mood, intensity, barIndex) {
  if (!Number.isFinite(intensity) || intensity < .40) return [];
  const e = Math.max(0, Math.min(1, intensity));
  const four = barIndex % 4;
  const beat = (instrument, when, vel, note=48, len=.55) => ({
    instrument, beat:when, note, len, vel:Math.min(.83, vel * (.55 + .45 * e)),
  });
  if (mood === 'epic') {
    if (four === 0) return [beat('timpani', 0, .65, 47, 1.2), ...(e > .68 ? [beat('bass_drum', 0, .44)] : [])];
    if (four === 3 && e > .62) return [beat('timpani', 3, .48, 50)];
    return [];
  }
  if (mood === 'battle') {
    if (barIndex % 2 && (e < .7 || four === 3)) return [];
    return [beat('bass_drum', 0, .58), beat('frame_drum', 2, .35),
      ...(e > .7 && four === 3 ? [beat('timpani', 3.5, .52, 50)] : [])];
  }
  if (mood === 'anger') return four % 2 === 0
    ? [beat('frame_drum', 0, .39), ...(e > .72 ? [beat('bass_drum', 2.5, .3)] : [])] : [];
  if (mood === 'tension') return e > .55 && four === 2
    ? [beat('timpani', 0, .4, 45, .95)] : [];
  if (mood === 'horror') return e > .75 && four === 3
    ? [beat('timpani', 0, .35, 41, 1.2)] : [];
  if (mood === 'adventure' || mood === 'growth') return e > .65 && four === 0
    ? [beat('frame_drum', 0, .28)] : [];
  return [];
}

// ---- playback ----

const XFADE = 2.7; // gentle but responsive crossfade after the new screen is classified

/**
 * Plays the scene's mood as consecutive composed pieces into `out`. setScene() with a new mood starts a fresh piece at
 * within half a second and crossfades the old one out; the same mood only updates intensity, read bar by bar.
 * tick(horizon) is called by the engine's lookahead scheduler.
 */
export function createSequencer(ctx, out) {
  const timing = { lateBars: 0, maxLateMs: 0 };
  let players = [], scene = null, key = null, bpm = null, voiceEnds = [];
  const live = () => players.find((p) => p.until === undefined);
  function start(mood, at, fade) {
    const piece = compose(mood, Math.random, key, bpm);
    key = piece.key; bpm = piece.bpm;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(1, at + fade);
    gain.connect(out);
    return { piece, gain, bar: 0, barTime: at, plan: arrangement(mood) };
  }
  function retire(p, at, fade) {
    p.until = at + fade;
    p.gain.gain.cancelScheduledValues(at);
    p.gain.gain.setValueAtTime(1, at);
    p.gain.gain.linearRampToValueAtTime(0.0001, at + fade);
    setTimeout(() => { try { p.gain.disconnect(); } catch {} }, (at + fade - ctx.currentTime + 4) * 1000);
  }
  function play(p, instrument, events, center, vel) {
    const fn = INSTRUMENT_VOICES[instrument], beat = 60 / p.piece.bpm;
    for (const e of events) {
      // Small human timing deviations; no jitter when the note was scheduled too close to real time.
      const intended = p.barTime + e.beat * beat;
      const t = intended > ctx.currentTime + .07
        ? Math.max(p.barTime + .003, intended + (Math.random() - .5) * .023)
        : intended;
      voiceEnds = voiceEnds.filter((end) => end > t);
      if (voiceEnds.length >= 48) continue;
      voiceEnds.push(t + e.len * beat + 2);
      fn(ctx, p.gain, t, e.note, e.len * beat, e.vel * vel);
    }
  }
  function bar(p) {
    const { bars } = p.piece, m = MOODS[p.piece.mood], b = bars[p.bar], energy = scene?.intensity ?? 0.5;
    const vel = Math.min(1, (0.45 + energy * 0.5) * (b.dynamics ?? 1));
    // the bed holds through a repeated chord and is re-voiced only when the harmony changes, kept under the lead
    const same = (x) => x?.chord.join() === b.chord.join();
    if (!same(bars[p.bar - 1])) {
      let hold = 1;
      while (same(bars[p.bar + hold])) hold++;
      play(p, p.plan.bed, accompany("sustain", b.chord, m.register - 12, energy).map((e) => ({ ...e, len: 4 * hold })), m.register - 12, vel * 0.45);
    }
    p.plan.parts.forEach((part, i) => {
      if (i > 0 && energy < 0.6) return; // the second accompaniment joins only when the scene is intense
      play(p, part.instrument, accompany(part.role, b.chord, m.register - 5, energy), m.register - 5, vel * 0.8);
    });
    if (p.plan.percussion.length) for (const hit of percussionPattern(p.piece.mood, energy, p.bar)) {
      play(p, hit.instrument, [{beat:hit.beat, note:hit.note, len:hit.len, vel:hit.vel}], hit.note, vel);
    }
    // a quiet scene leaves every other bar of melody out
    if (p.plan.lead && !(energy < 0.3 && p.bar % 2)) play(p, p.plan.lead, b.melody.map((e) => ({ ...e, vel: .67 * (e.vel ?? 1) })), m.register, vel);
    p.barTime += 4 * 60 / p.piece.bpm;
    if (++p.bar >= bars.length) { p.piece = compose(p.piece.mood, Math.random, key, bpm); key = p.piece.key; bpm = p.piece.bpm; p.bar = 0; }
  }
  return {
    timing,
    get scene() { return scene; },
    get piece() { return live()?.piece ?? null; },
    setScene(s) {
      const cur = live();
      scene = s;
      if (cur?.piece.mood === s.mood) return;
      // Do not wait several seconds for the next bar boundary after the mood decision.
      // Existing notes fade out while the new score fades in, avoiding an abrupt cut.
      const at = cur ? Math.max(ctx.currentTime + 0.08, Math.min(cur.barTime, ctx.currentTime + 0.5)) : ctx.currentTime + 0.1;
      const fade = cur ? (["battle", "horror"].includes(s.mood) ? 1.7 : XFADE) : 1.2;
      if (cur) retire(cur, at, fade);
      players.push(start(s.mood, at, fade));
    },
    /** Same piece, new intensity: takes effect at the next bar. */
    setEnergy(intensity) { if (scene) scene = { ...scene, intensity }; },
    stop() {
      for (const p of players) if (p.until === undefined) retire(p, ctx.currentTime, 0.6);
      players = []; scene = null;
    },
    tick(horizon) {
      for (const p of players) {
        while (p.barTime < horizon && (p.until === undefined || p.barTime < p.until)) {
          if (p.barTime < ctx.currentTime) {
            timing.lateBars++;
            timing.maxLateMs = Math.max(timing.maxLateMs, (ctx.currentTime - p.barTime) * 1000);
            p.barTime = ctx.currentTime + 0.015;
          }
          bar(p);
        }
      }
      players = players.filter((p) => p.until === undefined || p.barTime < p.until);
    },
  };
}
