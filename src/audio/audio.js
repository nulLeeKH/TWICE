// Web Audio synthesis engine: mixer graph, reverb, lookahead scheduler, ambience layers, and one-shot SFX.
import { createSequencer } from "./music.js";

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
  // One-shots get oscillators with a small random detune and a slow, uneven wobble, so no tone sounds machine-exact.
  const human = new Proxy(ctx, {
    get(target, prop) {
      if (prop === "createOscillator") return () => {
        const o = target.createOscillator(), lfo = target.createOscillator(), depth = target.createGain();
        o.detune.value = rand(-15, 15);
        lfo.frequency.value = rand(3.5, 6.5);
        depth.gain.value = rand(3, 9);
        lfo.connect(depth).connect(o.detune);
        const start = o.start.bind(o), stop = o.stop.bind(o);
        o.start = (when = 0, ...rest) => { lfo.start(when); start(when, ...rest); };
        o.stop = (when = 0) => { lfo.stop(when); stop(when); };
        return o;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Soft saturation rounds synthetic edges instead of letting raw waveforms through.
  const soft = new Float32Array(1024).map((_, i) => Math.tanh(1.6 * (i / 511.5 - 1)) / Math.tanh(1.6));
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
      const fx = SFX_FX[type];
      if (!fx) return;
      const pan = ctx.createStereoPanner();
      pan.pan.value = type === "sub_drop" ? 0 : rand(-0.5, 0.5);
      // each play sits at a slightly different distance and moment, so a repeated effect never sounds pasted in
      // Per-effect level brings quiet recipes up to the same presence; the soft shaper catches the peaks after it.
      // A slight per-play top-end variation keeps repeats from sounding pasted in without dulling the attack.
      const level = ctx.createGain();
      level.gain.value = SFX_LEVEL[type] ?? 1;
      const tone = ctx.createBiquadFilter();
      tone.frequency.value = rand(9000, 16000);
      tone.Q.value = 0.5;
      const shape = ctx.createWaveShaper();
      shape.curve = soft;
      pan.connect(tone).connect(level);
      level.connect(shape).connect(sfxLayer);
      fx({ ...env, ctx: human, out: pan, sfxOut: level }, ctx.currentTime + (type === "sudden_silence" ? 0.02 : rand(0.02, 0.12)), p1 * rand(0.85, 1.15), {
        duck: (t) => duck(duckGain.gain, t),
      });
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

/** Falling sine plus its 2nd harmonic at 0.3, into `g` (the envelope), so sub thumps still read on small speakers. */
function sine(ctx, g, t, f, fall, sweep, len) {
  for (const [m, a] of [
    [1, 1],
    [2, 0.3],
  ]) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * m, t);
    o.frequency.exponentialRampToValueAtTime(f * m * fall, t + sweep);
    const h = ctx.createGain();
    h.gain.value = a;
    o.connect(h).connect(g);
    o.start(t);
    o.stop(t + len);
  }
}

// ---- one-shot SFX: (env, t, strength, helpers); env.out is the event's panner ----

/** Modal impact: inharmonic partials with per-partial decay, jittered per call. `beat` adds a detuned twin per mode. */
function modal(env, t, v, ratios, f0, decay, out = env.out, beat = false) {
  const { ctx } = env;
  f0 *= 2 ** (rand(-0.5, 0.5) / 12); // ±50 cents
  const atk = rand(0.001, 0.004);
  ratios.forEach((r, i) => {
    const f = f0 * r * rand(0.985, 1.015);
    if (f > 12000) return;
    const d = (decay / (1 + i * 0.3)) * rand(0.85, 1.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(
      ((v * 0.3) / (i + 1)) * rand(0.75, 1.25),
      t + atk,
    );
    g.gain.exponentialRampToValueAtTime(0.0001, t + atk + d);
    g.connect(out);
    for (const [m, a] of beat
      ? [
          [1, 1],
          [1.003, 0.5],
        ]
      : [[1, 1]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * m;
      const h = ctx.createGain();
      h.gain.value = a;
      o.connect(h).connect(g);
      o.start(t + rand(0, 0.0015));
      o.stop(t + atk + d + 0.05);
    }
  });
  noiseHit(env, t, v * 0.15, Math.min(f0 * 2, 4000), 0.008, 2, out);
}
function noiseHit(env, t, v, f, len, q = 1, out = env.out) {
  const { ctx } = env;
  const s = ctx.createBufferSource();
  s.buffer = env.noise.pink;
  const b = ctx.createBiquadFilter();
  b.type = "bandpass";
  b.frequency.value = f;
  b.Q.value = q;
  const lp = ctx.createBiquadFilter();
  lp.frequency.value = 4500;
  lp.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s.connect(b).connect(lp).connect(g).connect(out);
  s.start(t, rand(0, 10), len + 0.02);
}

/** Per-effect output level, set from measurement so each lands about 6 dB over the music bed (quiet textures at its level). */
const SFX_LEVEL = {
  door_creak: 3.7, door_slam: 1.8, footsteps: 5, clock_ticks: 4.7, knock: 2.5, impact_wood: 2.2, impact_metal: 1.5,
  glass_shatter: 1.5, sub_drop: 1.0, chopping: 2.7, sizzle: 2.8, glass_clink: 1.0, coin_drop: 1.2, phone_ring: 3.6,
  camera_shutter: 3.6, keyboard: 3.4, sword_clash: 1.9, arrow_shot: 3.2, magic_blast: 1.1, slap_punch: 2.5,
  whoosh: 5, gunshot: 2.4, explosion: 1.4, collapse: 1.5, car_crash: 1.1, tire_screech: 2.5, siren: 1.2,
  thunder: 1.3, water_splash: 3.5, crow_caw: 5, dog_bark: 5.0, gasp: 5.0, heartbeat_thump: 0.9, airplane: 3.8,
  car_horn: 2.0, train_horn: 1.2, bell: 1.5, page_turn: 5, crowd_cheer: 1.8, scream: 2.3, evil_laugh: 3.9, sigh: 2.9,
  chain_rattle: 0.6, body_fall: 0.6, blade_draw: 2.3, flame_burst: 3.7, low_rumble: 0.6,
};

const SFX_FX = {
  /** Stick-slip creak: a sawtooth whose pitch and pulse rate wander, through a wooden body resonance and a metal hinge. */
  door_creak(env, t, v) {
    const { ctx } = env;
    const len = 1.2 + v;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(18, t);
    // breakpoints at exponential gaps (~10 per creak) so the stick-slip isn't evenly spaced
    for (let at = t, n = 0; at < t + len && n < 14; n++) {
      at = Math.min(at - Math.log(1 - Math.random()) * (len / 10), t + len);
      o.frequency.linearRampToValueAtTime(14 + Math.random() * 30, at);
    }
    const c = rand(500, 1000);
    const body = ctx.createBiquadFilter();
    body.type = "bandpass";
    body.frequency.setValueAtTime(c * rand(0.85, 1.15), t);
    body.frequency.linearRampToValueAtTime(c * rand(0.85, 1.15), t + len);
    body.Q.value = 4;
    const hinge = ctx.createBiquadFilter();
    hinge.type = "bandpass";
    hinge.frequency.value = rand(1600, 2400);
    hinge.Q.value = 8;
    const hg = ctx.createGain();
    hg.gain.value = 0.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.6 * v, t + 0.15);
    g.gain.setValueAtTime(0.6 * v, t + len - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(body).connect(g).connect(env.out);
    o.connect(hinge).connect(hg).connect(g);
    o.start(t);
    o.stop(t + len);
  },
  footsteps(env, t, v) {
    const { ctx } = env;
    const step = 0.75 - v * 0.35;
    const dir = Math.random() < 0.5 ? -1 : 1; // walks across, either way
    let at = t;
    for (let i = 0; i < 6; i++) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = dir * (-0.4 + (0.8 * i) / 5);
      pan.connect(env.sfxOut ?? env.bus.sfx);
      const k = rand(0.8, 1.15) * (i % 2 ? 0.85 : 1) * (i === 5 ? 0.7 : 1);
      noiseHit(
        env,
        at,
        0.5 * v * k,
        rand(150, 260),
        rand(0.07, 0.12),
        1.5,
        pan,
      );
      noiseHit(
        env,
        at + rand(0.02, 0.05),
        0.08 * v * k,
        1100 * 2 ** Math.random(),
        0.05,
        rand(0.6, 1.2),
        pan,
      );
      at += step * rand(0.94, 1.06);
    }
  },
  clock_ticks(env, t, v) {
    let at = t;
    for (let i = 0; i < 8; i++) {
      const f = (i % 2 ? 2600 : 3200) * rand(0.97, 1.03);
      modal(env, at, v * 0.25, [1, 2.7, 5.1], f, 0.04);
      noiseHit(env, at, v * 0.1, f, 0.015, 6);
      at += (i % 2 ? 1.02 : 0.98) + rand(-0.003, 0.003); // tick-tock asymmetry
    }
  },
  knock(env, t, v) {
    const r = Math.random();
    const n = r < 0.2 ? 2 : r < 0.8 ? 3 : 4;
    const f0 = rand(120, 165); // one door; modal's ±50 cents covers per-hit variation
    const k = rand(0.9, 1.1);
    let at = t,
      gap = rand(0.17, 0.27);
    for (let i = 0; i < n; i++) {
      modal(env, at, v * k * [1, 0.85, 0.95, 0.9][i], [1, 2.3, 3.9], f0, 0.18);
      at += gap;
      gap *= rand(0.9, 1);
    }
  },
  impact_wood: (env, t, v) =>
    modal(env, t, v * 1.4, [1, 2.57, 4.1, 6.3], 110, 0.35),
  impact_metal: (env, t, v) =>
    modal(env, t, v, [1, 2.76, 5.4, 8.93], 520, 2.2, env.out, true),
  glass_shatter(env, t, v) {
    const { ctx } = env;
    // 1. Initial violent pane fracture crack + mid-body punch ("와장창!")
    noiseHit(env, t, v * 0.95, 3400, 0.14, 1.1);
    noiseHit(env, t + 0.015, v * 0.78, 5600, 0.28, 1.3);
    modal(env, t, v * 1.25, [1, 1.62, 2.48, 3.85], rand(480, 680), 0.24, env.out, true);

    // 2. Loud primary glass shards + cascading floor scatter
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1100;
    hp.connect(env.out);
    const n = Math.floor(rand(22, 30));
    for (let i = 0; i < n; i++) {
      const delay = i < 7 ? rand(0, 0.075) : Math.random() ** 1.8 * 0.78;
      const amp = i < 7 ? rand(0.68, 0.98) : rand(0.35, 0.7);
      modal(
        env,
        t + delay,
        v * amp,
        [1, 1.84, 2.92],
        rand(1450, 3700),
        rand(0.2, 0.38),
        hp,
        true,
      );
    }
  },
  sub_drop(env, t, v) {
    const { ctx } = env;
    const fall = rand(1.4, 2.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.45 * v, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + fall + 0.4);
    g.connect(env.out);
    const f = rand(70, 95);
    sine(ctx, g, t, f, rand(25, 35) / f, fall, fall + 0.5);
  },
  sudden_silence: (env, t, v, h) => h.duck(t),
  chopping(env, t, v) {
    const n = 5 + Math.floor(rand(0, 4));
    let at = t;
    for (let i = 0; i < n; i++) {
      const k = rand(0.75, 1.15);
      modal(env, at, v * 0.75 * k, [1, 2.35, 3.8], rand(170, 230), 0.09);
      noiseHit(env, at, v * 0.22 * k, rand(2200, 3400), 0.025, 3);
      at += rand(0.13, 0.22);
    }
  },
  sizzle(env, t, v) {
    const { ctx } = env;
    const len = 1.4 + v * 0.8;
    const s = ctx.createBufferSource();
    s.buffer = env.noise.pink;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + len);
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28 * v, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    s.start(t, rand(0, 3));
    s.stop(t + len + 0.05);
  },
  sword_clash(env, t, v) {
    noiseHit(env, t, v * 0.35, 1800, 0.12, 2.2);
    const hits = 1 + (Math.random() < 0.65 ? 1 : 0);
    let at = t + 0.04;
    for (let i = 0; i < hits; i++) {
      modal(env, at, v * 0.95, [1, 2.76, 4.72, 7.15, 9.8], rand(920, 1380), 1.4, env.out, true);
      noiseHit(env, at, v * 0.3, rand(3200, 5000), 0.04, 4);
      at += rand(0.18, 0.32);
    }
  },
  whoosh(env, t, v) {
    const { ctx } = env;
    const len = rand(0.32, 0.55);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + len * 0.45);
    bp.frequency.exponentialRampToValueAtTime(220, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.55 * v, t + len * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    s.start(t, rand(0, 8), len + 0.05);
  },
  thunder(env, t, v) {
    const { ctx } = env;
    const len = 2.4 + v * 1.1;
    noiseHit(env, t, v * 0.55, rand(900, 1800), 0.14, 1.2);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(340, t);
    lp.frequency.exponentialRampToValueAtTime(75, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.65 * v, t + 0.06);
    g.gain.setValueAtTime(0.5 * v, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(lp).connect(g).connect(env.out);
    s.start(t, rand(0, 8));
    s.stop(t + len + 0.05);
  },
  explosion(env, t, v) {
    const { ctx } = env;
    const len = 1.9 + v * 0.8;
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(0.6 * v, t + 0.015);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    sub.connect(env.out);
    sine(ctx, sub, t, 95, 0.3, 0.45, 0.65);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.7 * v, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(lp).connect(g).connect(env.out);
    s.start(t, rand(0, 8));
    s.stop(t + len + 0.05);
  },
  airplane(env, t, v) {
    const { ctx } = env;
    const len = 2.8;
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(520, t);
    bp.frequency.exponentialRampToValueAtTime(160, t + len);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(145, t);
    o.frequency.exponentialRampToValueAtTime(82, t + len);
    const og = ctx.createGain();
    og.gain.value = 0.12;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42 * v, t + len * 0.38);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    o.connect(og).connect(bp);
    s.start(t, rand(0, 8));
    o.start(t);
    s.stop(t + len + 0.05);
    o.stop(t + len + 0.05);
  },
  car_horn(env, t, v) {
    const { ctx } = env;
    let at = t;
    for (const dur of [0.18, 0.32]) {
      const g = ctx.createGain();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 950;
      bp.Q.value = 1.5;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.22 * v, at + 0.015);
      g.gain.setValueAtTime(0.22 * v, at + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      g.connect(bp).connect(env.out);
      for (const f of [415, 523]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.connect(g);
        o.start(at);
        o.stop(at + dur + 0.02);
      }
      at += dur + 0.09;
    }
  },
  bell: (env, t, v) =>
    modal(env, t, v * 0.9, [1, 2, 3.01, 4.18, 5.43], rand(780, 1050), 2.1, env.out, true),
  page_turn(env, t, v) {
    noiseHit(env, t, v * 0.28, rand(2400, 3400), 0.16, 2.2);
    noiseHit(env, t + 0.06, v * 0.18, rand(3600, 4800), 0.11, 2.8);
  },
  water_splash(env, t, v) {
    modal(env, t, v * 0.55, [1, 1.58, 2.25], rand(240, 360), 0.22);
    noiseHit(env, t + 0.015, v * 0.42, rand(900, 1600), 0.38, 1.1);
  },
  door_slam(env, t, v) {
    const { ctx } = env;
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(0.55 * v, t + 0.008);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    sub.connect(env.out);
    sine(ctx, sub, t, 85, 0.4, 0.22, 0.35);
    modal(env, t, v * 1.2, [1, 2.1, 3.4, 5.1], 95, 0.28);
    noiseHit(env, t, v * 0.4, 600, 0.08, 1.4);
  },
  glass_clink(env, t, v) {
    modal(env, t, v * 0.7, [1, 2.32, 4.18, 6.4], rand(2200, 2900), 0.55, env.out, true);
    if (Math.random() < 0.7) modal(env, t + rand(0.08, 0.16), v * 0.45, [1, 2.32, 4.18], rand(2300, 3100), 0.4, env.out, true);
  },
  coin_drop(env, t, v) {
    let at = t, gap = rand(0.09, 0.14), amp = v * 0.75;
    const f0 = rand(2400, 3200);
    for (let i = 0; i < 6; i++) {
      modal(env, at, amp, [1, 2.18, 3.85, 5.9], f0 * rand(0.98, 1.02), 0.32 - i * 0.04, env.out, true);
      at += gap;
      gap *= 0.72;
      amp *= 0.76;
    }
  },
  phone_ring(env, t, v) {
    let at = t;
    for (let b = 0; b < 2; b++) {
      for (let i = 0; i < 6; i++) {
        modal(env, at + i * 0.055, v * 0.45, [1, 1.25], i % 2 ? 1180 : 940, 0.06);
      }
      at += 0.52;
    }
  },
  camera_shutter(env, t, v) {
    noiseHit(env, t, v * 0.45, 3400, 0.022, 2.5);
    modal(env, t + 0.005, v * 0.4, [1, 2.4, 4.7], 1600, 0.035);
    noiseHit(env, t + 0.055, v * 0.35, 2600, 0.028, 2.2);
  },
  keyboard(env, t, v) {
    let at = t;
    const n = 7 + Math.floor(rand(0, 5));
    for (let i = 0; i < n; i++) {
      const k = rand(0.65, 1.15);
      modal(env, at, v * 0.35 * k, [1, 2.5, 4.2], rand(900, 1500), 0.035);
      noiseHit(env, at, v * 0.18 * k, rand(2800, 4200), 0.015, 3);
      at += rand(0.06, 0.17);
    }
  },
  arrow_shot(env, t, v) {
    modal(env, t, v * 0.55, [1, 2.02, 3.05, 4.1], rand(150, 210), 0.25);
    SFX_FX.whoosh(env, t + 0.02, v * 0.9);
  },
  magic_blast(env, t, v) {
    const { ctx } = env;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(1480, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28 * v, t + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    o.connect(g).connect(env.out);
    o.start(t);
    o.stop(t + 0.9);
    modal(env, t + 0.24, v * 0.85, [1, 1.5, 2.25, 3.38, 5.06], 520, 1.4, env.out, true);
    noiseHit(env, t + 0.24, v * 0.4, 2400, 0.35, 1.5);
  },
  slap_punch(env, t, v) {
    const { ctx } = env;
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(0.5 * v, t + 0.005);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    sub.connect(env.out);
    sine(ctx, sub, t, 130, 0.35, 0.1, 0.16);
    noiseHit(env, t, v * 0.55, 1900, 0.045, 1.6);
  },
  gunshot(env, t, v) {
    const { ctx } = env;
    noiseHit(env, t, v * 0.85, 2200, 0.035, 0.9);
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(0.65 * v, t + 0.004);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    sub.connect(env.out);
    sine(ctx, sub, t, 150, 0.28, 0.15, 0.22);
    noiseHit(env, t + 0.015, v * 0.45, 650, 0.65, 0.8);
  },
  collapse(env, t, v) {
    SFX_FX.explosion(env, t, v * 0.75);
    for (let i = 0; i < 8; i++) {
      const at = t + 0.12 + i * rand(0.14, 0.24);
      modal(env, at, v * 0.65 * (1 - i * 0.08), [1, 2.2, 3.7], rand(85, 180), 0.32);
      noiseHit(env, at, v * 0.3 * (1 - i * 0.08), rand(400, 1200), 0.2, 1.2);
    }
  },
  tire_screech(env, t, v) {
    const { ctx } = env;
    const len = 0.85 + v * 0.45;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(rand(880, 1080), t);
    o.frequency.linearRampToValueAtTime(rand(1220, 1450), t + len * 0.35);
    o.frequency.exponentialRampToValueAtTime(rand(680, 820), t + len);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1850;
    bp.Q.value = 5.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.26 * v, t + 0.05);
    g.gain.setValueAtTime(0.24 * v, t + len - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(bp).connect(g).connect(env.out);
    o.start(t);
    o.stop(t + len + 0.04);
    noiseHit(env, t, v * 0.22, 2400, len, 2.5);
  },
  car_crash(env, t, v) {
    SFX_FX.tire_screech(env, t, v * 0.85);
    const hit = t + 0.62;
    SFX_FX.explosion(env, hit, v * 0.85);
    SFX_FX.impact_metal(env, hit + 0.02, v);
    SFX_FX.glass_shatter(env, hit + 0.08, v * 0.9);
  },
  siren(env, t, v) {
    const { ctx } = env;
    const len = 2.6;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(620, t);
    o.frequency.linearRampToValueAtTime(1120, t + 0.65);
    o.frequency.linearRampToValueAtTime(620, t + 1.3);
    o.frequency.linearRampToValueAtTime(1120, t + 1.95);
    o.frequency.linearRampToValueAtTime(620, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22 * v, t + 0.15);
    g.gain.setValueAtTime(0.22 * v, t + len - 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(env.out);
    o.start(t);
    o.stop(t + len + 0.05);
  },
  crow_caw(env, t, v) {
    const { ctx } = env;
    let at = t;
    for (let i = 0; i < 2; i++) {
      const len = rand(0.24, 0.34);
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(620, at);
      o.frequency.linearRampToValueAtTime(710, at + 0.04);
      o.frequency.exponentialRampToValueAtTime(460, at + len);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1250;
      bp.Q.value = 3.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.26 * v, at + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(bp).connect(g).connect(env.out);
      o.start(at);
      o.stop(at + len + 0.03);
      at += len + rand(0.12, 0.22);
    }
  },
  dog_bark(env, t, v) {
    const { ctx } = env;
    let at = t;
    for (let i = 0; i < 2; i++) {
      const len = rand(0.16, 0.24);
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(220, at);
      o.frequency.linearRampToValueAtTime(340, at + 0.035);
      o.frequency.exponentialRampToValueAtTime(165, at + len);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 720;
      bp.Q.value = 2.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.32 * v, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(bp).connect(g).connect(env.out);
      o.start(at);
      o.stop(at + len + 0.03);
      noiseHit(env, at, v * 0.2, 900, len * 0.8, 2);
      at += len + rand(0.14, 0.24);
    }
  },
  gasp(env, t, v) {
    const { ctx } = env;
    const len = 0.34;
    const s = ctx.createBufferSource();
    s.buffer = env.noise.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 4.2;
    bp.frequency.setValueAtTime(750, t);
    bp.frequency.exponentialRampToValueAtTime(1450, t + len * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.38 * v, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    s.start(t, rand(0, 6), 0.38);
  },
  heartbeat_thump(env, t, v) {
    const { ctx } = env;
    for (const [dt, amp] of [[0, 0.55], [0.18, 0.38]]) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(amp * v, t + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22);
      g.connect(env.out);
      sine(ctx, g, t + dt, 68, 38 / 68, 0.14, 0.22);
    }
  },
  train_horn(env, t, v) {
    const { ctx } = env;
    const len = 1.9;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24 * v, t + 0.08);
    g.gain.setValueAtTime(0.22 * v, t + len - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    g.connect(lp).connect(env.out);
    for (const f of [277, 330, 440]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + len + 0.04);
    }
  },
  crowd_cheer(env, t, v) {
    const { ctx } = env;
    const len = 2.4;
    const masterG = ctx.createGain();
    masterG.gain.setValueAtTime(0.0001, t);
    masterG.gain.linearRampToValueAtTime(0.54 * v, t + 0.25);
    masterG.gain.setValueAtTime(0.48 * v, t + 1.1);
    masterG.gain.exponentialRampToValueAtTime(0.0001, t + len);
    masterG.connect(env.out);

    // Formant 1 ('o' 420Hz -> 'a' 760Hz) & Formant 2 (860Hz -> 1280Hz) + Upper presence (2600Hz)
    const f1 = ctx.createBiquadFilter();
    f1.type = "bandpass";
    f1.Q.value = 2.6;
    f1.frequency.setValueAtTime(420, t);
    f1.frequency.exponentialRampToValueAtTime(760, t + 0.35);
    f1.frequency.setTargetAtTime(680, t + 0.9, 0.5);

    const f2 = ctx.createBiquadFilter();
    f2.type = "bandpass";
    f2.Q.value = 3.0;
    f2.frequency.setValueAtTime(860, t);
    f2.frequency.exponentialRampToValueAtTime(1280, t + 0.35);
    f2.frequency.setTargetAtTime(1150, t + 0.9, 0.5);

    const f3 = ctx.createBiquadFilter();
    f3.type = "bandpass";
    f3.Q.value = 2.2;
    f3.frequency.setValueAtTime(2400, t);
    f3.frequency.linearRampToValueAtTime(2850, t + 0.4);

    f1.connect(masterG);
    f2.connect(masterG);
    f3.connect(masterG);

    // Crowd breath/roar noise bed through the vowel formants
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = env.noise.pink;
    const nGain = ctx.createGain();
    nGain.gain.value = 0.95;
    nSrc.connect(nGain);
    nGain.connect(f1);
    nGain.connect(f2);
    nGain.connect(f3);
    nSrc.start(t, rand(0, 5), len + 0.05);

    // Chorus of rising vocal pitches ("Waaaah!") across male/female registers
    const basePitches = [165, 190, 215, 242, 275, 310, 355, 395, 445, 510];
    for (const baseF of basePitches) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      const startF = baseF * rand(0.95, 1.05);
      const peakF = startF * rand(1.16, 1.28);
      const delay = rand(0, 0.09);
      o.frequency.setValueAtTime(startF, t + delay);
      o.frequency.exponentialRampToValueAtTime(peakF, t + delay + rand(0.28, 0.45));
      o.frequency.setTargetAtTime(peakF * rand(0.92, 0.97), t + 0.85, 0.6);
      const vg = ctx.createGain();
      vg.gain.value = 0.13;
      o.connect(vg);
      vg.connect(f1);
      vg.connect(f2);
      o.start(t + delay);
      o.stop(t + len + 0.05);
    }

    // Scattered applause claps embedded in the cheer
    for (let i = 0; i < 26; i++) {
      const at = t + 0.08 + rand(0, len - 0.35);
      noiseHit(env, at, v * rand(0.08, 0.18), rand(1400, 2800), rand(0.025, 0.045), 2.2);
    }
  },
  /** One voice, not a chord of saws: a pitch that cracks upward, wavers irregularly and falls away, heard from a distance. */
  scream(env, t, v) {
    const { ctx } = env;
    const len = rand(0.75, 1.05), f0 = rand(380, 620);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32 * v, t + 0.07);
    g.gain.setTargetAtTime(0.22 * v, t + 0.25, 0.2);
    g.gain.setTargetAtTime(0.0001, t + len * 0.7, len * 0.12);
    // distance: the room and a soft top end hide the synthetic edge
    const far = ctx.createBiquadFilter();
    far.frequency.value = 3200;
    g.connect(far).connect(env.out);
    const vowel = [[850, 5], [1400, 6], [2900, 7]].map(([f, q]) => {
      const b = ctx.createBiquadFilter();
      b.type = "bandpass";
      b.frequency.setValueAtTime(f * 0.8, t);
      b.frequency.linearRampToValueAtTime(f, t + 0.15);
      b.Q.value = q;
      b.connect(g);
      return b;
    });
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0 * 0.75, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(f0 * rand(0.55, 0.7), t + len);
    // irregular waver: low-passed noise on the pitch instead of a steady vibrato
    const jitter = ctx.createBufferSource();
    jitter.buffer = env.noise.brown;
    const jf = ctx.createBiquadFilter();
    jf.frequency.value = 12;
    const jg = ctx.createGain();
    jg.gain.value = f0 * 0.06;
    jitter.connect(jf).connect(jg).connect(o.frequency);
    jitter.start(t, rand(0, 5), len + 0.1);
    for (const b of vowel) o.connect(b);
    o.start(t);
    o.stop(t + len + 0.1);
    const breath = ctx.createBufferSource();
    breath.buffer = env.noise.pink;
    const bg = ctx.createGain();
    bg.gain.value = 0.35;
    breath.connect(bg);
    for (const b of vowel) bg.connect(b);
    breath.start(t, rand(0, 4), len + 0.1);
  },
  evil_laugh(env, t, v) {
    const { ctx } = env;
    for (let i = 0; i < 4; i++) {
      const at = t + i * 0.19;
      const len = 0.16;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      const base = 195 - i * 11;
      o.frequency.setValueAtTime(base * 1.2, at);
      o.frequency.exponentialRampToValueAtTime(base * 0.82, at + len);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 680 - i * 35;
      bp.Q.value = 2.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.48 * v * (1 - i * 0.12), at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(bp).connect(g).connect(env.out);
      o.start(at);
      o.stop(at + len + 0.03);
    }
  },
  sigh(env, t, v) {
    const { ctx } = env;
    const len = 0.85;
    const s = ctx.createBufferSource();
    s.buffer = env.noise.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(980, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.46 * v, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    s.start(t, rand(0, 5), len + 0.05);
  },
  chain_rattle(env, t, v) {
    for (let i = 0; i < 6; i++) {
      const at = t + i * rand(0.045, 0.075);
      const base = rand(2400, 3600);
      for (const r of [1, 1.42, 1.87]) {
        sine(env.ctx, env.out, at, base * r, 0.96, 0.18 * v, rand(0.08, 0.16));
      }
      noiseHit(env, at, v * 0.22, 4200, 0.04, 4);
    }
  },
  body_fall(env, t, v) {
    sine(env.ctx, env.out, t, 115, 32 / 115, 0.72 * v, 0.34);
    noiseHit(env, t + 0.01, v * 0.52, 240, 0.28, 1.2);
    noiseHit(env, t + 0.06, v * 0.32, 780, 0.18, 1.8);
  },
  blade_draw(env, t, v) {
    const { ctx } = env;
    const len = 0.48;
    for (const [f0, f1, amp] of [[1400, 3400, 0.26], [2100, 4800, 0.2]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(amp * v, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(env.out);
      o.start(t);
      o.stop(t + len + 0.03);
    }
    noiseHit(env, t, v * 0.38, 3600, 0.22, 3.0);
  },
  flame_burst(env, t, v) {
    const { ctx } = env;
    const len = 0.95;
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(720, t + 0.18);
    bp.frequency.exponentialRampToValueAtTime(240, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.55 * v, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp).connect(g).connect(env.out);
    s.start(t, rand(0, 4), len + 0.05);
    for (let i = 0; i < 8; i++) {
      noiseHit(env, t + 0.06 + rand(0, 0.65), v * 0.16, rand(1800, 3800), 0.03, 3);
    }
  },
  low_rumble(env, t, v) {
    const { ctx } = env;
    const len = 1.4;
    sine(ctx, env.out, t, 68, 36 / 68, 0.5 * v, len);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 140;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.48 * v, t + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(lp).connect(g).connect(env.out);
    s.start(t, rand(0, 4), len + 0.05);
  },
};
