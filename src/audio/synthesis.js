const rand = (a, b) => a + Math.random() * (b - a);

/** Falling sine plus its 2nd harmonic at 0.3, into `g` (the envelope), so sub thumps still read on small speakers. */
export function sine(ctx, g, t, f, fall, sweep, len) {
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

// Shared partials for ambience and one-shot effects.

/** Modal impact: inharmonic partials with per-partial decay, jittered per call. `beat` adds a detuned twin per mode. */
export function modal(env, t, v, ratios, f0, decay, out = env.out, beat = false) {
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
export function noiseHit(env, t, v, f, len, q = 1, out = env.out) {
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

