import { sine, modal, noiseHit } from "./synthesis.js";

const rand = (a, b) => a + Math.random() * (b - a);

const SFX_LEVEL = {
  door_creak: 3.7, door_slam: 1.8, footsteps: 5, clock_ticks: 4.7, knock: 2.5, impact_wood: 2.2, impact_metal: 1.5,
  glass_shatter: 1.5, sub_drop: 1.0, chopping: 2.7, sizzle: 2.8, glass_clink: 1.0, phone_ring: 3.6,
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
  o.frequency.setValueAtTime(36, t); // 기존 18 → 36 Hz

  for (let at = t, n = 0; at < t + len && n < 14; n++) {
    at = Math.min(
      at - Math.log(1 - Math.random()) * (len / 10),
      t + len,
    );
    o.frequency.linearRampToValueAtTime(
      28 + Math.random() * 60,
      at,
    );
  }

  // 목재 공명을 높은 음역으로 이동
  const c = rand(900, 1600);
  const body = ctx.createBiquadFilter();
  body.type = "bandpass";
  body.frequency.setValueAtTime(c * rand(0.85, 1.15), t);
  body.frequency.linearRampToValueAtTime(
    c * rand(0.85, 1.15),
    t + len,
  );
  body.Q.value = 4;

  // 경첩의 날카로운 울림도 높임
  const hinge = ctx.createBiquadFilter();
  hinge.type = "bandpass";
  hinge.frequency.value = rand(2400, 3400);
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
  const { ctx } = env;
  const duration = 0.065;

  const buffer = ctx.createBuffer(
    1,
    Math.ceil(ctx.sampleRate * duration),
    ctx.sampleRate,
  );
  const data = buffer.getChannelData(0);

  // 기존 2600 / 3200 Hz 교대 대신 조금 낮은 음으로 고정
  const f0 = 2300;

  for (let i = 0; i < data.length; i++) {
    const s = i / ctx.sampleRate;
    const attack = Math.min(1, s / 0.0008);
    const tail = Math.min(1, (duration - s) / 0.004);

    data[i] = attack * tail * (
      0.17 *
        Math.sin(2 * Math.PI * f0 * s) *
        Math.exp(-s / 0.009) +
      0.065 *
        Math.sin(2 * Math.PI * f0 * 2.7 * s) *
        Math.exp(-s / 0.005) +
      0.025 *
        Math.sin(2 * Math.PI * f0 * 4.1 * s) *
        Math.exp(-s / 0.003)
    );
  }

  const gain = ctx.createGain();
  gain.gain.value = v;
  gain.connect(env.out);

  // 같은 파형을 정확히 1초 간격으로 8회 재생
  for (let i = 0; i < 8; i++) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(t + i);
  }
},

