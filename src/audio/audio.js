// Web Audio synthesis engine: mixer graph, reverb, lookahead scheduler, ambience layers, and one-shot SFX.
import { createSequencer } from "./music.js";
import { playSfx } from "./sfx.js";
import { sine, modal, noiseHit } from "./synthesis.js";
import { ambienceSlot } from "../domain/score.js";

const LOOKAHEAD = 0.2; // seconds scheduled ahead of currentTime
const MUSIC_AHEAD = 0.75; // reserve music before inference completion/DOM work can stall the main thread
const FADE = 1; // setTargetAtTime time constant for scene changes (~3 s to settle)

const rand = (a, b) => a + Math.random() * (b - a);

function noiseBuffer(ctx, kind, sec) {
  const N = 4096; // seam crossfade length
  const len = ctx.sampleRate * sec;
  const d = new Float32Array(len + N);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0,
    x1 = 0,
    y1 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") d[i] = w;
    else if (kind === "brown") {
      last = (last + 0.02 * w) / 1.02;
      d[i] = y1 = last - x1 + 0.995 * y1; // DC blocker
      x1 = last;
    } else {
      // Paul Kellet's economy pink filter
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  if (kind === "brown") for (let i = 0; i < d.length; i++) d[i] *= 3.5;
  // the head fades in from the samples past the end, so the loop point is continuous
  for (let k = 0; k < N; k++) d[k] = d[k] * (k / N) + d[len + k] * (1 - k / N);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  buf.copyToChannel(d.subarray(0, len), 0);
  return buf;
}

/** Stereo impulse response: noise darkening as it decays (one-pole LP), 10 ms pre-delay, `sec` long. */
function impulse(ctx, sec) {
  const len = Math.floor(ctx.sampleRate * sec);
  const pre = Math.floor(ctx.sampleRate * 0.01);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = pre; i < len; i++) {
      y += (0.5 * (1 - i / len) ** 2 + 0.02) * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp((-6.9 * i) / len);
    }
  }
  return buf;
}

const ramp = (param, v, t, tc = FADE) => param.setTargetAtTime(v, t, tc);

function compressor(ctx, threshold, knee, ratio, attack, release) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = threshold;
  c.knee.value = knee;
  c.ratio.value = ratio;
  c.attack.value = attack;
  c.release.value = release;
  return c;
}

export function createEngine(ctx = new AudioContext()) {
  const ticks = new Set();
  const noise = {
    white: noiseBuffer(ctx, "white", 4), // grains and hits only
    pink: noiseBuffer(ctx, "pink", 11),
    brown: noiseBuffer(ctx, "brown", 11),
  };
  const mono = (kind) => {
    const s = ctx.createBufferSource();
    s.buffer = noise[kind];
    s.loop = true;
    s.start(ctx.currentTime, Math.random() * s.buffer.duration);
    // slow pitch drift so the loop never lines up with itself
    let next = ctx.currentTime;
    const drift = (h) => {
      if (next >= h) return;
      s.playbackRate.setTargetAtTime(rand(0.92, 1.08), next, 3);
      next += rand(8, 15);
    };
    ticks.add(drift);
    s.onended = () => ticks.delete(drift);
    return s;
  };
  // decorrelated stereo bed: two loops at different offsets into L/R
  const loop = (kind) => {
    const m = ctx.createChannelMerger(2);
    const lr = [mono(kind), mono(kind)];
    lr.forEach((s, i) => s.connect(m, 0, i));
    m.stop = () => lr.forEach((s) => s.stop());
    return m;
  };

  // [music | ambience | sfx] → muffle lowpass → dry + convolver → compressor → duck → master → limiter
  const bus = {
    music: ctx.createGain(),
    ambience: ctx.createGain(),
    sfx: ctx.createGain(),
  };
  const muffle = ctx.createBiquadFilter();
  muffle.frequency.value = 20000;
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0.25;
  const irs = [0.6, 1.8, 4].map((s) => impulse(ctx, s));
  // two convolvers so a room change crossfades instead of swapping a live buffer
  const verbs = [0, 1].map(() => {
    const c = ctx.createConvolver();
    const g = ctx.createGain();
    g.gain.value = 0;
    muffle.connect(c).connect(g).connect(wet);
    return { c, g };
  });
  let cur = 0;
  verbs[0].c.buffer = irs[1];
  verbs[0].g.gain.value = 1;
  const comp = compressor(ctx, -24, 6, 3, 0.01, 0.25);
  const duckGain = ctx.createGain(); // only sudden_silence automates this
  const hushGain = ctx.createGain(); // sustained silence, independent of transient ducking
  const master = ctx.createGain(); // the panel's master fader and hide-mute
  master.gain.value = 0.8;
  const limiter = compressor(ctx, -3, 0, 20, 0.001, 0.08);
  const out = ctx.createGain();
  out.gain.value = 0.85;
  // user's mixer faders, separate from the gains scenes automate
  const mix = {
    music: ctx.createGain(),
    ambience: ctx.createGain(),
    sfx: ctx.createGain(),
  };
  const musicPauseGain = ctx.createGain();
  for (const k in bus) {
    if (k === "music") bus[k].connect(musicPauseGain).connect(mix[k]).connect(muffle);
    else if (k === "sfx") {
      // Foreground SFX bypasses `muffle` so glass shatters, blades and impacts keep their high-frequency clarity
      bus[k].connect(mix[k]);
      mix[k].connect(dry);
      for (const v of verbs) mix[k].connect(v.c);
    } else bus[k].connect(mix[k]).connect(muffle);
  }
  // Ambience beds are mostly filtered noise: tame the hiss above 5 kHz so the described sound carries, not the static.
  const deHiss = ctx.createBiquadFilter();
  deHiss.type = "highshelf";
  deHiss.frequency.value = 5000;
  deHiss.gain.value = -9;
  bus.ambience.disconnect();
  bus.ambience.connect(deHiss).connect(mix.ambience);
  muffle.connect(dry).connect(comp);
  wet.connect(comp);
  // layers heard "from inside" (through a wall or window) also feed a short room reverb of their own
  const roomSend = ctx.createGain();
  const indoorVerb = ctx.createConvolver();
  indoorVerb.buffer = irs[0];
  roomSend.connect(indoorVerb).connect(comp);
  comp
    .connect(duckGain)
    .connect(hushGain)
    .connect(master)
    .connect(limiter)
    .connect(out)
    .connect(ctx.destination);
  bus.ambience.gain.value = 0.9;
  bus.sfx.gain.value = 0.85;

  const seq=createSequencer(ctx,bus.music);
  const timing={maxMainGapMs:0};
  let lastTick=ctx.currentTime;
  const timer=setInterval(()=>{
    const now=ctx.currentTime;
    if (ctx.state === "running") timing.maxMainGapMs=Math.max(timing.maxMainGapMs,(now-lastTick)*1000);
    lastTick=now;
    seq.tick(now+MUSIC_AHEAD);
    for (const f of ticks) f(now+LOOKAHEAD);
  },25);
  const musicMeter=ctx.createAnalyser(); musicMeter.fftSize=1024;
  mix.music.connect(musicMeter);
  const meterData=new Float32Array(1024);

  let sfxLayer = ctx.createGain();
  sfxLayer.connect(bus.sfx);
  function clearSfx(sec = 0.15) {
    const prev = sfxLayer;
    const t = ctx.currentTime;
    prev.gain.cancelScheduledValues(t);
    prev.gain.setTargetAtTime(0.0001, t, Math.max(0.02, sec / 3));
    setTimeout(() => { try { prev.disconnect(); } catch {} }, Math.ceil(sec * 1000) + 200);
    sfxLayer = ctx.createGain();
    sfxLayer.connect(bus.sfx);
  }

  const env = { ctx, noise, loop, ticks, bus, roomSend };
  const running = new Map(); // ambience slot → instance
  let room = -1;

  function applyScene(s, changeMusic) {
    const t = ctx.currentTime;
    if (changeMusic) seq.setScene(s);
    else seq.setEnergy(s.intensity);
    ramp(muffle.frequency, 20000 * (300 / 20000) ** s.muffle, t); // log 20 kHz → 300 Hz
    const r = s.room < 0.33 ? 0 : s.room < 0.66 ? 1 : 2;
    if (r !== room) {
      if (room >= 0) {
        ramp(verbs[cur].g.gain, 0, t, 0.3);
        cur ^= 1;
        verbs[cur].c.buffer = irs[r];
        ramp(verbs[cur].g.gain, 1, t, 0.3);
      } else verbs[cur].c.buffer = irs[r];
      room = r;
    }
    ramp(wet.gain, 0.1 + s.room * 0.5, t);
    ramp(dry.gain, 1 - s.room * 0.35, t);
    ramp(bus.music.gain, 0.35 + s.intensity * 0.4, t);
    ramp(bus.sfx.gain, 0.62 + s.intensity * 0.2, t);
    // One layer per slot (each animal gets its own). A variant change glides where the engine supports it
    // (rain material, wind strength, thunder distance) and restarts the layer otherwise.
    const want = new Map(s.ambience.map((a) => [ambienceSlot(a), a]));
    for (const [slot, inst] of running)
      if (!want.has(slot) || (want.get(slot).variant !== inst.variant && !inst.glides)) {
        inst.stop();
        running.delete(slot);
      }
    for (const [slot, a] of want) {
      let inst = running.get(slot);
      if (inst) inst.update(a);
      else running.set(slot, (inst = AMBIENT[a.engine](env, a)));
      inst.layer.setLevel(LAYER_LEVEL[a.engine + (a.variant ? `.${a.variant}` : "")] ?? 1);
      inst.layer.setIndoor(!!a.indoor);
    }
  }

  return {
    ctx,
    mix,
    master,
    duckGain,
    hushGain,
    musicPauseGain,
    get timing(){return {...timing,...seq.timing};},
    musicLevel(){musicMeter.getFloatTimeDomainData(meterData); return Math.sqrt(meterData.reduce((n,x)=>n+x*x,0)/meterData.length);},
    pauseMusic(on, sec = 1.5) {
      const g = musicPauseGain.gain, t = ctx.currentTime;
      g.cancelAndHoldAtTime(t);
      g.linearRampToValueAtTime(on ? 0 : 1, t + Math.max(0.01,sec));
    },
    hush(on, sec = 2) {
      const g = hushGain.gain, t = ctx.currentTime;
      g.cancelAndHoldAtTime(t);
      g.linearRampToValueAtTime(on ? 0 : 1, t + Math.max(0.01, sec));
    },
    /** Applies a normalized segment (score.js): music next bar, ambience crossfades, space changes smoothly. */
    setScene(s) {
      applyScene(s, true);
    },
    /** Adjust atmosphere without resetting the sequencer's chord position. */
    updateScene(s) {
      applyScene(s, false);
    },
    sfx(type, p1 = 0.7) {
      // Keep intentional silence as a duck (no generated sound).
      if (type === "sudden_silence") { duck(duckGain.gain, ctx.currentTime + 0.02); return; }
      const pan = ctx.createStereoPanner();
      pan.pan.value = rand(-0.28, 0.28);
      pan.connect(sfxLayer);
      playSfx({ ctx, noise, out: pan }, type, ctx.currentTime + rand(0.02, 0.12), p1);
    },
    stopSfx(sec = 0.15) {
      clearSfx(sec);
    },
    get scene() {
      return seq.scene;
    },
    get piece() {
      return seq.piece;
    },
    stopAll() {
      seq.stop();
      clearSfx(0.05);
      for (const inst of running.values()) inst.stop();
      running.clear();
    },
    close() {
      clearInterval(timer);
      return ctx.close();
    },
  };
}

