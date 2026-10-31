// Acoustic-inspired instruments for TWICE. Entirely local synthesis: no external recordings or licensing dependencies.
// Cached spectral plucks imitate the changing partials of a struck/plucked string, while bowed tones
// use slowly animated harmonic wavetables. This is not a claim of studio-recorded instrument samples.
const waveCache = new WeakMap();
const sampleCache = new WeakMap();
const hz = (n) => 440 * 2 ** ((n - 69) / 12);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const timbres = {
  piano: { length: 2.8, harmonics: [1, .52, .27, .16, .10, .064, .031, .017], falloff: .78, stiffness: .00045, noise: .018 },
  harp: { length: 2.4, harmonics: [1, .31, .22, .13, .05, .032, .014], falloff: .96, stiffness: .0001, noise: .010 },
  marimba: { length: 1.65, harmonics: [1, .05, .24, .03, .11], falloff: 1.35, stiffness: .06, noise: .006 },
};

function createPluckBuffer(ctx, name, base) {
  const cfg = timbres[name];
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(sampleRate * cfg.length);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const samples = buffer.getChannelData(0);
  const f = hz(base);
  // Deterministic, short excitation so repeated notes share a coherent timbre.
  let rng = ((base * 1664525 + name.length * 1013904223) >>> 0) || 1;
  const phase = cfg.harmonics.map((_, i) => i * 0.37);
  const frequencies = cfg.harmonics.map((_, i) => {
    const p = i + 1;
    return 2 * Math.PI * f * p * Math.sqrt(1 + cfg.stiffness * p * p) / sampleRate;
  });
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // High partials die quickly, as on a natural plucked/struck resonator.
    let s = 0;
    for (let p = 0; p < cfg.harmonics.length; p++) {
      const decay = Math.exp(-t * (cfg.falloff + .52 * p * p));
      s += cfg.harmonics[p] * decay * Math.sin(frequencies[p] * i + phase[p]);
    }
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const excitation = ((rng / 0xffffffff) * 2 - 1) * cfg.noise * Math.exp(-t * 175);
    const onset = Math.min(1, t / (name === 'piano' ? .005 : .003));
    // Avoid hard buffer edges when the sample stops.
    const tail = Math.min(1, (cfg.length - t) / .08);
    samples[i] = (s + excitation) * onset * Math.max(0, tail);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const gain = peak ? .82 / peak : 1;
  for (let i = 0; i < length; i++) samples[i] *= gain;
  return buffer;
}

function sample(ctx, name, note) {
  let byName = sampleCache.get(ctx);
  if (!byName) { byName = new Map(); sampleCache.set(ctx, byName); }
  // Twelve-semitone anchors mean only a few buffers per instrument, keeping memory and first-note latency bounded.
  const base = clamp(48 + Math.round((note - 48) / 12) * 12, 36, 96);
  const id = `${name}:${base}`;
  if (!byName.has(id)) byName.set(id, createPluckBuffer(ctx, name, base));
  return { buffer: byName.get(id), base };
}

function pluck(ctx, out, name, at, note, dur, velocity) {
  const {buffer, base} = sample(ctx, name, note);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = 2 ** ((note - base) / 12);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clamp(1450 + velocity * 3100 + (note - 60) * 18, 1100, 7800);
  const gain = ctx.createGain();
  const level = { piano: .21, harp: .18, marimba: .19 }[name] * velocity;
  gain.gain.setValueAtTime(.0001, at);
  gain.gain.linearRampToValueAtTime(level, at + .008);
  // Key release controls damping on piano; harp/marimba are mostly natural decays.
  const hold = name === 'piano' ? clamp(dur, .12, 2.8) : clamp(dur + .3, .3, 2.0);
  gain.gain.setValueAtTime(level * .93, at + Math.max(.01, hold));
  gain.gain.exponentialRampToValueAtTime(.0001, at + hold + (name === 'piano' ? .65 : .32));
  source.connect(lp).connect(gain).connect(out);
  source.start(at);
  source.stop(at + Math.min(buffer.duration / source.playbackRate.value, hold + .75));
}

function wave(ctx, name) {
  let all = waveCache.get(ctx);
  if (!all) { all = new Map(); waveCache.set(ctx, all); }
  if (all.has(name)) return all.get(name);
  // Quiet high partials avoid the brittle raw-sawtooth sound of the previous string section.
  const amps = name === 'cello'
    ? [0, 1, .57, .3, .20, .12, .075, .040, .020]
    : [0, 1, .41, .27, .14, .08, .055, .023, .012];
  const real = new Float32Array(amps.length);
  const imag = Float32Array.from(amps);
  const result = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  all.set(name, result);
  return result;
}

