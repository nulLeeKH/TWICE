// pnpm test:audio — renders the audio engine offline in headless Chrome for Testing: every mood plays, mood changes
// crossfade without gaps, bars never end in silence, nothing clips, ducking/pause recover, every effect is audible
// (with a per-effect loudness report against the music) and repeated SFX differ.
// Env: CHROME = Chrome for Testing binary; AUDIO_JS = alternative audio.js to serve (e.g. an older copy, to see the checks fail).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src");
const CHROME =
  process.env.CHROME ??
  path.join(os.homedir(), ".cache/puppeteer/chrome/mac_arm-152.0.7977.42/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

if (!fs.existsSync(CHROME)) throw new Error("Chrome for Testing을 찾지 못했습니다. CHROME 환경 변수에 실행 파일을 지정해 주세요.");

// Serves the DSP modules for offline Web Audio testing.
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>audio-check</title>");
  const routes = { "/audio.js": path.join(root,"audio/audio.js"), "/music.js":path.join(root,"audio/music.js"), "/score.js":path.join(root,"domain/score.js") };
  const f = p === "/audio.js" && process.env.AUDIO_JS ? path.resolve(process.env.AUDIO_JS) : routes[p] ?? path.join(root,p);
  if (!fs.existsSync(f) || (!f.startsWith(root) && f !== path.resolve(process.env.AUDIO_JS ?? ""))) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/javascript" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twice-audio-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);

// CDP over fds 3/4, NUL-delimited JSON
const [, , , out, inp] = chrome.stdio;
inp.setEncoding("utf8");
let id = 0, buf = "";
const pending = new Map();
inp.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\0")) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  }
});
function cdp(method, params = {}, sessionId) {
  const mid = ++id;
  out.write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 480000);
    pending.set(mid, (m) => (clearTimeout(t), m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  });
}