knock(env, t, v) {
  const r = Math.random();
  const n = r < 0.2 ? 2 : r < 0.8 ? 3 : 4;

  // 기존 120~165 Hz에서 약 15% 상승
  const f0 = rand(138, 190);
  const k = rand(0.9, 1.1);

  let at = t;
  let gap = rand(0.17, 0.27);

  for (let i = 0; i < n; i++) {
    const hit = v * k * [1, 0.85, 0.95, 0.9][i];

    // 감쇠를 짧게 하고 고차 공명을 추가해 단단한 타격감
    modal(
      env,
      at,
      hit * 1.05,
      [1, 2.6, 4.4, 6.1],
      f0,
      0.085,
    );

    // 타격 순간의 짧고 선명한 어택 추가
    noiseHit(env, at, hit * 0.16, 1900, 0.008, 1.2);

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
    const len = 4.0;
    noiseHit(env, t, v * 0.9, 500, 0.2, 1.0);
    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(40, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1.3 * v, t + 0.08);
    g.gain.setValueAtTime(0.9 * v, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(lp).connect(g).connect(env.out);
    s.start(t, rand(0, 8));
    s.stop(t + len + 0.05);
  },
explosion(env, t, v) {
    const { ctx } = env;
    const len = 4.0;
    noiseHit(env, t, v * 1.5, 1200, 0.08, 1.2);
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(1.2 * v, t + 0.015);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    sub.connect(env.out);
    sine(ctx, sub, t, 85, 0.25, 0.5, 0.85);

    const s = ctx.createBufferSource();
    s.buffer = env.noise.brown;
    s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1100, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1.4 * v, t + 0.02);
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
    modal(env, t, v * 1.0, [0.5, 1, 2.01, 4.18, 5.43], rand(220, 320), 5.5, env.out, true),
  page_turn(env, t, v) {
    noiseHit(env, t, v * 0.28, rand(2400, 3400), 0.16, 2.2);
    noiseHit(env, t + 0.06, v * 0.18, rand(3600, 4800), 0.11, 2.8);
  },
  water_splash(env, t, v) {
    modal(env, t, v * 0.55, [1, 1.58, 2.25], rand(240, 360), 0.22);
    noiseHit(env, t + 0.015, v * 0.42, rand(900, 1600), 0.38, 1.1);
  },
 // 문 닫힘 (door_slam): 스크린샷 슬라이더 설정값 100% 적용 코드
  door_slam(env, t, v) {
    const { ctx } = env;

    // 1. 찰칵 (래치 피치: 5700Hz, 금속 선명도: 0.90) - 래치 체결 금속 스냅
    noiseHit(env, t, v * 0.90, 5700, 0.012, 5.0);
    noiseHit(env, t + 0.008, v * 0.675, 6555, 0.010, 4.5); // 5700Hz * 1.15 차음

    // 2. 탁 (문틀 타격감: 0.080초) - 프레임 충격 패킹음
    noiseHit(env, t + 0.003, v * 0.85, 1600, 0.080, 2.5);
    noiseHit(env, t + 0.005, v * 0.50, 2800, 0.048, 3.2);

    // 3. 쿵/둥 (본체 저음 피치: 85Hz, 본체 울림 길이: 0.76초) - 서브파 및 공명 잔향
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(0.0001, t);
    sub.gain.linearRampToValueAtTime(0.85 * v, t + 0.006);
    sub.gain.exponentialRampToValueAtTime(0.0001, t + 0.76);
    sub.connect(env.out);
    
    // 85Hz 서브 스위프 및 0.76초 여운
    sine(ctx, sub, t + 0.002, 85, 0.35, 0.18, 0.76);

    // 본체 목재 공명 (85Hz 기반 187Hz 톤 모달, 0.53초 잔향)
    modal(env, t + 0.004, v * 1.1, [1, 2.1, 3.85], 187, 0.53);
  },
  glass_clink(env, t, v) {
  // 반음 2개 낮추기: 기존 주파수의 약 0.891배
  const pitch = 2 ** (-2 / 12);
  const f0 = rand(2200, 2900) * pitch;

  // 한 번만 타격하고, 약 2초 동안 자연스럽게 감쇠
  modal(
    env,
    t,
    v * 0.7,
    [1, 2.32, 4.18, 6.4],
    f0,
    2.0,
    env.out,
    true,
  );
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


/** The supported effects are exactly the hand-tuned synthesizers in this module. */
export const SFX_TYPES = Object.freeze(Object.keys(SFX_FX));

/** Route every voice, including stereo footsteps, through the same stoppable effect output. */
export function playSfx(env, type, at, strength = 0.7, hooks = {}) {
  if (!Object.hasOwn(SFX_FX, type)) return false;
  const value = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0.7;
  if (type === "sudden_silence") { hooks.duck?.(at); return true; }
  if (value === 0) return true;
  const level = env.ctx.createGain();
  level.gain.value = SFX_LEVEL[type] ?? 1;
  level.connect(env.out);
  SFX_FX[type]({ ...env, out: level, sfxOut: level }, at, value, hooks);
  return true;
}