/** 0.3 s dip. Restores to 1 so overlapping calls never stick at silence. */
function duck(g, t) {
  g.cancelScheduledValues(t);
  g.setTargetAtTime(0.0001, t, 0.015);
  g.setTargetAtTime(1, t + 0.3, 0.08);
}

/**
 * A gain fading in from silence; stop() fades out and disconnects after. Unless `steady`, the layer breathes: its level
 * wanders every few seconds and now and then drops away briefly, so a bed never sounds like a fixed loop.
 * setLevel() applies the measured per-sound trim; setIndoor() hears the layer through a wall: low-pass, a little
 * quieter, plus a short room reverb.
 */
function layer(env, level, steady = false) {
  const { ctx } = env;
  const g = ctx.createGain();
  g.gain.value = 0;
  ramp(g.gain, level, ctx.currentTime);
  const occ = ctx.createBiquadFilter();
  occ.type = "lowpass";
  occ.frequency.value = 20000;
  occ.Q.value = 0.5;
  const trim = ctx.createGain();
  const swell = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = 0;
  g.connect(occ).connect(trim).connect(swell).connect(env.bus.ambience);
  swell.connect(send).connect(env.roomSend);
  const sources = [];
  let norm = null, indoor = false;
  const setTrim = (tc) => ramp(trim.gain, (norm ?? 1) * (indoor ? 0.7 : 1), ctx.currentTime, tc);
  let next = ctx.currentTime + rand(2, 5);
  const breathe = (h) => {
    while (next < h) {
      const lull = Math.random() < 0.12;
      swell.gain.setTargetAtTime(lull ? rand(0.12, 0.3) : rand(0.6, 1.15), next, lull ? 0.6 : rand(1, 2.5));
      next += lull ? rand(1.5, 3.5) : rand(3, 9);
    }
  };
  if (!steady) env.ticks.add(breathe);
  return {
    g,
    own: (s) => (sources.push(s), s),
    setLevel(x) {
      if (norm === null) trim.gain.value = x * (indoor ? 0.7 : 1);
      norm = x;
      setTrim(0.5);
    },
    setIndoor(on) {
      if (on === indoor) return;
      indoor = on;
      const t = ctx.currentTime;
      ramp(occ.frequency, on ? 1600 : 20000, t, 0.35);
      ramp(send.gain, on ? 0.45 : 0, t, 0.35);
      setTrim(0.35);
    },
    fadeOut(extra = () => {}) {
      env.ticks.delete(breathe);
      ramp(g.gain, 0, ctx.currentTime, 0.6);
      setTimeout(() => {
        for (const s of sources) s.stop?.();
        g.disconnect();
        occ.disconnect();
        swell.disconnect();
        send.disconnect();
        extra();
      }, 5000);
    },
  };
}

/** Per-sound level trims, measured by rendering each sound alone and matching loudness with peaks capped. */
const LAYER_LEVEL = {
  "aero.blizzard": 0.66,
  "aero.breeze": 0.63,
  "aero.wind": 0.67,
  "bio.cicada": 2.13,
  "bio.cricket": 1.62,
  "bio.crow": 0.55,
  "bio.owl": 1.08,
  "bio.seagull": 1.01,
  "bio.songbird": 0.5,
  "bio.wolf": 0.49,
  "cave": 1.07,
  "fire": 0.4,
  "hooves.carriage": 0.76,
  "hooves.trot": 1.32,
  "particle.glass": 0.6,
  "particle.leaf": 0.72,
  "particle.metal": 0.61,
  "particle.soil": 0.65,
  "psycho": 0.3,
  "room": 0.29,
  "ship": 1.72,
  "storm.close": 0.85,
  "storm.distant": 1.01,
  "tavern": 1.44,
  "urban.cabin": 0.84,
  "urban.cafe": 2.51,
  "urban.clockwork": 1.69,
  "urban.crowd": 2.7,
  "urban.kitchen": 2.82,
  "urban.traffic": 2.29,
  "water.stream": 0.82,
  "water.underwater": 0.67,
  "water.waterfall": 0.45,
  "water.waves": 0.44
};

// ---- ambience engines: (env, params) → { variant, update(params), stop() } ----