// runs in the page: renders on an OfflineAudioContext, pausing every 16 quanta so the engine's setInterval scheduler and `at` actions can run
const PAGE = `(async () => {
  const { createEngine } = await import("/audio.js");
  const { normalizeSegment } = await import("/score.js");
  const SR = 44100, DT = (128 * 16) / SR;
  async function render(sec, setup, actions = []) {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * sec), SR);
    const e = createEngine(ctx);
    setup?.(e);
    for (let k = 1; k * DT < sec - DT; k++)
      ctx.suspend(k * DT).then(async () => {
        for (const a of actions) if (!a.done && ctx.currentTime >= a.at) (a.done = true), a.fn(e);
        await new Promise((r) => setTimeout(r, 40));
        ctx.resume();
      });
    const b = await ctx.startRendering();
    try { e.close(); } catch {}
    return b;
  }
  const mono = (b) => { const l = b.getChannelData(0), r = b.getChannelData(1); return l.map((x, i) => (x + r[i]) / 2); };
  const peak = (b) => Math.max(...[0, 1].map((c) => b.getChannelData(c).reduce((m, x) => Math.max(m, Math.abs(x)), 0)));
  const envl = (b) => { const d = mono(b), n = 441, o = []; for (let i = 0; i + n <= d.length; i += n) { let s = 0; for (let j = i; j < i + n; j++) s += d[j] * d[j]; o.push(Math.sqrt(s / n)); } return o; };
  const diff = (a, b) => { let s = 0, m = 0; for (let i = 0; i < a.length; i++) (s += Math.abs(a[i] - b[i])), (m += a[i]); return s / m; };
  const R = {};

  // (a) two ducks 0.2 s apart, then 1 s later the duck gain is back to where it started
  let v0, vLow, vEnd;
  const node = (e) => (e.duckGain ?? e.master).gain;
  await render(1.6, (e) => { v0 = node(e).value; e.sfx("sudden_silence"); }, [
    { at: 0.09, fn: (e) => (vLow = node(e).value) },
    { at: 0.2, fn: (e) => e.sfx("sudden_silence") },
    { at: 1.25, fn: (e) => (vEnd = node(e).value) },
  ]);
  R.duck = { v0, vLow, vEnd };

  // Sustained silence must finish in 2 s and survive transient ducking, then resume.
  let hushLow, hushEnd, masterEnd;
  await render(3.5, e => e.hush(true, 2), [
    { at: 0.4, fn: e => e.sfx("sudden_silence") },
    { at: 2.1, fn: e => { hushLow=e.hushGain.gain.value; e.hush(false,0.5); } },
    { at: 3, fn: e => { hushEnd=e.hushGain.gain.value; masterEnd=e.master.gain.value; } },
  ]);
  R.hush={hushLow,hushEnd,masterEnd};

  let pauseLow, pauseEnd, ambientBus;
  await render(3, e=>e.pauseMusic(true,1),[
    {at:1.2,fn:e=>{pauseLow=e.musicPauseGain.gain.value; ambientBus=e.mix.ambience.gain.value; e.pauseMusic(false,0.5);}},
    {at:2.2,fn:e=>{pauseEnd=e.musicPauseGain.gain.value;}},
  ]);
  R.musicPause={pauseLow,pauseEnd,ambientBus};

  // (b) busy scene + loud SFX: output must not clip
  const scene = normalizeSegment({ mood: "tension", intensity: 1, room: 0.8, ambience: [
    { engine: "aero", p1: 1, p2: 1, p3: 1 }, { engine: "particle", variant: "glass", p1: 0.9, p2: 1, p3: 0.5 }, { engine: "psycho", p1: 1, p2: 1, p3: 1 } ] });
  const loud = (types) => (e) => types.forEach((t) => e.sfx(t, 1));
  const busy = await render(7, (e) => e.setScene(scene), [
    { at: 2, fn: e => { const before=e.piece; e.updateScene({...scene,room:0.3,intensity:0.4}); R.noMusicReset=!!before && e.piece===before; } },
    { at: 3, fn: loud(["glass_shatter", "impact_metal", "sub_drop", "knock"]) },
    { at: 3.5, fn: loud(["glass_shatter", "impact_metal"]) },
    { at: 4, fn: loud(["knock", "sub_drop", "glass_shatter"]) },
  ]);
  R.peak = peak(busy);
  R.rms = Math.sqrt(mono(busy).reduce((s, x) => s + x * x, 0) / busy.length);

  R.music={};
  const { MOODS } = await import("/score.js");
  for (const mood of Object.keys(MOODS)) {
    const b=await render(3,e=>e.setScene(normalizeSegment({mood,intensity:0.6})));
    R.music[mood]=Math.sqrt(mono(b).reduce((n,x)=>n+x*x,0)/b.length);
  }
  // a mood change crossfades: the old piece keeps sounding until the new one is in, with no gap between them
  {
    let moodAfter;
    const b=await render(12,e=>e.setScene(normalizeSegment({mood:"calm",intensity:0.5})),[
      {at:4,fn:e=>e.setScene(normalizeSegment({mood:"battle",intensity:0.7}))},
      {at:11,fn:e=>{moodAfter=e.piece?.mood;}},
    ]);
    const x=mono(b), span=4410; let floor=Infinity;
    for(let i=44100*3;i<44100*11-span;i+=span){let pw=0;for(let j=i;j<i+span;j++)pw+=x[j]*x[j];floor=Math.min(floor,Math.sqrt(pw/span));}
    R.crossfade={floor,moodAfter};
  }
  const random=Math.random;
  let continuity;
  try {
    continuity=await render(7,e=>{Math.random=()=>0.99; e.setScene(normalizeSegment({mood:"mystic",intensity:0.5}));});
  } finally {Math.random=random;}
  const samples=mono(continuity), span=4410;
  let floor=Infinity;
  for(let i=44100;i<samples.length-span-4410;i+=span) {
    let power=0; for(let j=i;j<i+span;j++) power+=samples[j]*samples[j];
    floor=Math.min(floor,Math.sqrt(power/span));
  }
  R.continuityFloor=floor;

  // Realtime, muted browser: hold the main thread across a bar line as a completed Nano/UI task can do.
  {
    const ctx=new AudioContext(), e=createEngine(ctx), meter=ctx.createAnalyser(); meter.fftSize=8192;
    e.mix.music.connect(meter); await ctx.resume();
    e.setScene(normalizeSegment({mood:"battle",intensity:0.8}));
    while(ctx.currentTime<1.85) await new Promise(r=>setTimeout(r,10));
    const t=performance.now(); while(performance.now()-t<500) {}
    const data=new Float32Array(8192); meter.getFloatTimeDomainData(data);
    const rms=Math.sqrt(data.reduce((n,x)=>n+x*x,0)/data.length);
    await new Promise(r=>setTimeout(r,40));
    R.completionStall={rms,...e.timing};
    await e.close();
  }

  // (c) the same SFX five times: envelopes must differ, not just the noise
  for (const [type, sec] of [["knock", 1.5], ["footsteps", 5]]) {
    const envs = [];
    for (let i = 0; i < 5; i++) envs.push(envl(await render(sec, (e) => e.sfx(type, 0.7))));
    let min = Infinity;
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) min = Math.min(min, diff(envs[i], envs[j]));
    R[type] = min;
  }
  // every effect alone over a paused music bed: loudest 300 ms window and peak, reported against the music level
  {
    const { SFX } = await import("/score.js");
    const loud = (b) => { const x = mono(b), n = 13230; let best = 0; for (let i = 0; i + n <= x.length; i += 2205) { let p = 0; for (let j = i; j < i + n; j++) p += x[j] * x[j]; best = Math.max(best, Math.sqrt(p / n)); } return best; };
    R.musicLoud = loud(await render(5, e => e.setScene(normalizeSegment({ mood: "calm", intensity: 0.5 }))));
    R.sfx = {};
    for (const type of SFX.filter(t => t !== "sudden_silence")) {
      const b = await render(3, e => { e.setScene(normalizeSegment({ mood: "calm", intensity: 0.5 })); e.pauseMusic(true, 0.01); }, [{ at: 0.3, fn: e => e.sfx(type, 0.8) }]);
      R.sfx[type] = { peak: peak(b), rms: loud(b) };
    }
  }
  return JSON.stringify(R);
})()`;

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};
try {
  const { targetId } = await cdp("Target.createTarget", { url: base + "/" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await new Promise((r) => setTimeout(r, 500));
  const r = await cdp("Runtime.evaluate", { expression: PAGE, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  const R = JSON.parse(r.result.value);
  const f = (x) => (x ?? NaN).toFixed(4);
  check("(a) duck recovers after two calls 0.2 s apart", R.duck.vLow < 0.05 && Math.abs(R.duck.vEnd - R.duck.v0) < 0.01, `start ${f(R.duck.v0)}, dip ${f(R.duck.vLow)}, 1 s after 2nd ${f(R.duck.vEnd)}`);
  check("hush fades independently and resumes", R.hush.hushLow < 0.001 && R.hush.hushEnd > 0.99 && Math.abs(R.hush.masterEnd-0.8)<0.001, JSON.stringify(R.hush));
  check("music pause leaves ambience bus alone and resumes",R.musicPause.pauseLow<0.01 && R.musicPause.pauseEnd>0.99 && R.musicPause.ambientBus===1,JSON.stringify(R.musicPause));
  check("ambience update preserves music sequence", R.noMusicReset, String(R.noMusicReset));
  check("(b) busy scene + loud SFX peak <= 1.0", R.peak <= 1, `peak ${f(R.peak)}, rms ${f(R.rms)}`);
  for (const [name,rms] of Object.entries(R.music)) check(`music only: ${name}`,rms>0.001,`rms ${f(rms)}`);
  check("mood change crossfades without a gap",R.crossfade.floor>0.0005 && R.crossfade.moodAfter==="battle",JSON.stringify(R.crossfade));
  check("music has no silent bar/phrase endings",R.continuityFloor>0.00001,`minimum 100ms rms ${f(R.continuityFloor)}`);
  check("music survives a 500ms completion/UI stall",R.completionStall.rms>0.001 && R.completionStall.lateBars===0 && R.completionStall.maxMainGapMs>=450,JSON.stringify(R.completionStall));
  for (const [type, x] of Object.entries(R.sfx)) console.log(`     sfx ${type.padEnd(16)} peak ${f(x.peak)}  loudest 300ms ${(20 * Math.log10(x.rms / R.musicLoud)).toFixed(1)} dB vs music`);
  const sfx = Object.values(R.sfx);
  check("every effect is audible and below clipping", sfx.every(x => x.peak <= 1 && x.rms > 0.005), `${sfx.length} effects, max peak ${f(Math.max(...sfx.map(x => x.peak)))}, min loudest rms ${f(Math.min(...sfx.map(x => x.rms)))}`);
  for (const t of ["knock", "footsteps"]) check(`(c) ${t} x5 envelopes differ`, R[t] > 0.1, `min pairwise envelope diff ${f(R[t])} (> 0.1)`);
} catch (e) {
  console.error("ERROR", e);
  results.push(false);
} finally {
  chrome.kill();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