function bow(ctx, out, name, at, note, dur, velocity) {
  const cello = name === 'cello';
  const f = hz(cello ? note - 12 : note);
  const release = cello ? .50 : .75;
  const length = Math.max(.12, dur) + release;
  const attack = Math.min(cello ? .14 : .23, Math.max(.035, dur * .28));
  const g = ctx.createGain();
  const level = (cello ? .15 : .085) * velocity;
  g.gain.setValueAtTime(.0001, at);
  g.gain.linearRampToValueAtTime(level, at + attack);
  g.gain.setValueAtTime(level * .91, at + Math.max(attack + .01, dur));
  g.gain.exponentialRampToValueAtTime(.0001, at + length);
  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.setValueAtTime(cello ? 1100 : 2400, at);
  body.frequency.linearRampToValueAtTime(cello ? 1700 : 3300, at + Math.min(.6, dur));
  body.Q.value = .5;
  // Two near-unison bow voices create a broad natural section without chorus-style sweeping.
  const w = wave(ctx, name);
  for (const cents of (cello ? [-2, 3] : [-5, 4])) {
    const o = ctx.createOscillator();
    o.setPeriodicWave(w);
    o.frequency.value = f;
    o.detune.value = cents;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = cello ? 5.05 : 4.7;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(.0001, at);
    depth.gain.linearRampToValueAtTime(cello ? 7 : 3.8, at + Math.min(.7, dur * .55));
    vibrato.connect(depth).connect(o.detune);
    o.connect(body);
    o.start(at); vibrato.start(at);
    o.stop(at + length + .03); vibrato.stop(at + length + .03);
  }
  body.connect(g).connect(out);
}

/** Low, organic orchestral percussion. These are physical-model approximations, not electronic drum-machine hits.
 * No loops, quantized hi-hats, or aggressive synthetic sweeps. Keep transient material warm and short.
 */
function membrane(ctx, out, kind, at, midi, dur, velocity) {
  const timpani = kind === 'timpani';
  const large = kind === 'bass_drum';
  const fundamental = timpani ? clamp(hz(midi - 12), 65, 165) : large ? 56 : 116;
  const life = timpani ? clamp(dur + .9, 1, 2.6) : large ? 1.55 : .82;
  const body = ctx.createGain();
  const peak = (timpani ? .13 : large ? .18 : .105) * velocity;
  body.gain.setValueAtTime(.0001, at);
  body.gain.linearRampToValueAtTime(peak, at + (large ? .014 : .006));
  body.gain.exponentialRampToValueAtTime(.0001, at + life);
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = timpani ? 540 : large ? 310 : 720;
  low.Q.value = .55;
  low.connect(body).connect(out);
  const partials = timpani ? [[1, 1], [1.48, .23], [2.1, .13]]
    : large ? [[1, 1], [1.62, .17]] : [[1, 1], [1.53, .23], [2.3, .08]];
  for (const [ratio, magnitude] of partials) {
    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(fundamental * ratio * (large ? 1.09 : 1.035), at);
    sine.frequency.exponentialRampToValueAtTime(fundamental * ratio, at + (large ? .14 : .09));
    const partialGain = ctx.createGain();
    partialGain.gain.value = magnitude / partials.length;
    sine.connect(partialGain).connect(low);
    sine.start(at);
    sine.stop(at + life + .025);
  }
  // Tiny filtered acoustic attack, not an audible electronic noise layer.
  const noiseLength = .045;
  const sr = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.max(16, Math.floor(sr * noiseLength)), sr);
  const data = buffer.getChannelData(0);
  let seed = Math.floor(at * 1000 + midi * 100 + kind.length * 31013) >>> 0;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff * 2 - 1) * Math.exp(-i / sr * 115);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const attackFilter = ctx.createBiquadFilter();
  attackFilter.type = 'lowpass';
  attackFilter.frequency.value = large ? 270 : timpani ? 780 : 1350;
  const attackGain = ctx.createGain();
  attackGain.gain.value = peak * (large ? .08 : .11);
  source.connect(attackFilter).connect(attackGain).connect(out);
  source.start(at);
  source.stop(at + noiseLength);
}

export const acousticVoices = {
  piano(ctx, out, t, n, dur, v) { pluck(ctx, out, 'piano', t, n, dur, v); },
  harp(ctx, out, t, n, dur, v) { pluck(ctx, out, 'harp', t, n, dur, v); },
  marimba(ctx, out, t, n, dur, v) { pluck(ctx, out, 'marimba', t, n, dur, v); },
  strings(ctx, out, t, n, dur, v) { bow(ctx, out, 'strings', t, n, dur, v); },
  cello(ctx, out, t, n, dur, v) { bow(ctx, out, 'cello', t, n, dur, v); },
  timpani(ctx, out, t, n, dur, v) { membrane(ctx, out, 'timpani', t, n, dur, v); },
  bass_drum(ctx, out, t, n, dur, v) { membrane(ctx, out, 'bass_drum', t, n, dur, v); },
  frame_drum(ctx, out, t, n, dur, v) { membrane(ctx, out, 'frame_drum', t, n, dur, v); },
};

export const acousticCacheStats = (ctx) => ({ buffers: sampleCache.get(ctx)?.size ?? 0, waves: waveCache.get(ctx)?.size ?? 0 });