const AMBIENT = {
  /** Wind: pink noise through a randomly gusting bandpass, plus two narrow resonances for howling. */
  aero(env, a) {
    const { ctx } = env;
    const L = layer(env, 0);
    const src = L.own(env.loop("pink"));
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 300 + a.p1 * 1100;
    const body = ctx.createGain();
    body.gain.value = 0.7;
    src.connect(band).connect(body).connect(L.g);
    const howlG = ctx.createGain();
    howlG.connect(L.g);
    // each howl drifts on its own slow LFO, depth ±25% so the centre never nears 0 Hz
    for (const [f, j] of [
      [420, 60],
      [690, 90],
    ]) {
      const h = ctx.createBiquadFilter();
      h.type = "bandpass";
      h.Q.value = 15;
      h.frequency.value = f + rand(-j, j);
      const lfo = L.own(ctx.createOscillator());
      lfo.frequency.value = rand(0.03, 0.11);
      const depth = ctx.createGain();
      depth.gain.value = 0.25 * h.frequency.value;
      lfo.connect(depth).connect(h.frequency);
      lfo.start();
      src.connect(h).connect(howlG);
    }
    let p = a,
      next = ctx.currentTime;
    // gusts: a random walk at random intervals instead of a metronomic sine
    const tick = (h) => {
      while (next < h) {
        band.frequency.setTargetAtTime(
          (300 + p.p1 * 1100) * rand(0.6, 1.4),
          next,
          rand(0.4, 1.4),
        );
        body.gain.setTargetAtTime(
          0.7 + 0.3 * p.p1 * rand(-1, 1),
          next,
          rand(0.4, 1.4),
        );
        next += rand(1, 4) * (1.3 - p.p3 * 0.6); // p3 gustiness: higher = faster gusts
      }
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      const t = ctx.currentTime;
      const breeze = x.variant === "breeze";
      const blizzard = x.variant === "blizzard";
      ramp(band.Q, breeze ? 0.5 + x.p1 * 0.4 : blizzard ? 1.4 + x.p1 * 1.4 : 0.8 + x.p1, t);
      ramp(howlG.gain, breeze ? x.p2 * 0.35 : blizzard ? (0.4 + x.p2) * 1.8 : x.p2 * 1.5, t);
      // levels trimmed so wind sits under the music at the default mix
      ramp(L.g.gain, (breeze ? 1 : blizzard ? 0.5 : 0.65) * ((breeze ? 0.18 : blizzard ? 0.35 : 0.25) + x.p1 * (breeze ? 0.55 : 0.9)), t);
    };
    set(a);
    return { variant: a.variant, update: set, glides: true, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },

  /** Water (ocean waves, flowing stream, underwater depth, roaring waterfall). */
  water(env, a) {
    const { ctx } = env;
    const L = layer(env, 0);
    const kind = a.variant ?? "waves";
    const src = L.own(env.loop(kind === "underwater" ? "brown" : "pink"));
    const filter = ctx.createBiquadFilter();
    filter.type = kind === "stream" ? "bandpass" : "lowpass";
    filter.frequency.value = kind === "underwater" ? 220 : kind === "stream" ? 900 : kind === "waterfall" ? 1600 : 450;
    filter.Q.value = kind === "stream" ? 1.4 : 0.9;
    const body = ctx.createGain();
    body.gain.value = 0.6;
    src.connect(filter).connect(body).connect(L.g);
    let p = a, next = ctx.currentTime;
    const tick = (h) => {
      while (next < h) {
        if (kind === "waves") {
          const cycle = rand(4.5, 8) * (1.2 - p.p2 * 0.4);
          const crest = next + cycle * 0.42;
          filter.frequency.setTargetAtTime(280 + p.p1 * 900, next, cycle * 0.18);
          body.gain.setTargetAtTime(0.35 + p.p1 * 0.65, next, cycle * 0.18);
          filter.frequency.setTargetAtTime(140 + p.p3 * 120, crest, cycle * 0.25);
          body.gain.setTargetAtTime(0.12 + p.p1 * 0.18, crest, cycle * 0.25);
          next += cycle;
        } else if (kind === "stream") {
          filter.frequency.setTargetAtTime((650 + p.p1 * 900) * rand(0.75, 1.3), next, rand(0.08, 0.22));
          body.gain.setTargetAtTime(0.35 + p.p1 * 0.45 * rand(0.7, 1.2), next, rand(0.08, 0.2));
          next += rand(0.12, 0.35);
        } else if (kind === "waterfall") {
          filter.frequency.setTargetAtTime((1200 + p.p1 * 1100) * rand(0.85, 1.15), next, rand(0.25, 0.6));
          body.gain.setTargetAtTime(0.5 + p.p1 * 0.35 * rand(0.85, 1.1), next, rand(0.25, 0.6));
          next += rand(0.4, 0.9);
        } else {
          filter.frequency.setTargetAtTime(140 + p.p1 * 180 * rand(0.8, 1.25), next, rand(0.8, 1.8));
          next += rand(1.5, 3.2);
        }
      }
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      ramp(L.g.gain, ({ waterfall: 0.5, waves: 0.7, underwater: 0.7 }[kind] ?? 1) * (0.28 + x.p1 * 0.65), ctx.currentTime);
    };
    set(a);
    return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },

  /** Urban / indoor settings: cafe murmur, street traffic, airplane/train cabin drone, kitchen simmer. */
  urban(env, a) {
    const { ctx } = env;
    const L = layer(env, 0);
    const kind = a.variant ?? "cafe";
    const src = L.own(env.loop(kind === "cabin" || kind === "traffic" ? "brown" : "pink"));
    const f = ctx.createBiquadFilter();
    f.type = kind === "cabin" ? "lowpass" : "bandpass";
    f.frequency.value = kind === "cabin" ? 180 : kind === "traffic" ? 320 : kind === "kitchen" ? 1800 : 480;
    f.Q.value = kind === "kitchen" ? 1.2 : 0.8;
    const bed = ctx.createGain();
    bed.gain.value = kind === "cabin" || kind === "traffic" ? 0.4 : 0.22;
    src.connect(f).connect(bed).connect(L.g);
    if (kind === "cabin") {
      const hum = L.own(ctx.createOscillator());
      hum.type = "triangle";
      hum.frequency.value = 88;
      const hg = ctx.createGain();
      hg.gain.value = 0.06;
      hum.connect(hg).connect(L.g);
      hum.start();
    }
    let p = a, next = ctx.currentTime + 0.3;
    const tick = (h) => {
      while (next < h) {
        if (kind === "cafe") {
          f.frequency.setTargetAtTime(380 + p.p1 * 320 * rand(0.75, 1.3), next, rand(0.3, 0.9));
          if (Math.random() < 0.45 * (0.4 + p.p2)) modal({ ...env, out: L.g }, next, rand(0.05, 0.12), [1, 2.4, 4.1], rand(1600, 2600), 0.12, L.g);
          next += rand(0.4, 1.4);
        } else if (kind === "kitchen") {
          f.frequency.setTargetAtTime(1400 + p.p1 * 1200 * rand(0.8, 1.25), next, rand(0.1, 0.3));
          if (Math.random() < 0.3 * (0.4 + p.p2)) modal({ ...env, out: L.g }, next, 0.09, [1, 2.6, 4.8], rand(700, 1800), 0.09, L.g);
          next += rand(0.35, 0.9);
        } else if (kind === "traffic") {
          f.frequency.setTargetAtTime((240 + p.p1 * 450) * rand(0.65, 1.45), next, rand(0.6, 1.6));
          next += rand(1.2, 3.0);
        } else if (kind === "crowd") {
          f.frequency.setTargetAtTime((420 + p.p1 * 480) * rand(0.75, 1.3), next, rand(0.2, 0.5));
          next += rand(0.3, 0.8);
        } else if (kind === "clockwork") {
          if (Math.random() < 0.7) modal({ ...env, out: L.g }, next, 0.07, [1, 2.9, 5.4], rand(1800, 3200), 0.04, L.g);
          next += 0.25 + (1 - p.p2) * 0.25;
        } else {
          f.frequency.setTargetAtTime(150 + p.p1 * 90 * rand(0.9, 1.1), next, 1.2);
          next += rand(1.5, 3.0);
        }
      }
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      ramp(L.g.gain, (0.22 + x.p1 * 0.55) * (1 - x.p3 * 0.4), ctx.currentTime);
    };
    set(a);
    return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },
};

// ---- v2 ambience (improved after listening tests) ----

/** v2 rain: the body of rain is a broadband wash; near drops are sub-2 ms high-passed ticks; a few surface accents
 *  give the material. (v1 drops were resonant noise bursts — at 600 Hz they sounded like lip pops.) */
function rain(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const MAT = {
    glass: { hp: 450, lp: 7500, tick: 2600 },
    metal: { hp: 400, lp: 6500, tick: 2200 },
    soil: { hp: 250, lp: 5000, tick: 1500 },
    leaf: { hp: 400, lp: 6500, tick: 2400 },
  };
  let p = a, m = MAT[a.variant] ?? MAT.soil;
  const bedHp = ctx.createBiquadFilter(); bedHp.type = "highpass"; bedHp.frequency.value = m.hp; bedHp.Q.value = 0.5;
  const bedLp = ctx.createBiquadFilter(); bedLp.type = "lowpass"; bedLp.frequency.value = m.lp; bedLp.Q.value = 0.5;
  const bed = ctx.createGain();
  L.own(env.loop("pink")).connect(bedHp).connect(bedLp).connect(bed).connect(L.g);
  const patHp = ctx.createBiquadFilter(); patHp.type = "highpass"; patHp.frequency.value = m.tick; patHp.Q.value = 0.6;
  const patLp = ctx.createBiquadFilter(); patLp.frequency.value = 9000;
  const pat = ctx.createGain();
  pat.connect(patHp).connect(patLp).connect(L.g);
  const acc = ctx.createGain();
  acc.connect(L.g);
  const pans = [-0.7, -0.3, 0.3, 0.7].map((x) => { const pn = ctx.createStereoPanner(); pn.pan.value = x; pn.connect(pat); return pn; });
  const accPan = ctx.createStereoPanner(); accPan.connect(acc);
  let next = ctx.currentTime, nextA = ctx.currentTime + 0.2, k = 0;
  const grain = (t, v, len, out) => {
    const s = ctx.createBufferSource(); s.buffer = env.noise.white;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(g).connect(out);
    s.start(t, rand(0, 3.5), len + 0.005);
    return g;
  };
  const accent = (t) => {
    accPan.pan.setValueAtTime(rand(-0.6, 0.6), t);
    const kind = p.variant;
    if (kind === "glass") {
      // a drop tapping the pane: bright click + a very faint short ring
      const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 3000; f.connect(accPan);
      grain(t, rand(0.15, 0.35), rand(0.0008, 0.002), f);
      const o = ctx.createOscillator(); o.frequency.value = rand(4500, 7000);
      const g = ctx.createGain(); g.gain.setValueAtTime(rand(0.006, 0.014), t); g.gain.exponentialRampToValueAtTime(0.0001, t + rand(0.008, 0.016));
      o.connect(g).connect(accPan); o.start(t); o.stop(t + 0.03);
    } else if (kind === "metal") {
      const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2000; f.connect(accPan);
      grain(t, rand(0.12, 0.3), rand(0.001, 0.003), f);
      modal({ ...env, out: accPan }, t, rand(0.05, 0.1), [1, 2.76, 5.4], rand(2200, 3600), 0.05, accPan);
    } else if (kind === "leaf") {
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = rand(2800, 4500); f.Q.value = 0.9; f.connect(accPan);
      grain(t, rand(0.15, 0.3), rand(0.003, 0.008), f);
    } else {
      // a drop landing on wet ground: soft, broadband "pat" — centred well above the lip-pop range
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = rand(1600, 2600); f.Q.value = 0.7; f.connect(accPan);
      const s = ctx.createBufferSource(); s.buffer = env.noise.pink;
      const g = ctx.createGain(); const len = rand(0.008, 0.02);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(rand(0.08, 0.16), t + 0.0015); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      s.connect(g).connect(f); s.start(t, rand(0, 10), len + 0.01);
    }
  };
  const tick = (h) => {
    const rate = Math.min(800, 40 * 20 ** p.p1);
    let n = 0;
    while (next < h && n++ < 80) {
      const v = (0.02 + 0.22 * Math.random() ** 3) * (0.5 + p.p2) / Math.sqrt(rate / 100);
      grain(next, v, rand(0.0004, 0.0015) * (1 + p.p2 * 1.5), pans[k++ % 4]);
      next += -Math.log(1 - Math.random()) / rate;
    }
    if (next < ctx.currentTime) next = ctx.currentTime;
    while (nextA < h) { accent(nextA); nextA += -Math.log(1 - Math.random()) / (1 + p.p1 * 10); }
  };
  env.ticks.add(tick);
  const set = (x) => {
    if (x.variant !== p.variant) {
      m = MAT[x.variant] ?? MAT.soil;
      const t = ctx.currentTime;
      ramp(bedHp.frequency, m.hp, t, 0.8); ramp(bedLp.frequency, m.lp, t, 0.8); ramp(patHp.frequency, m.tick, t, 0.8);
    }
    p = x;
    ramp(bed.gain, 0.05 + x.p1 * 0.3, ctx.currentTime);
    ramp(L.g.gain, 0.8, ctx.currentTime);
  };
  set(a);
  return { get variant() { return p.variant; }, glides: true, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #1: fire as its own generator, so it can sit under rain. Roar + gas hiss + power-law crackles and occasional pops. */
function fireBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const roarF = ctx.createBiquadFilter();
  roarF.type = "lowpass"; roarF.frequency.value = 260;
  const roar = ctx.createGain(); roar.gain.value = 0.5;
  L.own(env.loop("brown")).connect(roarF).connect(roar).connect(L.g);
  const hissF = ctx.createBiquadFilter();
  hissF.type = "bandpass"; hissF.frequency.value = 2200; hissF.Q.value = 0.7;
  const hiss = ctx.createGain(); hiss.gain.value = 0.03;
  L.own(env.loop("pink")).connect(hissF).connect(hiss).connect(L.g);
  const crackOut = ctx.createGain();
  crackOut.connect(L.g);
  let p = a, next = ctx.currentTime + 0.1, flick = ctx.currentTime;
  const crack = (t, big) => {
    const s = ctx.createBufferSource();
    s.buffer = env.noise.white;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = big ? rand(700, 1600) : rand(1800, 6000);
    f.Q.value = big ? 3 : rand(1, 4);
    const g = ctx.createGain();
    const amp = (big ? 0.7 : 0.03 + 0.35 * Math.random() ** 2.2) * (0.6 + p.p2 * 0.8);
    const len = big ? rand(0.012, 0.03) : rand(0.002, 0.008);
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const pn = ctx.createStereoPanner();
    pn.pan.value = rand(-0.5, 0.5);
    s.connect(f).connect(g).connect(pn).connect(crackOut);
    s.start(t, rand(0, 3), len + 0.01);
    if (big) modal({ ...env, out: crackOut }, t, 0.45 * (0.6 + p.p2 * 0.8), [1, 2.4, 3.9], rand(250, 500), 0.05, crackOut);
  };
  const tick = (h) => {
    let n = 0;
    while (next < h && n++ < 40) {
      const rate = 4 + p.p1 * 30;
      crack(next, Math.random() < 0.03 + p.p2 * 0.05);
      if (Math.random() < 0.25) { const m = Math.floor(rand(1, 4)); for (let i = 1; i <= m; i++) crack(next + i * rand(0.01, 0.04), false); }
      next += -Math.log(1 - Math.random()) / rate;
    }
    if (next < ctx.currentTime) next = ctx.currentTime;
    while (flick < h) {
      roar.gain.setTargetAtTime((0.35 + p.p1 * 0.5) * rand(0.7, 1.2), flick, 0.3);
      roarF.frequency.setTargetAtTime((200 + p.p1 * 200) * rand(0.7, 1.3), flick, 0.4);
      flick += rand(0.3, 0.9);
    }
  };
  env.ticks.add(tick);
  const set = (x) => {
    p = x;
    ramp(L.g.gain, 0.8 * (1 - x.p3 * 0.5), ctx.currentTime);
    ramp(hiss.gain, 0.015 + x.p1 * 0.04, ctx.currentTime);
  };
  set(a);
  return { variant: a.variant, glides: true, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #6: animals rebuilt with phrases, harmonics, vowel filters and breath noise; #1: one instance per species. */
function animalVoices(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const dist = ctx.createBiquadFilter();
  dist.type = "lowpass"; dist.frequency.value = 12000;
  const pan = ctx.createStereoPanner();
  dist.connect(pan).connect(L.g);
  pan.pan.value = rand(-0.8, 0.8);
  const kind = a.variant;
  let p = a, next = ctx.currentTime + rand(0.3, 1.2), chirps = 0, restAt = 3 + Math.floor(rand(0, 6));
  const osc = (type, f, t, end) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    o.start(t); o.stop(end + 0.05);
    return o;
  };
  const envGain = (t, peak, atk, len) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    return g;
  };
  const breath = (t, len, f, q, amp, out) => {
    const s = ctx.createBufferSource(); s.buffer = env.noise.pink;
    const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = f; b.Q.value = q;
    const g = ctx.createGain(); g.gain.value = amp;
    s.connect(b).connect(g).connect(out);
    s.start(t, rand(0, 8), len + 0.05);
  };
  const calls = {
    songbird(t) {
      const base = 2600 + p.p1 * 2200;
      const n = 3 + Math.floor(rand(0, 5));
      const shape = ["up", "down", "trill", "whistle"][Math.floor(rand(0, 4))];
      let at = t;
      for (let i = 0; i < n; i++) {
        const len = shape === "trill" ? rand(0.12, 0.2) : rand(0.04, 0.12);
        const f0 = base * rand(0.85, 1.2) * (shape === "whistle" ? 1 - i * 0.03 : 1);
        const g = envGain(at, 0.07 * rand(0.6, 1), 0.008, len);
        g.connect(dist);
        const o = osc("sine", f0, at, at + len);
        const o2 = osc("sine", f0 * 2, at, at + len);
        const h2 = ctx.createGain(); h2.gain.value = 0.12;
        if (shape === "up") { o.frequency.exponentialRampToValueAtTime(f0 * 1.35, at + len); o2.frequency.exponentialRampToValueAtTime(f0 * 2.7, at + len); }
        else if (shape === "down") { o.frequency.exponentialRampToValueAtTime(f0 * 0.7, at + len); o2.frequency.exponentialRampToValueAtTime(f0 * 1.4, at + len); }
        else if (shape === "trill") {
          const m = osc("sine", rand(28, 45), at, at + len);
          const md = ctx.createGain(); md.gain.value = f0 * 0.09;
          m.connect(md).connect(o.frequency);
        } else o.frequency.linearRampToValueAtTime(f0 * 1.04, at + len);
        o.connect(g); o2.connect(h2).connect(g);
        at += len + rand(0.02, 0.08);
      }
      return at - t;
    },
    owl(t) {
      const f = (330 + p.p1 * 90) * rand(0.97, 1.03);
      const pattern = Math.random() < 0.5 ? [0.45, 0.2, 0.2] : [0.5, 0.35];
      let at = t;
      const lp = ctx.createBiquadFilter(); lp.frequency.value = 1300; lp.connect(dist);
      for (const len of pattern) {
        const g = envGain(at, 0.14, 0.07, len);
        g.connect(lp);
        const o = osc("sine", f, at, at + len);
        o.frequency.linearRampToValueAtTime(f * 0.93, at + len);
        o.connect(g);
        breath(at, len, f, 7, 0.25, g);
        at += len + rand(0.12, 0.22);
      }
      return at - t;
    },
    wolf(t, k = 1, far = 0) {
      // "a-oooo": the mouth opens on an "a" (high F1/F2), then closes into "u" while the pitch holds and wavers.
      const len = rand(2, 3.2), f = (300 + p.p1 * 120) * rand(0.95, 1.05) * k;
      const g = ctx.createGain();
      const peak = 0.17 * (1 - far * 0.5);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.18);
      g.gain.setValueAtTime(peak, t + len * 0.25);
      g.gain.linearRampToValueAtTime(peak * 0.8, t + len - 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      const farF = ctx.createBiquadFilter(); farF.frequency.value = 3200 - far * 1800;
      g.connect(farF).connect(dist);
      const open = 0.08 * len, closed = 0.45 * len;
      const formants = [[780, 420, 7, 1], [1250, 820, 8, 0.6], [2600, 2300, 9, 0.2]].map(([fa, fu, q, w]) => {
        const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.Q.value = q;
        b.frequency.setValueAtTime(fa, t);
        b.frequency.setValueAtTime(fa, t + open);
        b.frequency.exponentialRampToValueAtTime(fu, t + closed);
        const wg = ctx.createGain(); wg.gain.value = w;
        b.connect(wg).connect(g);
        return b;
      });
      const saw = osc("sawtooth", f * 0.7, t, t + len), sn = osc("sine", f * 0.7, t, t + len);
      for (const o of [saw, sn]) {
        o.frequency.exponentialRampToValueAtTime(f * 1.12, t + 0.35);          // scoop up into the note
        o.frequency.exponentialRampToValueAtTime(f * 1.3, t + len * 0.45);
        o.frequency.setValueAtTime(f * 1.3, t + len * 0.7);
        o.frequency.exponentialRampToValueAtTime(f * 0.78, t + len);            // fall away at the end
      }
      const vib = osc("sine", rand(4.5, 5.5), t, t + len);
      const vd = ctx.createGain();
      vd.gain.setValueAtTime(0, t);
      vd.gain.linearRampToValueAtTime(f * 0.02, t + len * 0.8);
      vib.connect(vd); vd.connect(saw.frequency); vd.connect(sn.frequency);
      // brighter source while the mouth is open, darker as it closes
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.9, t);
      sg.gain.linearRampToValueAtTime(0.55, t + closed);
      saw.connect(sg);
      for (const b of formants) { sg.connect(b); sn.connect(b); }
      for (const b of formants) breath(t, len, 700, 1, 0.1, b);
      // sometimes a second wolf answers, higher and farther away
      if (k === 1 && Math.random() < 0.4) calls.wolf(t + rand(0.7, 1.6), rand(1.15, 1.35), rand(0.4, 0.7));
      return len;
    },
    crow(t) {
      let at = t;
      const n = 2 + (Math.random() < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const len = rand(0.25, 0.38), f = rand(500, 620);
        const g = envGain(at, 0.55, 0.02, len);
        const am = ctx.createGain(); am.gain.value = 0.6;
        const rasp = osc("square", rand(60, 80), at, at + len);
        const rd = ctx.createGain(); rd.gain.value = 0.4;
        rasp.connect(rd).connect(am.gain);
        am.connect(g);
        for (const [ff, q] of [[1100, 4], [1800, 5]]) {
          const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = ff; b.Q.value = q;
          b.connect(dist); g.connect(b);
        }
        const o = osc("sawtooth", f, at, at + len);
        o.frequency.linearRampToValueAtTime(f * 1.06, at + 0.04);
        o.frequency.exponentialRampToValueAtTime(f * 0.78, at + len);
        o.connect(am);
        breath(at, len, 1400, 2, 0.3, am);
        at += len + rand(0.12, 0.22);
      }
      return at - t;
    },
    seagull(t) {
      const len = rand(0.35, 0.65), base = 1400 + p.p1 * 900;
      const g = envGain(t, 0.09, 0.04, len);
      g.connect(dist);
      const o = osc("triangle", base, t, t + len);
      o.frequency.linearRampToValueAtTime(base * 1.25, t + len * 0.25);
      o.frequency.exponentialRampToValueAtTime(base * 0.68, t + len);
      const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = 2200; b.Q.value = 1.2;
      o.connect(g); o.connect(b).connect(g);
      return len;
    },
    insect(t, cicada) {
      const base = cicada ? 4800 + p.p1 * 1200 : 4200 + p.p1 * 800;
      const len = cicada ? rand(0.6, 1.3) : 0.25;
      const g = envGain(t, 0.06, 0.01, len);
      g.connect(dist);
      const o = osc("sine", base, t, t + len);
      const am = osc("sine", cicada ? 95 + p.p2 * 60 : 30 + p.p2 * 30, t, t + len);
      const ag = ctx.createGain(); ag.gain.value = 0.5;
      const amG = ctx.createGain(); amG.gain.value = 0.5;
      am.connect(ag).connect(amG.gain);
      o.connect(amG).connect(g);
      return len;
    },
  };
  const tick = (h) => {
    while (next < h) {
      const len = kind === "cricket" ? calls.insect(next, false) : kind === "cicada" ? calls.insect(next, true) : calls[kind](next);
      if (kind !== "cricket") pan.pan.setValueAtTime(rand(-0.8, 0.8), next);
      const phraseEnd = Math.random() < 0.25;
      let gap;
      if (kind === "cricket" || kind === "cicada") {
        gap = kind === "cicada" ? rand(0.15, 0.45) : 0.35 * rand(0.8, 1.2);
        if (++chirps >= restAt) { gap += rand(0.8, 2); chirps = 0; restAt = 3 + Math.floor(rand(0, 6)); }
      } else if (kind === "wolf") gap = rand(4, 9);
      else if (kind === "crow") gap = rand(2.2, 5.5);
      else if (kind === "owl") gap = rand(3, 7);
      else if (kind === "seagull") gap = phraseEnd ? rand(2.5, 6) : rand(0.4, 0.9);
      else gap = 0.6 + (1 - p.p2) * 3 * rand(0.5, 1.5);
      next += len + gap;
    }
  };
  env.ticks.add(tick);
  const set = (x) => {
    p = x;
    ramp(L.g.gain, 2.5 * (0.3 + (1 - x.p3) * 0.7), ctx.currentTime);
    ramp(dist.frequency, 12000 - x.p3 * 9000, ctx.currentTime);
  };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** v2 animals. Real birdsong is fast: syllables of 20–60 ms sweeping thousands of Hz, repeated in a fixed song that
 *  each bird sings again and again. Three virtual birds per layer, each with its own species, pitch, place and song. */
function animals(env, a) {
  // Owl, wolf, crow and cicada keep the v1 voices.
  if (!["songbird", "seagull", "cricket"].includes(a.variant)) return animalVoices(env, a);
  const { ctx } = env;
  const L = layer(env, 0);
  const kind = a.variant;
  let p = a;
  const verbSend = ctx.createGain(); verbSend.gain.value = 0.18; verbSend.connect(env.roomSend);
  const voiceOut = (pan, cutoff, level) => {
    const lp = ctx.createBiquadFilter(); lp.frequency.value = cutoff;
    const g = ctx.createGain(); g.gain.value = level;
    const pn = ctx.createStereoPanner(); pn.pan.value = pan;
    lp.connect(g).connect(pn); pn.connect(L.g); pn.connect(verbSend);
    return lp;
  };
  /** A pure whistle following keyframes [[fraction, Hz], …], with a faint 2nd harmonic. */
  const syllable = (t, keys, dur, amp, out, warble = 0) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + Math.min(0.004, dur * 0.2));
    g.gain.setValueAtTime(amp, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    for (const [mult, lvl] of [[1, 1], [2, 0.07]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(keys[0][1] * mult, t);
      for (const [fr, f] of keys.slice(1)) o.frequency.exponentialRampToValueAtTime(f * mult, t + fr * dur);
      if (warble) {
        const w = ctx.createOscillator(); w.frequency.value = rand(35, 55);
        const wd = ctx.createGain(); wd.gain.value = keys[0][1] * mult * warble;
        w.connect(wd).connect(o.frequency); w.start(t); w.stop(t + dur + 0.02);
      }
      const h = ctx.createGain(); h.gain.value = lvl;
      o.connect(h).connect(g); o.start(t); o.stop(t + dur + 0.02);
    }
  };
  const makeSong = (species, k) => {
    const notes = [];
    let at = 0;
    if (species === "warbler") {
      const A = [[0, rand(5800, 7500) * k], [0.45, rand(4200, 5200) * k], [1, rand(2800, 3600) * k]], durA = rand(0.03, 0.045);
      const B = [[0, rand(2800, 3400) * k], [1, rand(5200, 6200) * k]], durB = rand(0.04, 0.055);
      for (let i = 0, n = 3 + Math.floor(rand(0, 4)); i < n; i++) { notes.push({ at, keys: A, dur: durA, amp: 0.1 + i * 0.01 }); at += rand(0.065, 0.08); }
      at += 0.04;
      for (let i = 0, n = 2 + Math.floor(rand(0, 2)); i < n; i++) { notes.push({ at, keys: B, dur: durB, amp: 0.13 }); at += rand(0.085, 0.1); }
      notes.push({ at: at + 0.03, keys: [[0, 3800 * k], [0.3, 6600 * k], [1, 2600 * k]], dur: 0.075, amp: 0.14 });
    } else if (species === "wren") {
      const n = 10 + Math.floor(rand(0, 7)), f0 = rand(5800, 6600) * k;
      for (let i = 0; i < n; i++) { const f = f0 * (1 - i * 0.012); notes.push({ at, keys: [[0, f], [1, f * 0.68]], dur: 0.02, amp: 0.1 }); at += rand(0.055, 0.065); }
      notes.push({ at: at + 0.05, keys: [[0, 3200 * k], [0.5, 4800 * k], [1, 3600 * k]], dur: 0.09, amp: 0.12 });
    } else {
      // robin-like caroling: short phrases of rising and falling slurs
      const n = 3 + Math.floor(rand(0, 3));
      for (let i = 0; i < n; i++) {
        const lo = rand(1900, 2600) * k, hi = rand(3000, 3800) * k;
        const keys = Math.random() < 0.5 ? [[0, lo], [0.45, hi], [1, lo * 1.1]] : [[0, hi], [0.5, lo], [1, hi * 0.9]];
        notes.push({ at, keys, dur: rand(0.11, 0.2), amp: 0.11, warble: 0.02 });
        at += rand(0.19, 0.27);
      }
    }
    return { notes, len: at + 0.1 };
  };
  /** Gull: a nasal, raspy voice — sawtooth through nose-like formants with a rough amplitude flutter. */
  const gullVoice = (t, keys, dur, amp, out) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.025);
    g.gain.setValueAtTime(amp * 0.85, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 600;
    for (const [f, q, w] of [[1500, 3, 1], [2700, 4, 0.6], [4100, 5, 0.25]]) {
      const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = f; b.Q.value = q;
      const wg = ctx.createGain(); wg.gain.value = w;
      hp.connect(b).connect(wg).connect(g);
    }
    g.connect(out);
    const rough = ctx.createGain(); rough.gain.value = 0.7;
    const fl = ctx.createOscillator(); fl.type = "square"; fl.frequency.value = rand(45, 70);
    const fd = ctx.createGain(); fd.gain.value = 0.3;
    fl.connect(fd).connect(rough.gain);
    rough.connect(hp);
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(keys[0][1], t);
    for (const [fr, f] of keys.slice(1)) o.frequency.exponentialRampToValueAtTime(f, t + fr * dur);
    o.connect(rough);
    o.start(t); o.stop(t + dur + 0.02); fl.start(t); fl.stop(t + dur + 0.02);
  };
  const cricketChirp = (t, f, amp, out) => {
    const n = 3 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const at = t + i * rand(0.028, 0.034), len = rand(0.012, 0.016);
      const o = ctx.createOscillator(); o.frequency.value = f * rand(0.995, 1.005);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(amp, at + 0.003);
      g.gain.setValueAtTime(amp, at + len - 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g).connect(out); o.start(at); o.stop(at + len + 0.01);
    }
  };
  // Three singers, each with a fixed character.
  const species = ["warbler", "wren", "robin"].sort(() => Math.random() - 0.5);
  const singers = [0, 1, 2].map((i) => {
    const far = i === 0 ? rand(0, 0.25) : rand(0.3, 0.8);
    const s = { far, out: voiceOut(rand(-0.8, 0.8), 11000 - far * 6000, 1 - far * 0.55), next: ctx.currentTime + rand(0.3, 3), k: rand(0.88, 1.12), species: species[i] };
    if (kind === "songbird") s.songs = [makeSong(s.species, s.k), makeSong(s.species, s.k)];
    if (kind === "cricket") { s.f = rand(4300, 4900); s.period = rand(0.5, 0.8); }
    return s;
  });
  const sing = (s, t) => {
    if (kind === "songbird") {
      const song = s.songs[Math.random() < 0.7 ? 0 : 1];
      for (const nt of song.notes) syllable(t + nt.at, nt.keys, nt.dur, nt.amp, s.out, nt.warble ?? 0);
      return song.len + rand(1.2, 4) * (1.4 - p.p2 * 0.8);
    }
    if (kind === "seagull") {
      if (Math.random() < 0.45) {
        const n = 4 + Math.floor(rand(0, 4));
        for (let i = 0; i < n; i++) gullVoice(t + i * rand(0.17, 0.21), [[0, 950 * (1 - i * 0.02)], [0.4, 1180 * (1 - i * 0.02)], [1, 860]], rand(0.12, 0.15), 0.22 * (1 - i * 0.06), s.out);
        return n * 0.2 + rand(2, 6);
      }
      gullVoice(t, [[0, 700], [0.25, 1260], [1, 880]], rand(0.35, 0.5), 0.26, s.out);
      return rand(1.5, 5);
    }
    if (kind === "cricket") { cricketChirp(t, s.f, 0.05, s.out); return s.period * (1.3 - p.p2 * 0.5) * rand(0.97, 1.03); }
    return 1;
  };
  const active = kind === "seagull" ? singers.slice(0, 2) : singers;
  const tick = (h) => { for (const s of active) while (s.next < h) s.next += sing(s, s.next); };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, 2.5 * (0.3 + (1 - x.p3) * 0.7), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: a storm bed — rolling thunder that grumbles in several bumps; "close" adds a crack and brighter roll. */
function stormBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const airF = ctx.createBiquadFilter(); airF.frequency.value = 110;
  const air = ctx.createGain(); air.gain.value = 0.35;
  L.own(env.loop("brown")).connect(airF).connect(air).connect(L.g);
  let p = a, next = ctx.currentTime + rand(1, 3);
  const roll = (t) => {
    const close = p.variant === "close";
    const len = close ? rand(4, 7) : rand(5, 9);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown; s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(close ? 1400 : 420, t);
    lp.frequency.exponentialRampToValueAtTime(close ? 90 : 60, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const n = 3 + Math.floor(rand(0, 5));
    let at = t;
    for (let i = 0; i < n; i++) {
      g.gain.setTargetAtTime(0.9 * rand(0.4, 1) * (1 - (i / n) * 0.6), at, rand(0.05, 0.25));
      at += rand(0.3, 1.1);
    }
    g.gain.setTargetAtTime(0.0001, at, len * 0.2);
    const pn = ctx.createStereoPanner(); pn.pan.value = rand(-0.6, 0.6);
    s.connect(lp).connect(g).connect(pn).connect(L.g);
    s.start(t, rand(0, 8));
    s.stop(t + len + 3);
    if (close) noiseHit(env, t, 0.9, rand(1500, 3000), 0.14, 1, pn);
  };
  const tick = (h) => {
    while (next < h) { roll(next); next += rand(7, 20) * (1.4 - p.p1 * 0.9); }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, (x.variant === "close" ? 0.9 : 0.7) * (0.4 + x.p2 * 0.6) * (1 - x.p3 * 0.4), ctx.currentTime); };
  set(a);
  return { get variant() { return p.variant; }, glides: true, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: horses — a trot of paired hoof clops; "carriage" adds a wheel rumble, harness jingle and frame creaks. */
function hoovesBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const pan = ctx.createStereoPanner();
  pan.connect(L.g);
  const carriage = a.variant === "carriage";
  let wg = null;
  if (carriage) {
    const wf = ctx.createBiquadFilter(); wf.frequency.value = 170;
    wg = ctx.createGain(); wg.gain.value = 0.25;
    L.own(env.loop("brown")).connect(wf).connect(wg).connect(pan);
  }
  let p = a, next = ctx.currentTime + 0.2, panT = ctx.currentTime;
  const clop = (t, k) => {
    modal({ ...env, out: pan }, t, 0.6 * k, [1, 2.25, 3.7, 5.2], rand(420, 560) * (0.9 + p.p2 * 0.3), 0.05 + (1 - p.p2) * 0.04, pan);
    noiseHit(env, t, 0.25 * k * (0.5 + p.p2), rand(1500, 2600), 0.03, 1.5, pan);
  };
  const creak = (t) => {
    const len = rand(0.5, 0.9);
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(rand(12, 20), t);
    o.frequency.linearRampToValueAtTime(rand(18, 30), t + len);
    const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = rand(380, 520); b.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.35, t + len * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(b).connect(g).connect(pan);
    o.start(t); o.stop(t + len + 0.05);
  };
  const tick = (h) => {
    const step = 0.62 - p.p1 * 0.22;
    while (next < h) {
      const k = rand(0.75, 1.1);
      clop(next, k);
      clop(next + rand(0.035, 0.06), k * rand(0.6, 0.85));
      if (carriage) {
        wg.gain.setTargetAtTime(0.18 + 0.14 * Math.random(), next, 0.08);
        if (Math.random() < 0.06) creak(next + rand(0, step));
        if (Math.random() < 0.15) modal({ ...env, out: pan }, next + 0.02, 0.12, [1, 2.4, 3.9], rand(3000, 4200), 0.08, pan, true);
      }
      next += (step / 2) * rand(0.95, 1.05);
    }
    while (panT < h) { pan.pan.setTargetAtTime(rand(-0.4, 0.4), panT, 2); panT += rand(3, 6); }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, (0.55 + x.p2 * 0.5) * (1 - x.p3 * 0.5), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: tavern — a babble of four moving voice bands, mug clinks, table thuds and the odd burst of distant laughter. */
function tavernBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const src = L.own(env.loop("pink"));
  const voices = [300, 520, 900, 1500].map((f) => {
    const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = f; b.Q.value = 3;
    const g = ctx.createGain(); g.gain.value = 0.15;
    src.connect(b).connect(g).connect(L.g);
    return { b, g, f };
  });
  const evOut = ctx.createGain(); evOut.connect(L.g);
  let p = a, nextV = ctx.currentTime, nextE = ctx.currentTime + 0.5;
  const laugh = (t) => {
    const lp = ctx.createBiquadFilter(); lp.frequency.value = 2500; lp.connect(evOut);
    const n = 3 + Math.floor(rand(0, 3)), f0 = rand(170, 260);
    for (let i = 0; i < n; i++) {
      const at = t + i * rand(0.13, 0.17), len = 0.11;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.12 * (1 - i * 0.12), at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      for (const [ff, q] of [[750, 4], [1250, 5]]) {
        const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = ff; b.Q.value = q;
        b.connect(lp); g.connect(b);
      }
      const o = ctx.createOscillator(); o.type = "sawtooth";
      o.frequency.setValueAtTime(f0 * (1 - i * 0.04) * 1.1, at);
      o.frequency.exponentialRampToValueAtTime(f0 * (1 - i * 0.04) * 0.9, at + len);
      o.connect(g); o.start(at); o.stop(at + len + 0.02);
    }
  };
  const tick = (h) => {
    while (nextV < h) {
      for (const v of voices) {
        v.b.frequency.setTargetAtTime(v.f * rand(0.75, 1.3), nextV, rand(0.05, 0.15));
        v.g.gain.setTargetAtTime(rand(0.05, 0.35) * (0.5 + p.p1), nextV, rand(0.04, 0.12));
      }
      nextV += rand(0.09, 0.22);
    }
    while (nextE < h) {
      const r = Math.random();
      const o = { ...env, out: evOut };
      if (r < 0.3) {
        // mugs touching: a dull, short ceramic tap (v1 used a ringing glass model that sounded like a bell)
        modal(o, nextE, rand(0.1, 0.18), [1, 2.6, 4.9], rand(1400, 2200), 0.05, evOut);
        if (Math.random() < 0.4) modal(o, nextE + rand(0.03, 0.08), rand(0.06, 0.12), [1, 2.6], rand(1500, 2300), 0.04, evOut);
      } else if (r < 0.8) modal(o, nextE, rand(0.3, 0.5), [1, 2.6, 4.1], rand(140, 220), 0.12, evOut);
      else if (Math.random() < 0.4 + p.p2 * 0.6) laugh(nextE);
      nextE += rand(0.6, 2.2) * (1.3 - p.p2 * 0.6);
    }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, (0.35 + x.p1 * 0.5) * (1 - x.p3 * 0.4), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: cave — water drops that "plink" upward into a long private reverb, over a low hum and a resonant air tone. */
function caveBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 3.8);
  const wet = ctx.createGain(); wet.gain.value = 0.9;
  const dry = ctx.createGain(); dry.gain.value = 0.5;
  const drops = ctx.createGain();
  drops.connect(dry).connect(L.g);
  drops.connect(verb).connect(wet).connect(L.g);
  const humF = ctx.createBiquadFilter(); humF.frequency.value = 90;
  const hum = ctx.createGain(); hum.gain.value = 0.25;
  L.own(env.loop("brown")).connect(humF).connect(hum).connect(L.g);
  const airF = ctx.createBiquadFilter(); airF.type = "bandpass"; airF.frequency.value = 320; airF.Q.value = 9;
  const air = ctx.createGain(); air.gain.value = 0.06;
  L.own(env.loop("pink")).connect(airF).connect(air).connect(L.g);
  let p = a, next = ctx.currentTime + 0.4, drift = ctx.currentTime;
  const drip = (t, v) => {
    const f = rand(900, 2200) * (1.2 - p.p2 * 0.5);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.5, 2.2), t + 0.035);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.25 * v * (0.5 + p.p2), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    const pn = ctx.createStereoPanner(); pn.pan.value = rand(-0.7, 0.7);
    o.connect(g).connect(pn).connect(drops);
    o.start(t); o.stop(t + 0.15);
  };
  const tick = (h) => {
    while (next < h) {
      drip(next, rand(0.6, 1));
      if (Math.random() < 0.3) drip(next + rand(0.06, 0.2), rand(0.3, 0.5));
      next += -Math.log(1 - Math.random()) / (0.4 + p.p1 * 2.5);
    }
    while (drift < h) { airF.frequency.setTargetAtTime(rand(260, 380), drift, 3); drift += rand(4, 8); }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, 0.8 * (1 - x.p3 * 0.4), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: ship's deck — slow timber groans (stick-slip), rope stretch and the odd hull knock. */
function shipBed(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  let p = a, next = ctx.currentTime + 0.5;
  const creak = (t, big) => {
    const len = big ? rand(1.2, 2.2) : rand(0.5, 1);
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(12, t);
    for (let at = t, n = 0; at < t + len && n < 12; n++) {
      at = Math.min(at - Math.log(1 - Math.random()) * (len / 8), t + len);
      o.frequency.linearRampToValueAtTime(10 + Math.random() * 20, at);
    }
    const body = ctx.createBiquadFilter(); body.type = "bandpass"; body.frequency.value = rand(260, 520); body.Q.value = 6;
    const rope = ctx.createBiquadFilter(); rope.type = "bandpass"; rope.frequency.value = rand(800, 1300); rope.Q.value = 9;
    const rg = ctx.createGain(); rg.gain.value = 0.25;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5 * (0.5 + p.p2), t + len * 0.35);
    g.gain.setValueAtTime(0.5 * (0.5 + p.p2), t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const pn = ctx.createStereoPanner(); pn.pan.value = rand(-0.7, 0.7);
    o.connect(body).connect(g); o.connect(rope).connect(rg).connect(g);
    g.connect(pn).connect(L.g);
    o.start(t); o.stop(t + len + 0.05);
  };
  const tick = (h) => {
    while (next < h) {
      creak(next, Math.random() < 0.4);
      if (Math.random() < 0.3) modal({ ...env, out: L.g }, next + rand(0.2, 0.8), 0.5, [1, 2.57, 4.1], rand(120, 180), 0.3, L.g);
      next += rand(1.8, 5) * (1.3 - p.p1 * 0.7);
    }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, (0.6 + x.p2 * 0.5) * (1 - x.p3 * 0.4), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** #2: quiet room tone — the near-silence of an indoor room: low air, faint mains hum. Meant to sit very low. */
function roomTone(env, a) {
  const { ctx } = env;
  const L = layer(env, 0, true);
  const lf = ctx.createBiquadFilter(); lf.frequency.value = 200;
  const low = ctx.createGain(); low.gain.value = 0.3;
  L.own(env.loop("brown")).connect(lf).connect(low).connect(L.g);
  const hf = ctx.createBiquadFilter(); hf.type = "highpass"; hf.frequency.value = 2000;
  const airG = ctx.createGain(); airG.gain.value = 0.015;
  L.own(env.loop("pink")).connect(hf).connect(airG).connect(L.g);
  for (const [f, v] of [[60, 0.005], [120, 0.002]]) {
    const o = L.own(ctx.createOscillator()); o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = v;
    o.connect(g).connect(L.g); o.start();
  }
  const set = (x) => ramp(L.g.gain, 0.6 * (0.5 + x.p1), ctx.currentTime);
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut() };
}

/** v2 heartbeat: softer thump attack through a low-pass (no click); the "ear ringing" is a faint, swelling 3.5 kHz
 *  band of noise instead of a constant 6.2 kHz sine, and is silent unless asked for. */
function heartbeat(env, a) {
  const { ctx } = env;
  const L = layer(env, 0.6, true);
  const body = ctx.createBiquadFilter(); body.type = "lowpass"; body.frequency.value = 180; body.Q.value = 0.5;
  body.connect(L.g);
  const ringF = ctx.createBiquadFilter(); ringF.type = "bandpass"; ringF.frequency.value = 3500; ringF.Q.value = 14;
  const ring = ctx.createGain(); ring.gain.value = 0;
  L.own(env.loop("pink")).connect(ringF).connect(ring).connect(L.g);
  let p = a, next = ctx.currentTime + 0.3, e = 0;
  const thump = (t, v) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    g.connect(body);
    sine(ctx, g, t, rand(58, 68), 40 / 64, 0.14, 0.24);
  };
  const tick = (h) => {
    while (next < h) {
      const bpm = 55 + p.p1 * 85;
      thump(next, 0.45 * rand(0.8, 1));
      thump(next + 0.15 + (1 - p.p1) * 0.08 + rand(-0.01, 0.01), 0.45 * rand(0.5, 0.7));
      e = rand(-0.03, 0.03) + 0.5 * e;
      next += (60 / bpm) * (1 + e);
    }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(ring.gain, x.p2 * 0.6, ctx.currentTime, 2); };
  set(a);
  return { variant: a.variant, glides: true, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

/** v4 clock: small and high, like real escapement parts. Each beat is a sub-2 ms click high-passed above 2 kHz, a quick
 *  metallic ring of tiny steel parts (4.5–7 kHz, gone in ~4 ms), and a softer second click as the tooth drops. No low
 *  thud (v3's 600 Hz case knock read as footsteps) and no mid-range ping (v2 read as a water drop). Two beats a second. */
function clock(env, a) {
  const { ctx } = env;
  const L = layer(env, 0);
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2000; hp.Q.value = 0.6;
  const lp = ctx.createBiquadFilter(); lp.frequency.value = 9500; lp.Q.value = 0.5;
  hp.connect(lp).connect(L.g);
  let p = a, next = ctx.currentTime + 0.3, i = 0;
  const click = (t, v, len) => {
    const s = ctx.createBufferSource(); s.buffer = env.noise.white;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(g).connect(hp);
    s.start(t, rand(0, 3.5), len + 0.003);
  };
  const ring = (t, f, v) => {
    for (const r of [1, 1.47, 2.13]) {
      const o = ctx.createOscillator(); o.frequency.value = f * r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v / r, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004);
      o.connect(g).connect(hp); o.start(t); o.stop(t + 0.008);
    }
  };
  const tick = (h) => {
    while (next < h) {
      const tock = i++ % 2 === 1;
      const v = rand(0.9, 1), f = (tock ? 4500 : 5600) * rand(0.98, 1.02);
      click(next, 0.55 * v, rand(0.0008, 0.0015));                       // pallet locks
      ring(next, f, 0.05 * v);                                             // tiny steel parts ring briefly
      click(next + rand(0.007, 0.011), 0.2 * v, 0.0008);                   // tooth drops
      next += 0.5 + (1 - p.p2) * 0.08 + (tock ? 0.004 : -0.004) + rand(-0.0015, 0.0015);
    }
  };
  env.ticks.add(tick);
  const set = (x) => { p = x; ramp(L.g.gain, (0.4 + x.p1 * 0.5) * (1 - x.p3 * 0.4), ctx.currentTime); };
  set(a);
  return { variant: a.variant, update: set, layer: L, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
}

const urbanV1 = AMBIENT.urban;
Object.assign(AMBIENT, {
  particle: rain,
  bio: animals,
  psycho: heartbeat,
  urban: (env, a) => (a.variant === "clockwork" ? clock(env, a) : urbanV1(env, a)),
  fire: fireBed,
  storm: stormBed,
  hooves: hoovesBed,
  tavern: tavernBed,
  cave: caveBed,
  ship: shipBed,
  room: roomTone,
});
