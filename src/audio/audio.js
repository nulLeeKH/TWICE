// Web Audio synthesis engine: mixer graph, reverb, lookahead scheduler, ambience layers, and one-shot SFX.
import { createSequencer } from "./music.js";
import { playSfx } from "./sfx.js";
import { sine, modal, noiseHit } from "./synthesis.js";

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

  const env = { ctx, noise, loop, ticks, bus };
  const running = new Map(); // engine name → instance
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
    const want = new Map(s.ambience.map((a) => [a.engine, a]));
    for (const [name, inst] of running)
      if (!want.has(name) || want.get(name).variant !== inst.variant) {
        inst.stop();
        running.delete(name);
      }
    for (const [name, a] of want) {
      if (running.has(name)) running.get(name).update(a);
      else running.set(name, AMBIENT[name](env, a));
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
 */
function layer(env, level, steady = false) {
  const { ctx } = env;
  const g = ctx.createGain();
  g.gain.value = 0;
  ramp(g.gain, level, ctx.currentTime);
  const swell = ctx.createGain();
  g.connect(swell).connect(env.bus.ambience);
  const sources = [];
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
    fadeOut(extra = () => {}) {
      env.ticks.delete(breathe);
      ramp(g.gain, 0, ctx.currentTime, 0.6);
      setTimeout(() => {
        for (const s of sources) s.stop?.();
        g.disconnect();
        swell.disconnect();
        extra();
      }, 5000);
    },
  };
}

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
    return { variant: a.variant, update: set, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
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
    return { variant: a.variant, update: set, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },

  /** Particles (rain, fire, leaves): Poisson-timed noise grains through a material resonance, over a hiss bed. */
  particle(env, a) {
    const { ctx } = env;
    const L = layer(env, 0);
    const MAT = {
      glass: [3800, 9],
      metal: [2400, 18],
      wood: [900, 3],
      soil: [600, 1.2],
      leaf: [3000, 1],
    };
    const [mf, mq] = MAT[a.variant] ?? MAT.soil;
    const bedF = ctx.createBiquadFilter();
    bedF.frequency.value = a.variant === "wood" ? 320 : 1400;
    const bed = ctx.createGain();
    L.own(env.loop(a.variant === "wood" ? "brown" : "pink"))
      .connect(bedF)
      .connect(bed)
      .connect(L.g);
    const grains = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 7000;
    lp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = 4000;
    shelf.gain.value = -6;
    grains.connect(lp).connect(shelf).connect(L.g);
    const pans = [-0.6, -0.2, 0.2, 0.6].map((x) => {
      const pn = ctx.createStereoPanner();
      pn.pan.value = x;
      pn.connect(grains);
      return pn;
    });
    let p = a,
      next = ctx.currentTime,
      k = 0;
    const tick = (h) => {
      const rate = 500 ** p.p1; // 1..500 per second, log
      const len0 = 0.006 + p.p2 * 0.03;
      const norm = 1 / Math.sqrt(Math.max(1, rate * len0)); // overlapping grains add up
      let n = 0;
      while (next < h && n++ < 40) {
        const s = ctx.createBufferSource();
        s.buffer = env.noise.pink;
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = mf * rand(0.6, 1.4) * (1.4 - p.p2 * 0.8);
        f.Q.value = mq * rand(0.7, 1.3);
        const g = ctx.createGain();
        const len = len0 * 2 ** rand(-0.75, 0.75);
        const v = rand(0.3, 1) * (0.25 + p.p2) * (mq > 5 ? 2 : 1) * norm;
        g.gain.setValueAtTime(0.0001, next);
        g.gain.linearRampToValueAtTime(v, next + 0.0015);
        g.gain.exponentialRampToValueAtTime(0.0001, next + 0.0015 + len);
        s.connect(f)
          .connect(g)
          .connect(pans[k++ % 4]);
        s.start(next, rand(0, 10), len + 0.01);
        next += -Math.log(1 - Math.random()) / rate; // exponential gaps = Poisson process
      }
      if (next < ctx.currentTime) next = ctx.currentTime;
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      ramp(bed.gain, x.p1 * x.p1 * 0.22, ctx.currentTime);
      ramp(L.g.gain, 0.8, ctx.currentTime); // drops carry the rain now that the hiss bed is low
    };
    set(a);
    return {
      variant: a.variant,
      update: set,
      stop: () => L.fadeOut(() => env.ticks.delete(tick)),
    };
  },

  /** Creatures: birds as sine chirps with pitch sweeps, crickets as AM pulse trains, owls as low hoots. */
  bio(env, a) {
    const { ctx } = env;
    const L = layer(env, 0);
    const pan = ctx.createStereoPanner();
    pan.connect(L.g);
    pan.pan.value = rand(-0.8, 0.8); // crickets stay put; birds and owls move per call
    let p = a,
      next = ctx.currentTime + 0.5,
      chirps = 0,
      restAt = 3 + Math.floor(rand(0, 6));
    const call = (t) => {
      const kind = a.variant;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const base = {
        songbird: 2500 + p.p1 * 2500,
        cricket: 4200 + p.p1 * 800,
        owl: 300 + p.p1 * 150,
        seagull: 1400 + p.p1 * 900,
        crow: 580 + p.p1 * 240,
        wolf: 280 + p.p1 * 180,
        cicada: 4800 + p.p1 * 1200,
      }[kind] ?? (2500 + p.p1 * 2500);
      o.frequency.setValueAtTime(base, t);
      g.gain.setValueAtTime(0.0001, t);
      let len,
        src = o;
      if (kind === "songbird") {
        len = 0.08 + Math.random() * 0.15;
        o.frequency.exponentialRampToValueAtTime(
          base * (0.6 + Math.random() * 0.9),
          t + len,
        );
        g.gain.linearRampToValueAtTime(0.08, t + 0.01);
      } else if (kind === "seagull") {
        len = rand(0.35, 0.65);
        o.type = "triangle";
        o.frequency.linearRampToValueAtTime(base * 1.25, t + len * 0.25);
        o.frequency.exponentialRampToValueAtTime(base * 0.68, t + len);
        g.gain.linearRampToValueAtTime(0.09, t + 0.04);
      } else if (kind === "crow") {
        len = rand(0.22, 0.36);
        o.type = "sawtooth";
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 1150;
        bp.Q.value = 3.2;
        o.frequency.linearRampToValueAtTime(base * 1.08, t + 0.04);
        o.frequency.exponentialRampToValueAtTime(base * 0.76, t + len);
        src = o.connect(bp);
        g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      } else if (kind === "wolf") {
        len = rand(1.4, 2.4);
        o.type = "triangle";
        o.frequency.exponentialRampToValueAtTime(base * 1.45, t + len * 0.35);
        o.frequency.setValueAtTime(base * 1.42, t + len * 0.65);
        o.frequency.exponentialRampToValueAtTime(base * 0.88, t + len);
        g.gain.linearRampToValueAtTime(0.11, t + 0.25);
      } else if (kind === "cricket" || kind === "cicada") {
        len = kind === "cicada" ? rand(0.6, 1.3) : 0.25;
        const am = ctx.createOscillator();
        am.frequency.value = kind === "cicada" ? 95 + p.p2 * 60 : 30 + p.p2 * 30;
        const ag = ctx.createGain();
        ag.gain.value = 0.5;
        const amG = ctx.createGain();
        amG.gain.value = 0.5;
        am.connect(ag).connect(amG.gain);
        am.start(t);
        am.stop(t + len + 0.05);
        src = o.connect(amG);
        g.gain.linearRampToValueAtTime(0.06, t + 0.01);
      } else {
        len = rand(0.4, 0.65);
        o.frequency.linearRampToValueAtTime(base * 0.92, t + len);
        g.gain.linearRampToValueAtTime(0.12, t + 0.08);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      if (kind !== "cricket") pan.pan.setValueAtTime(rand(-0.8, 0.8), t);
      src.connect(g).connect(pan);
      o.start(t);
      o.stop(t + len + 0.05);
      return len;
    };
    const tick = (h) => {
      while (next < h) {
        const len = call(next);
        // bursts: short gaps inside a phrase, long gaps between phrases
        const phraseEnd = Math.random() < 0.25;
        let gap;
        if (a.variant === "cricket" || a.variant === "cicada") {
          gap = a.variant === "cicada" ? rand(0.15, 0.45) : 0.35 * rand(0.8, 1.2);
          if (++chirps >= restAt) {
            gap += rand(0.8, 2);
            chirps = 0;
            restAt = 3 + Math.floor(rand(0, 6));
          }
        } else if (a.variant === "wolf")
          gap = rand(4, 9);
        else if (a.variant === "crow")
          gap = phraseEnd ? rand(2.2, 5.5) : rand(0.18, 0.42);
        else if (a.variant === "owl" || a.variant === "seagull")
          gap = phraseEnd ? rand(2.5, 6) : rand(0.4, 0.9);
        else gap = phraseEnd ? 1.5 + (1 - p.p2) * 4 : 0.05;
        next += len + gap;
      }
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      ramp(L.g.gain, 2.5 * (0.3 + (1 - x.p3) * 0.7), ctx.currentTime); // p3 distance: farther = quieter
    };
    set(a);
    return {
      variant: a.variant,
      update: set,
      stop: () => L.fadeOut(() => env.ticks.delete(tick)),
    };
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
    return { variant: a.variant, update: set, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },

  /** Body tension: lub-dub heartbeat (sub sine pairs) and tinnitus. */
  psycho(env, a) {
    const { ctx } = env;
    const L = layer(env, 0.6, true);
    const tin = L.own(ctx.createOscillator());
    tin.frequency.value = 6200;
    const tg = ctx.createGain();
    tin.connect(tg).connect(L.g);
    tin.start();
    let p = a,
      next = ctx.currentTime + 0.3,
      e = 0;
    const thump = (t, v) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      g.connect(L.g);
      sine(ctx, g, t, rand(64, 76), 40 / 70, 0.12, 0.2);
    };
    const tick = (h) => {
      while (next < h) {
        const bpm = 60 + p.p1 * 100;
        thump(next, 0.45 * rand(0.8, 1));
        thump(
          next + 0.14 + (1 - p.p1) * 0.08 + rand(-0.01, 0.01),
          0.45 * rand(0.5, 0.7),
        );
        e = rand(-0.03, 0.03) + 0.5 * e; // heart-rate variability
        next += (60 / bpm) * (1 + e);
      }
    };
    env.ticks.add(tick);
    const set = (x) => {
      p = x;
      ramp(tg.gain, x.p2 * 0.012, ctx.currentTime);
    };
    set(a);
    return { update: set, stop: () => L.fadeOut(() => env.ticks.delete(tick)) };
  },
};
