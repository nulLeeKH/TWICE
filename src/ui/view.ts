import { bindStaticCopy, i18n, t, type UiLanguage } from "./i18n";
import type { Ambience, Decision, ModelState } from "../domain/types";
import { arrangement } from "@twice/sound";
import type { NanoClient } from "../model/nano";
import type { ReaderRuntime } from "../session/runtime";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const moodNames: Record<string, string> = {
  calm: "평온", hope: "희망", romance: "로맨스", comedy: "유쾌", adventure: "모험", growth: "성장", epic: "장엄",
  sad: "슬픔", tragic: "비극", dark: "어둠", tension: "긴장", horror: "공포", mystery: "미스터리",
  battle: "전투", anger: "분노", mystic: "신비",
};
const moodPalettes: Record<string, [[number, number, number], [number, number, number]]> = {
  calm: [[61, 214, 196], [86, 180, 211]],
  hope: [[247, 194, 92], [77, 214, 190]],
  romance: [[240, 120, 164], [176, 118, 245]],
  comedy: [[255, 179, 71], [255, 118, 136]],
  adventure: [[102, 217, 168], [242, 196, 109]],
  growth: [[245, 166, 72], [82, 176, 235]],
  epic: [[204, 164, 92], [104, 126, 196]],
  sad: [[78, 115, 214], [96, 86, 178]],
  tragic: [[224, 102, 86], [148, 78, 178]],
  dark: [[64, 78, 148], [132, 58, 116]],
  tension: [[235, 87, 87], [155, 81, 224]],
  horror: [[96, 214, 156], [124, 72, 204]],
  mystery: [[138, 96, 240], [52, 186, 162]],
  battle: [[255, 68, 92], [255, 168, 52]],
  anger: [[245, 92, 76], [138, 64, 255]],
  mystic: [[158, 122, 247], [74, 212, 216]],
};
const instruments: Record<string, string> = {
  piano: "피아노", rhodes: "로즈", music_box: "오르골", strings: "스트링", cello: "첼로",
  harp: "하프", marimba: "마림바", timpani: "팀파니", bass_drum: "큰북", frame_drum: "프레임 드럼", pulse_bass: "펄스 베이스", pad: "배경 화음", dark_pad: "어두운 화음",
};
const effects: Record<string, string> = {
  door_creak: "문 삐걱임", door_slam: "문 쾅 닫힘", footsteps: "발걸음", clock_ticks: "시계 초침", knock: "노크",
  impact_wood: "나무 충격", impact_metal: "금속 충격", glass_shatter: "유리 파열", sub_drop: "저음 낙하", sudden_silence: "순간 정적",
  chopping: "칼질", sizzle: "요리 지글거림", glass_clink: "잔 부딪힘", phone_ring: "전화벨",
  camera_shutter: "카메라 셔터", keyboard: "키보드 타이핑", sword_clash: "칼싸움", arrow_shot: "화살 발사", magic_blast: "마법 파열",
  slap_punch: "타격음", whoosh: "바람 가르기", gunshot: "총성", explosion: "폭발", collapse: "붕괴음",
  car_crash: "교통사고 충돌", tire_screech: "급브레이크", siren: "사이렌", thunder: "천둥", water_splash: "물보라",
  crow_caw: "까마귀 울음", dog_bark: "개 짖는 소리", gasp: "숨 들이키는 소리", heartbeat_thump: "심장 두근거림",
  airplane: "비행기", car_horn: "자동차 경적", train_horn: "기차 경적", bell: "종소리", page_turn: "책장 넘김",
  crowd_cheer: "환호·함성", scream: "비명·절규", evil_laugh: "비웃음·광소", sigh: "한숨·탄식",
  chain_rattle: "쇠사슬 소리", body_fall: "쓰러짐", blade_draw: "발도·칼 뽑기", flame_burst: "화염 폭발", low_rumble: "불길한 진동",
};
const musicActions: Record<string, string> = { keep: "유지", change: "변경", pause: "일시정지", resume: "재개" };

function layerName(layer: Ambience) {
  if (layer.engine === "aero") return ({ breeze: "산들바람", wind: "바람", blizzard: "눈보라" } as Record<string, string>)[layer.variant ?? "wind"] ?? "바람";
  if (layer.engine === "water") return ({ waves: "파도", stream: "시냇물", underwater: "수중", waterfall: "폭포" } as Record<string, string>)[layer.variant ?? "waves"] ?? "물소리";
  if (layer.engine === "particle") return ({ glass: "창가 비", soil: "빗소리", metal: "양철 지붕 비", leaf: "낙엽" } as Record<string, string>)[layer.variant ?? "glass"] ?? "빗소리";
  if (layer.engine === "fire") return "장작불";
  if (layer.engine === "storm") return layer.variant === "close" ? "가까운 천둥" : "먼 천둥";
  if (layer.engine === "hooves") return layer.variant === "carriage" ? "마차" : "말발굽";
  if (layer.engine === "tavern") return "선술집";
  if (layer.engine === "cave") return "동굴 물방울";
  if (layer.engine === "ship") return "갑판 삐걱임";
  if (layer.engine === "room") return "고요한 방";
  if (layer.engine === "bio") return ({ songbird: "새소리", cricket: "풀벌레", owl: "부엉이", seagull: "갈매기", crow: "까마귀", wolf: "늑대", cicada: "매미" } as Record<string, string>)[layer.variant ?? "songbird"] ?? "자연음";
  if (layer.engine === "urban") return ({ cafe: "카페 소음", traffic: "거리 소음", cabin: "객실 소음", kitchen: "주방 소음", crowd: "군중 소음", clockwork: "기계음" } as Record<string, string>)[layer.variant ?? "cafe"] ?? "실내 소음";
  return "심장 박동";
}

function meter(name: string, percent: number, label: string) {
  const row = document.createElement("div"); row.className = "meter";
  const title = document.createElement("span"); title.textContent = t(name);
  const track = document.createElement("div"); track.className = "track"; track.setAttribute("role", "meter"); track.setAttribute("aria-label", t(name)); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); track.setAttribute("aria-valuenow", String(Math.round(percent))); track.setAttribute("aria-valuetext", label);
  const fill = document.createElement("div"); fill.className = "fill"; fill.style.width = `${Math.max(0, Math.min(100, percent))}%`; track.append(fill);
  const output = document.createElement("output"); output.textContent = t(label); row.append(title, track, output); return row;
}

export class AppView {
  private queued = false;
  private disposed = false;
  private lastScene: Decision | null = null;
  private settingsOpen = false;
  private lastLanguage: UiLanguage | null = null;
  private applyStatic = bindStaticCopy(document.body);
  private cleanups: (() => void)[] = [];
  private auraFrame = 0;
  private phase = 0;
  private smoothLevel = 0.08;
  private curPrimary: [number, number, number] = [61, 214, 196];
  private curSecondary: [number, number, number] = [91, 124, 250];
  private targetPrimary: [number, number, number] = [61, 214, 196];
  private targetSecondary: [number, number, number] = [91, 124, 250];
  private orbs = Array.from({ length: 7 }, (_, i) => ({
    x: (i + 0.5) / 7,
    y: 0.3 + (i % 3) * 0.2,
    r: 16 + (i % 4) * 9,
    speed: 0.25 + (i % 5) * 0.12,
    offset: i * 1.3,
  }));

  constructor(private model: NanoClient, private runtime: ReaderRuntime) {
    this.cleanups.push(model.subscribe(() => this.schedule()), runtime.subscribe(() => this.schedule()), i18n.subscribe(() => this.schedule()));
    this.render();
    this.startAuraLoop();
  }
  schedule() { if (this.disposed || this.queued) return; this.queued = true; const render = () => { this.queued = false; if (!this.disposed) this.render(); }; if (document.hidden) queueMicrotask(render); else requestAnimationFrame(render); }
  toggleSettings(open = !this.settingsOpen) {
    this.settingsOpen = open; $("settings").hidden = !open; $("gear").setAttribute("aria-expanded", String(open));
    if (open) $("close-settings").focus({ preventScroll: true }); else $("gear").focus({ preventScroll: true });
  }
  private modelView(model: ModelState) {
    const healthy = ["ready", "available"].includes(model.kind);
    // An external API needs no on-device setup, so the Nano card stays out of the way.
    $("model-card").hidden = !!model.external || (healthy && !this.settingsOpen);
    $("model-card").dataset.kind = model.kind;
    $("model-title").textContent = t(model.title); $("model-detail").textContent = t(model.detail);
    $("model-dot").className = `model-dot ${healthy ? "ready" : ["error", "unsupported", "unavailable"].includes(model.kind) ? "warn" : ""}`;
    $("mode-chip").textContent = t(model.external ? "외부 API" : healthy ? "ON-DEVICE" : model.kind === "checking" ? "확인 중" : model.kind === "initializing" || model.kind === "downloading" ? "PREPARING" : "AI 필요");
    $("mode-chip").className = `chip ${model.external || ["error", "unsupported", "unavailable"].includes(model.kind) ? "warn" : ""}`;
    $("mode-chip").title = model.external ? `${model.external} · ${t("읽는 화면의 본문이 이 서버로 전송됩니다.")}` : "";
    const prepare = $<HTMLButtonElement>("prepare-model");
    prepare.hidden = ["checking", "unsupported", "unavailable", "ready"].includes(model.kind);
    prepare.disabled = !this.model.canPrepare || this.model.preparing;
    prepare.textContent = t(model.kind === "available" ? "모델 열기" : model.kind === "downloading" && !this.model.preparing ? "상태 연결" : this.model.preparing ? "준비 중…" : "준비");
    $<HTMLButtonElement>("recheck-model").disabled = model.kind === "checking" || this.model.preparing;
    $("cancel-model").hidden = !this.model.preparing;
    // When on-device AI cannot run here, offer the external API right where the problem is shown.
    $("switch-external").hidden = !["unsupported", "unavailable", "error"].includes(model.kind);
    const progress = $("model-progress"); progress.hidden = model.progress === undefined;
    if (model.progress !== undefined) { progress.setAttribute("aria-valuenow", String(Math.round(model.progress * 100))); (progress.firstElementChild as HTMLElement).style.width = `${model.progress * 100}%`; }
  }
  render() {
    const languageChanged = this.lastLanguage !== i18n.language;
    if (languageChanged) this.applyStatic();
    $("ui-language").setAttribute("aria-label", t("표시 언어"));
    $<HTMLSelectElement>("ui-language").value = i18n.language;
    this.modelView(this.model.state);
    const state = this.runtime.state, connected = this.runtime.connected;
    const playingNow = connected && !state.away && !state.userPaused;
    const canStart = (this.model.ready || this.model.state.kind === "available" || (this.model.state.kind === "error" && this.model.state.lm === "available")) && !this.model.preparing && state.status !== "connecting";
    const start = $<HTMLButtonElement>("start"); start.disabled = playingNow ? false : !canStart;
    start.textContent = t(state.status === "connecting" ? "연결 중…" : !connected ? "시작" : state.away ? "다시 연결" : state.userPaused ? "재개" : "멈춤");
    if (connected && !state.away) start.disabled = false;
    const audible = playingNow;
    $("site-mode").textContent = t(state.away ? "일시정지" : connected ? "읽는 중" : "현재 페이지");
    $("site-title").textContent = state.tabId === null ? t(state.title) : state.title;
    $("connection-dot").className = `connection-dot ${audible ? "ready" : ""}`;
    let status = state.message;
    if (state.away) status = state.message.includes("페이지 이동") ? state.message : "다른 탭 사용 중 · 일시정지";
    else if (state.userPaused) status = "일시정지됨";
    else if (state.analysisBusy && state.phase) status = state.phase;
    else if (state.analysisMode === "chapter-planning") status = "전체 회차 사전 분석 중 · 음악은 계속 재생";
    else if (state.analysisMode === "chapter-ready") status = "전체 회차 분석 완료 · 현재 위치 동기화";
    else if (state.analysisMode === "chapter-fallback") status = "사전 분석 불가 · 화면 OCR로 재생";
    if ($("status").textContent !== t(status)) $("status").textContent = t(status);
    $("status").className = `status ${state.status === "error" ? "error" : state.analysisBusy || state.status === "connecting" ? "busy" : ""}`;
    $("position").textContent = t(state.position);
    // Warnings: a failed analysis (with retry), or a response that is taking unusually long.
    const elapsed = this.runtime.debug.stage?.elapsed ?? 0, slow = state.analysisBusy && elapsed > 15000;
    const alert = state.alert ?? (slow ? `AI 응답이 늦어지고 있어요 · ${Math.round(elapsed / 1000)}초` : null);
    $("alert").hidden = !alert || !connected;
    $("alert-text").textContent = alert ? t(alert) : "";
    $("alert-retry").hidden = !state.alert;
    $("alert-settings").hidden = !state.alert || !this.model.state.external;
    $("stop").hidden = !connected;
    if (state.playing !== this.lastScene || languageChanged) { this.lastScene = state.playing; this.renderScene(state.playing); }
    $("music-status").textContent = t(
      state.away ? "자동 일시정지" :
      state.userPaused ? "일시정지" :
      state.hush === "non_story" ? "비본문 · 대기" :
      state.hush === "silence" ? "침묵" :
      state.musicPaused ? "음악 일시정지" :
      this.runtime.audio?.scene ? "재생 중" :
      connected ? "음악 준비 중" : "대기 중",
    );
    $("caption").textContent = t(state.hush === "non_story" ? "비본문 구간" : state.hush === "silence" ? "침묵 구간" : "");
    $("sfx-label").textContent = t(state.lastEffect ? effects[state.lastEffect.type] ?? state.lastEffect.type : "효과음 없음");
    for (const slider of document.querySelectorAll<HTMLInputElement>("[data-bus]")) {
      const bus = slider.dataset.bus as keyof typeof state.mix, value = Math.round(state.mix[bus] * 100);
      if (document.activeElement !== slider) slider.value = String(value);
      slider.style.setProperty("--val", `${value}%`); const output = slider.nextElementSibling; if (output) output.textContent = t(String(value));
      const muted = state.muted[bus]; slider.closest(".slider")?.classList.toggle("muted", muted);
      slider.parentElement?.querySelector("[data-mute]")?.setAttribute("aria-pressed", String(muted));
    }
    this.lastLanguage = i18n.language;
    this.renderDebug();
  }
  private renderScene(scene: Decision | null) {
    $("mood").textContent = t(scene ? moodNames[scene.mood] ?? scene.mood : "대기 중");
    const [p, s] = (scene && moodPalettes[scene.mood]) ?? [[61, 214, 196], [91, 124, 250]];
    this.targetPrimary = [...p];
    this.targetSecondary = [...s];
    const card = $("scene-card");
    if (card) {
      card.style.setProperty("--mood-primary", `rgb(${p[0]}, ${p[1]}, ${p[2]})`);
      card.style.setProperty("--mood-secondary", `rgb(${s[0]}, ${s[1]}, ${s[2]})`);
    }
    const plan = scene ? arrangement(scene.mood) : null, piece = this.runtime.audio?.piece;
    $("instrument").textContent = plan ? [plan.lead, ...plan.parts.map(part => part.instrument), ...(plan.percussion ?? []), plan.bed].filter((name, i, all) => name && all.indexOf(name) === i).map(name => t(instruments[name!] ?? name!)).join(" · ") : t("대기 중");
    $("pattern").textContent = piece ? `${piece.bpm} BPM · ${piece.bars.length}${t("마디")}` : "";
    const meters = $("meters"); meters.replaceChildren();
    meters.append(meter("강도", (scene?.intensity ?? 0) * 100, scene ? `${Math.round(scene.intensity * 100)}` : "—"));
    const layers = $("layers"); layers.replaceChildren();
    if (!scene?.ambience.length) {
      const empty = document.createElement("div"); empty.className = "empty-layer";
      empty.textContent = t("배경음 없음");
      layers.append(empty); return;
    }
    for (const layer of scene.ambience) {
      const card = document.createElement("div"); card.className = "layer";
      const dot = document.createElement("span"); dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("div"); text.className = "text";
      const name = document.createElement("div"); name.className = "name"; name.textContent = t(layerName(layer));
      if (layer.indoor) { const detail = document.createElement("div"); detail.className = "detail"; detail.textContent = t("실내에서 들림"); text.append(detail); }
      const level = document.createElement("span"); level.className = "level"; level.textContent = t(`${Math.round(layer.p1 * 100)}%`);
      text.prepend(name); card.append(dot, text, level); layers.append(card);
    }
  }
  private startAuraLoop() {
    let last = performance.now();
    const tick = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.08, Math.max(0.005, (now - last) / 1000));
      last = now;
      if (!document.hidden) this.drawAura(dt);
      this.auraFrame = requestAnimationFrame(tick);
    };
    this.auraFrame = requestAnimationFrame(tick);
  }
  private drawAura(dt: number) {
    const canvas = $<HTMLCanvasElement>("aura-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(240, canvas.clientWidth || 320);
    const h = Math.max(110, canvas.clientHeight || 132);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const state = this.runtime.state;
    const scene = state.playing;
    const active = this.runtime.connected && !state.away && !state.userPaused && !state.hush && !state.musicPaused;
    const rawRms = active ? (this.runtime.audio?.musicLevel?.() ?? 0) : 0;
    const sfxBoost = state.lastEffect && Date.now() - state.lastEffect.at < 900 ? (1 - (Date.now() - state.lastEffect.at) / 900) * 0.38 : 0;
    const targetLevel = active ? Math.min(1, 0.18 + rawRms * 5.2 + (scene?.intensity ?? 0.4) * 0.32 + sfxBoost) : 0.06;
    this.smoothLevel += (targetLevel - this.smoothLevel) * Math.min(1, dt * 6);

    const lerpRate = Math.min(1, dt * 1.4);
    for (const i of [0, 1, 2] as const) {
      this.curPrimary[i] += (this.targetPrimary[i] - this.curPrimary[i]) * lerpRate;
      this.curSecondary[i] += (this.targetSecondary[i] - this.curSecondary[i]) * lerpRate;
    }
    const [r1, g1, b1] = this.curPrimary.map(Math.round) as [number, number, number];
    const [r2, g2, b2] = this.curSecondary.map(Math.round) as [number, number, number];

    const bpm = this.runtime.audio?.piece?.bpm ?? 72;
    const speed = (active ? (bpm / 78) : 0.35) * (0.85 + this.smoothLevel * 0.9);
    this.phase += dt * speed * 2.1;

    // Soft glowing aurora orbs in the background
    for (let i = 0; i < this.orbs.length; i++) {
      const orb = this.orbs[i]!;
      const ox = ((orb.x + Math.sin(this.phase * orb.speed + orb.offset) * 0.14 + 1) % 1) * w;
      const oy = (orb.y + Math.cos(this.phase * (orb.speed * 0.8) + orb.offset) * 0.16) * h;
      const rad = (orb.r + this.smoothLevel * 22) * (0.8 + (scene?.room ?? 0.4) * 0.45);
      const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      const [cr, cg, cb] = i % 2 === 0 ? [r1, g1, b1] : [r2, g2, b2];
      const alpha = (active ? 0.18 : 0.08) + this.smoothLevel * 0.16;
      grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`);
      grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(ox, oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3 layered harmonic ribbon waves
    const midY = h * 0.56;
    const ampBase = h * (0.07 + this.smoothLevel * 0.26);
    for (let layer = 0; layer < 3; layer++) {
      const ratio = layer / 2;
      const cr = Math.round(r1 * (1 - ratio) + r2 * ratio);
      const cg = Math.round(g1 * (1 - ratio) + g2 * ratio);
      const cb = Math.round(b1 * (1 - ratio) + b2 * ratio);
      const freq = 1.6 + layer * 0.75 + ((bpm - 50) / 90) * 0.8;
      const phaseShift = this.phase * (1 + layer * 0.28) + layer * 1.4;
      const amp = ampBase * (1 - layer * 0.22);

      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const nx = x / w;
        const envelope = Math.sin(nx * Math.PI);
        const y =
          midY +
          (Math.sin(nx * Math.PI * 2 * freq + phaseShift) * 0.65 +
            Math.cos(nx * Math.PI * 3.3 * freq - phaseShift * 0.7) * 0.35) *
            amp *
            envelope;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const strokeAlpha = (active ? 0.55 : 0.22) - layer * 0.12 + this.smoothLevel * 0.25;
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${Math.max(0.12, Math.min(0.9, strokeAlpha)).toFixed(3)})`;
      ctx.lineWidth = 2.2 - layer * 0.4;
      ctx.stroke();

      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const fillGrad = ctx.createLinearGradient(0, midY - amp, 0, h);
      fillGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${(0.16 - layer * 0.04 + this.smoothLevel * 0.1).toFixed(3)})`);
      fillGrad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = fillGrad;
      ctx.fill();
    }

    ctx.restore();
  }
  renderDebug() {
    if (!$<HTMLDetailsElement>("debug").open) return;
    const data = this.runtime.diagnostics(), decision = data.proposed, applied = data.applied;
    const appliedMood = applied ? `${moodNames[applied.mood] ?? applied.mood} (${applied.mood})` : "대기";
    const rows: [string, string][] = [
      ["현재 화면", `${data.state.position || "연결 전"}${data.state.analysisBusy ? " · 분석 중" : ""}`],
      ["분위기", appliedMood],
      ["음악 제안", decision ? `${musicActions[decision.music_action] ?? decision.music_action} · ${decision.mood}` : "대기"],
      ["실제 적용", data.application || "대기"],
      ["배경 제안", decision ? (decision.model_ambience ?? decision.ambience).map(layerName).join(" + ") || "없음" : "대기"],
      ["현재 배경", data.applied?.ambience.map(layerName).join(" + ") || "없음"],
      ["효과음", data.effects || "없음"],
      ["제외 사유", decision?.guards?.join(" · ") || "없음"],
      ["판단 이유", decision?.reason || "—"],
      ["누적 맥락", data.context || "—"],
    ];
    const summary = $("decision-summary"); summary.replaceChildren();
    for (const [name, value] of rows) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = t(name); dd.textContent = ["판단 이유", "누적 맥락", "분위기"].includes(name) ? value : t(value); summary.append(dt, dd); }
    $("debug-output").textContent = JSON.stringify({ model: this.model.state, ...data }, null, 2);
    const canvas = $<HTMLCanvasElement>("preview"), source = this.runtime.preview;
    canvas.hidden = !source;
    if (source) { canvas.width = 280; canvas.height = Math.round(source.height * 280 / source.width); canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height); }
  }
  dispose() { this.disposed = true; if (this.auraFrame) cancelAnimationFrame(this.auraFrame); this.cleanups.forEach(fn => fn()); }
}
