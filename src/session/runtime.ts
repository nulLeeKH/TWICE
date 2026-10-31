import { browser } from "wxt/browser";
import { createEngine } from "../audio/audio.js";
import { Transcript } from "../domain/transcript";
import { ambienceChanged, navigationKind, normalizeSegment, SFX_GAP_S, shouldChangeMusic } from "../domain/score.js";
import { NanoClient } from "../model/nano";
import { Vision, type Snapshot } from "../vision/vision";
import type { AnalysisProgress, Decision, Diagnostics, Frame, Mix, Settled, Shot } from "../domain/types";

type Engine = ReturnType<typeof createEngine>;
type QueuedShot = { shot: Shot; snapshot: Snapshot; key: string; generation: number; episode: number };
export interface ReaderState {
  status: "idle" | "connecting" | "reading" | "away" | "error";
  message: string; title: string; url: string; tabId: number | null; windowId: number | null;
  userPaused: boolean; away: boolean; musicPaused: boolean; hush: "silence" | "non_story" | null;
  playing: Decision | null; lastEffect: { type: string; strength: number; at: number } | null;
  position: string; phase: string; ocrCount: number; ocrSkipped: number; dropped: number; lines: number;
  analysisBusy: boolean; ocrBusy: boolean; mix: Mix; muted: Record<keyof Mix, boolean>;
  /** Last analysis failure, shown as a warning until a decision succeeds or the user retries. */
  alert: string | null;
}
const DEFAULT_MIX: Mix = { master: 0.8, music: 0.8, ambience: 0.4, sfx: 0.78 };
const readableUrl = (url: string) => /^https?:\/\//.test(url);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ReaderRuntime {
  readonly transcript = new Transcript();
  readonly state: ReaderState = {
    status: "idle", message: "소설 탭을 연결해 주세요.", title: "소설 탭을 열어주세요", url: "", tabId: null, windowId: null,
    userPaused: false, away: false, musicPaused: false, hush: null, playing: null, lastEffect: null,
    position: "", phase: "", ocrCount: 0, ocrSkipped: 0, dropped: 0, lines: 0, analysisBusy: false, ocrBusy: false, mix: { ...DEFAULT_MIX }, muted: { master: false, music: false, ambience: false, sfx: false }, alert: null,
  };
  readonly debug: Diagnostics = { stage: null, input: "", raw: "", context: "", proposed: null, applied: null, application: "", effects: "", events: [], timing: {} };
  preview: OffscreenCanvas | null = null;
  private engine: Engine | null = null;
  private generation = 0;
  private episode = 0;
  private moving = false;
  private settled: Settled | null = null;
  private current: { key: string; view: number; range: [number, number] } | null = null;
  private shots: QueuedShot[] = [];
  private nextFrame: string | null = null;
  private previousScreen = "";
  private fired = new Set<string>();
  private lastEffect = -Infinity;
  private lastEffectKey = "";
  private lastMusicAt = -Infinity;
  private abort: AbortController | null = null;
  private connecting = false;
  private connectionIntent = 0;
  private transport: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private disposed = false;
  private readonly onMessage = (message: unknown, sender: { tab?: { id?: number } }) => {
    if (sender.tab?.id !== this.state.tabId || !message || typeof message !== "object") return;
    const event = message as { type: string } & Partial<Omit<Shot, "type"> & Settled>;
    if (event.type === "twice:moving") { this.moving = true; this.emit(); }
    else if (event.type === "twice:settle" && Array.isArray(event.range) && typeof event.view === "number") {
      this.moving = false; this.settled = event as Settled;
      this.state.position = `${event.mode === "paged" ? "페이지" : "스크롤"} · ${Math.round(event.range[0])}–${Math.round(event.range[1])}`;
      this.applyCurrent(); this.emit();
    } else if (event.type === "twice:shot" && event.rect && (event.vh ?? 0) > 0 && typeof event.view === "number" && Array.isArray(event.range)) void this.capture(event as Shot);
    else if (event.type === "twice:vis") void this.refreshTabTransport();
  };
  private readonly onActivated = (info: { tabId: number; windowId: number }) => {
    if (this.state.tabId === null || info.windowId !== this.state.windowId) return;
    this.state.away = info.tabId !== this.state.tabId;
    this.state.status = this.state.away ? "away" : "reading";
    this.state.message = this.state.away ? "다른 탭 사용 중 · 일시정지" : this.state.userPaused ? "일시정지" : "재생 중";
    void this.updateTransport(); this.emit();
  };
  private readonly onUpdated = (id: number, info: { status?: string; url?: string }, tab: { id?: number; url?: string; title?: string; active?: boolean; status?: string }) => {
    if (id !== this.state.tabId || !tab.url) return;
    if (tab.url !== this.state.url) {
      const kind = navigationKind(this.state.url, tab.url);
      if (kind === "leave") {
        this.abort?.abort(new DOMException("페이지 이동", "AbortError"));
        this.shots = []; this.nextFrame = null; this.current = null; this.settled = null; this.moving = false;
        this.waitingEpisode = false;
        this.state.away = true; this.state.userPaused = true; this.state.status = "away";
        this.state.url = tab.url; this.state.title = tab.title ?? this.state.title;
        this.state.lastEffect = null; this.lastEffectKey = ""; this.engine?.stopSfx?.(0.15);
        this.debug.context = "";
        this.state.message = "다른 페이지 이동 · 일시정지";
        this.event("다른 페이지 이동 · 자동 일시정지");
        void this.updateTransport(); this.emit(); return;
      }
      this.state.url = tab.url;
      if (kind === "episode") this.waitingEpisode = true;
    }
    if (this.waitingEpisode && (info.status === "complete" || tab.status === "complete")) {
      this.waitingEpisode = false; this.episode++; this.transcript.nextEpisode();
      this.shots = []; this.nextFrame = null; this.current = null; this.settled = null; this.moving = false;
      this.state.away = !tab.active; this.state.title = tab.title ?? this.state.title;
      this.state.lastEffect = null; this.lastEffectKey = ""; this.engine?.stopSfx?.(0.15);
      if (this.state.hush === "non_story") { this.engine?.hush(false, 1.5); this.state.hush = null; }
      this.state.message = "다음 화 이어서 재생 중";
      this.event("다음 화 · 음악/맥락 유지"); void this.inject(); void this.updateTransport();
    } else if (!this.state.away && info.status === "complete") {
      void this.inject();
    }
  };
  private waitingEpisode = false;
  private readonly onRemoved = (id: number) => { if (id === this.state.tabId) void this.stop("탭이 닫혀 연결을 종료했습니다."); };

  constructor(readonly model: NanoClient, private vision = new Vision()) {
    browser.runtime.onMessage.addListener(this.onMessage);
    browser.tabs.onActivated.addListener(this.onActivated);
    browser.tabs.onUpdated.addListener(this.onUpdated);
    browser.tabs.onRemoved.addListener(this.onRemoved);
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { if (!this.disposed) this.listeners.forEach(fn => fn()); }
  private event(text: string) { this.debug.events.unshift(`${new Date().toLocaleTimeString("ko-KR")} ${text}`); this.debug.events.length = Math.min(this.debug.events.length, 25); this.emit(); }
  get connected() { return this.state.tabId !== null; }
  get audio() { return this.engine; }
  get pendingCount() { return this.transcript.pending.size; }
  get queueCount() { return this.shots.length; }

  async loadPreferences() {
    try {
      const stored = await browser.storage.local.get(["mix", "muted"]);
      const saved = stored.mix as Partial<Mix> | undefined, muted = stored.muted as Partial<Record<keyof Mix, unknown>> | undefined;
      for (const bus of Object.keys(DEFAULT_MIX) as (keyof Mix)[]) {
        const value = saved?.[bus]; if (typeof value === "number" && Number.isFinite(value)) this.state.mix[bus] = Math.min(1, Math.max(0, value));
        this.state.muted[bus] = muted?.[bus] === true;
      }
    } catch { this.event("기본 볼륨 사용"); }
    this.applyMix(); this.emit();
  }

  async connect(): Promise<void> {
    if (this.connecting || this.disposed) return;
    this.connecting = true; const intent = ++this.connectionIntent;
    this.state.status = "connecting"; this.state.message = "연결 중…"; this.emit();
    const models = this.model.prepare();
    const prepared = models.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    const permission = browser.permissions.request({ origins: ["<all_urls>"] }).then(allowed => ({ allowed }), error => ({ allowed: false, error }));
    let nextEngine: Engine | null = null;
    try {
      nextEngine = createEngine(); await nextEngine.ctx.resume();
      const result = await prepared;
      if (!result.ok) throw result.error;
      if (!(await permission).allowed) throw new Error("웹사이트 접근 권한이 필요합니다.");
      if (intent !== this.connectionIntent || this.disposed) { await nextEngine?.close(); return; }
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.windowId || !tab.url || !readableUrl(tab.url)) throw new Error("보호된 페이지에는 연결할 수 없습니다. 일반 웹 소설 탭에서 시작해 주세요.");
      const oldTab = this.state.tabId; this.state.tabId = null;
      if (oldTab !== null) void browser.scripting.executeScript({ target: { tabId: oldTab }, func: () => (window as unknown as { __twice?: { destroy(): void } }).__twice?.destroy() }).catch(() => {});
      await this.clearSession(true);
      if (nextEngine) { this.engine = nextEngine; nextEngine = null; }
      this.engine ??= createEngine();
      Object.assign(this.state, { tabId: tab.id, windowId: tab.windowId, title: tab.title ?? "읽는 페이지", url: tab.url, status: "reading", userPaused: false, away: false, message: "화면을 읽는 중…" });
      this.applyMix(); await this.updateTransport(); await this.inject(); this.event("연결 시작");
    } catch (error) {
      await nextEngine?.close().catch(() => {});
      if (intent === this.connectionIntent) { this.state.status = this.connected ? "reading" : "error"; this.state.message = messageOf(error); this.emit(); }
    } finally { this.connecting = false; this.emit(); }
  }
  private async inject() {
    if (this.state.tabId === null) return;
    try { await browser.scripting.executeScript({ target: { tabId: this.state.tabId }, files: ["/reader.js"] }); }
    catch (error) { this.state.status = "error"; this.state.message = `페이지 연결 실패: ${messageOf(error)}`; this.emit(); }
  }
  private async refreshTabTransport() {
    const id = this.state.tabId; if (id === null) return;
    const tab = await browser.tabs.get(id).catch(() => null);
    if (!tab || id !== this.state.tabId) return;
    this.state.away = !tab.active; await this.updateTransport(); this.emit();
  }
  togglePause() { if (!this.connected) return; this.state.userPaused = !this.state.userPaused; void this.updateTransport(); this.emit(); }
  private updateTransport() {
    this.transport = this.transport.catch(() => {}).then(async () => {
      const engine = this.engine; if (!engine || engine.ctx.state === "closed") return;
      const run = this.connected && !this.state.userPaused && !this.state.away;
      if (run && engine.ctx.state !== "running") await engine.ctx.resume();
      if (!run && engine.ctx.state === "running") await engine.ctx.suspend();
    }).catch(error => {
      this.state.message = `오디오 상태 변경 실패: ${messageOf(error)}`;
    }).finally(() => this.emit());
    return this.transport;
  }
  /** Moving a slider also unmutes that bus. */
  setVolume(bus: keyof Mix, value: number) {
    this.state.mix[bus] = Math.min(1, Math.max(0, value)); this.state.muted[bus] = false; this.saveMix();
  }
  /** Mute keeps the slider value so unmuting restores it. */
  toggleMute(bus: keyof Mix) {
    this.state.muted[bus] = !this.state.muted[bus]; this.saveMix();
  }
  private saveMix() {
    this.applyMix(); this.emit();
    void browser.storage.local.set({ mix: this.state.mix, muted: this.state.muted }).catch(() => { this.state.message = "볼륨 저장 실패"; this.emit(); });
  }
  private applyMix() {
    if (!this.engine) return;
    for (const bus of Object.keys(DEFAULT_MIX) as (keyof Mix)[]) {
      const param = bus === "master" ? this.engine.master.gain : this.engine.mix[bus].gain;
      param.setTargetAtTime(this.state.muted[bus] ? 0 : this.state.mix[bus], this.engine.ctx.currentTime, 0.05);
    }
  }
  clearEffect() {
    this.state.lastEffect = null;
    this.lastEffectKey = "";
    this.engine?.stopSfx?.(0.15);
    this.emit();
  }

  private async capture(shot: Shot) {
    if (!this.connected || this.state.away || this.disposed) return;
    if (this.moving && this.pendingCount >= 400) { this.state.dropped++; this.emit(); return; }
    const tabId = this.state.tabId!, windowId = this.state.windowId!, generation = this.generation, episode = this.episode;
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab.active) return;
      const snapshot = await this.vision.snapshot(windowId, shot);
      const [reader] = await browser.scripting.executeScript({ target: { tabId }, func: () => (window as unknown as { __twice?: { state?: { view: number } } }).__twice?.state });
      const now = await browser.tabs.get(tabId);
      if (generation !== this.generation || episode !== this.episode || !now.active || reader?.result?.view !== shot.view) return;
      const key = `${episode}:${shot.paged ? snapshot.fingerprint : `${shot.top}:${snapshot.fingerprint}`}`;
      this.current = { key, view: shot.view, range: shot.range }; this.preview = snapshot.canvas;
      if (!this.shots.some(item => item.key === key)) {
        if (this.shots.length >= 6) { this.shots.pop(); this.state.dropped++; }
        this.shots.push({ shot, snapshot, key, generation, episode });
      }
      void this.drainOcr(); this.emit();
    } catch (error) { if (generation === this.generation && !this.state.away) { this.event(`캡처 대기: ${messageOf(error)}`); this.state.message = "화면 캡처 실패 · 다시 시도해 주세요."; this.emit(); } }
  }
  private async drainOcr() {
    if (this.state.ocrBusy) return; this.state.ocrBusy = true; this.emit();
    try {
      while (this.shots.length) {
        const item = this.shots.shift()!;
        if (item.generation !== this.generation || item.episode !== this.episode) continue;
        let frame = this.transcript.frames.get(item.key);
        if (frame) this.state.ocrSkipped++;
        else {
          try {
            const result = await this.vision.read(item.snapshot, item.shot);
            if (item.generation !== this.generation || item.episode !== this.episode) continue;
            this.state.ocrCount++; this.state.lines = result.stats.lines;
            this.debug.timing.ocr = result.stats.ms;
            frame = this.transcript.ingest(item.key, result.paragraphs, { range: item.shot.range, view: item.shot.view }, item.shot.paged, result.nonStory);
            if (frame.nonStory) frame.decision = normalizeSegment({ action: "non_story" }) as Decision;
          } catch (error) { this.state.message = `OCR 실패: ${messageOf(error)}`; this.event("OCR 오류"); continue; }
        }
        // An in-flight request always finishes; screens read meanwhile go out together as the next batch.
        this.transcript.enqueue(frame); this.nextFrame = frame.key;
        // Back from comments to story: lift the hush as soon as OCR sees story, not after the next model decision.
        // A cached non_story decision for this screen hushes again in applyCurrent.
        if (this.state.hush === "non_story" && !frame.nonStory && frame.ids.length && this.current?.key === frame.key && !this.moving) {
          this.engine?.hush(false, 1); this.state.hush = null; this.debug.application = "본문 복귀";
        }
        void this.drainModel(); this.applyCurrent(); this.emit();
      }
    } finally { this.state.ocrBusy = false; this.emit(); }
  }
  private async drainModel() {
    if (this.state.analysisBusy || !this.model.ready) return;
    this.state.analysisBusy = true;
    try {
      while (this.nextFrame && this.connected && this.model.ready) {
        const key = this.nextFrame; this.nextFrame = null;
        const frame = this.transcript.frames.get(key);
        if (!frame || frame.nonStory || !frame.ids.length) { this.applyCurrent(); continue; }
        const batch = this.transcript.take(frame), generation = this.generation;
        const abort = new AbortController(); this.abort = abort;
        const started = performance.now();
        this.debug.stage = { phase: "AI 분석 중", started: Date.now(), elapsed: 0, batch: { current: batch.currentIds.length, merged: batch.ids.length - batch.currentIds.length } };
        this.debug.input = batch.texts.join("\n"); this.debug.raw = "";
        const timeout = setTimeout(() => abort.abort(new DOMException("분석 시간 초과 (45초)", "TimeoutError")), 45000);
        const tick = setInterval(() => { if (generation === this.generation && this.debug.stage) { this.debug.stage.elapsed = performance.now() - started; this.emit(); } }, 400);
        const progress = (update: AnalysisProgress) => {
          if (generation !== this.generation || abort.signal.aborted) return;
          if (update.raw) this.debug.raw = update.raw;
          const phase = update.phase === "music" ? "음악 적용 · 배경음 분석 중" : update.phase === "ambience" ? "배경음 적용 · 효과음 확인 중" : update.phase === "nano" ? "AI 분석 중" : "적용 마무리 중";
          this.state.phase = phase; if (this.debug.stage) this.debug.stage.phase = phase;
          if (update.ms !== undefined) this.debug.timing[update.phase] = update.ms;
          if (update.decision && this.current?.key === key && !this.moving) { frame.decision = update.decision; this.applyCurrent(false); }
          this.emit();
        };
        try {
          const result = await this.model.decide(batch, this.state.playing, {
            sound: this.state.hush ?? "playing", musicStarted: !!this.engine?.scene, musicPaused: this.state.musicPaused,
            context: this.debug.context, previousScreen: this.previousScreen,
          }, abort.signal, progress);
          if (generation !== this.generation) continue;
          const decision = result.segments[0]; if (!decision) throw new Error("장면 결정 없음");
          frame.decision = decision;
          this.debug.context = result.context_summary || this.debug.context;
          this.previousScreen = batch.texts.filter((_, index) => batch.currentIds.includes(batch.ids[index]!)).join(" ").slice(-800);
          this.debug.raw = result.raw; Object.assign(this.debug.timing, result.ms);
          this.state.message = "재생 중"; this.state.alert = null;
          this.state.phase = "분석 완료"; if (this.debug.stage) this.debug.stage.phase = "분석 완료";
          this.event(`판단 완료 · 현재 ${batch.currentIds.length} + 누적 ${batch.ids.length - batch.currentIds.length}문단`);
          this.applyCurrent(true);
          if (!this.nextFrame && this.transcript.pending.size && this.transcript.frames.has(key)) this.nextFrame = key;
          this.transcript.prune(batch.currentIds);
        } catch (error) {
          if (generation === this.generation) {
            this.transcript.requeue(batch);
            if (abort.signal.aborted && this.nextFrame) continue;
            this.state.phase = "분석 실패";
            this.state.message = `${messageOf(error)} 마지막 소리는 유지합니다.`;
            this.state.alert = this.model.state?.external ? `외부 API 오류: ${messageOf(error)}` : messageOf(error);
            this.event("AI 요청 실패");
            this.nextFrame = null;
          }
        } finally { clearTimeout(timeout); clearInterval(tick); if (this.abort === abort) this.abort = null; this.emit(); }
      }
    } finally { this.state.analysisBusy = false; this.emit(); }
  }

  /** Retries the screen whose analysis failed, reopening the model session if a timeout closed it. */
  async retry() {
    this.state.alert = null; this.emit();
    if (!this.model.ready) await this.model.prepare();
    if (this.current) { this.nextFrame = this.current.key; void this.drainModel(); }
  }

  private currentFrame(): Frame | undefined {
    if (!this.current || !this.settled || this.current.view !== this.settled.view || this.current.range[0] !== this.settled.range[0] || this.current.range[1] !== this.settled.range[1]) return;
    return this.transcript.frames.get(this.current.key);
  }
  private applyCurrent(final = !this.state.analysisBusy) {
    if (!this.engine || this.moving) return;
    const frame = this.currentFrame(), decision = frame?.decision; if (!frame || !decision) return;
    this.debug.proposed = decision;
    if (decision.action === "non_story" || decision.action === "silence") {
      const reason = decision.action;
      if (this.state.hush !== reason) this.engine.hush(true, reason === "silence" ? 2 : 3);
      this.engine.stopSfx?.(0.2);
      this.state.hush = reason; this.state.lastEffect = null; this.lastEffectKey = "";
      this.debug.application = reason === "silence" ? "침묵 · 2초 페이드" : "비본문 · 3초 페이드";
      this.debug.effects = "침묵/비본문 제외"; this.emit(); return;
    }
    if (this.state.hush === "non_story" || (this.state.hush && ["change", "resume"].includes(decision.music_action))) { this.engine.hush(false, 1.5); this.state.hush = null; }
    const before = this.state.playing;
    const firstMusic = !this.engine.scene && decision.music_action !== "pause";
    const change = firstMusic || (!!before && shouldChangeMusic(before, decision, (Date.now() - this.lastMusicAt) / 1000));
    const held = !change && !!before && decision.music_action === "change" && decision.mood !== before.mood;
    // A held mood keeps the playing piece; only intensity and ambience follow the new screen.
    const applied: Decision = change || !before ? decision : { ...decision, mood: before.mood, room: before.room };
    if (decision.music_action === "pause") { this.engine.pauseMusic(true); this.state.musicPaused = true; }
    else if (["change", "resume"].includes(decision.music_action)) { this.engine.pauseMusic(false); this.state.musicPaused = false; }
    if (change) { this.engine.setScene(applied); this.lastMusicAt = Date.now(); }
    else if (before && (ambienceChanged(before.ambience, applied.ambience) || Math.abs(before.intensity - applied.intensity) >= 0.1)) this.engine.updateScene(applied);
    this.state.playing = applied;
    this.debug.applied = applied;
    this.debug.application = firstMusic ? "첫 음악" : change ? "음악 전환" : held ? "음악 유지" : decision.music_action === "pause" ? "음악 일시정지" : decision.music_action === "resume" ? "음악 재개" : "유지";
    const inFrameSfx = decision.sfx.filter(item => frame.ids.includes(item.p));
    const effect = inFrameSfx.find(item => !this.fired.has(`${this.transcript.paragraphs.get(item.p)?.key ?? item.p}:${item.type}`)) ?? inFrameSfx[0];
    if (!effect) {
      if (final && this.lastEffectKey && this.lastEffectKey !== frame.key) {
        this.state.lastEffect = null;
        this.lastEffectKey = "";
      }
      this.debug.effects = "없음";
    } else {
      const eventKey = `${this.transcript.paragraphs.get(effect.p)?.key ?? effect.p}:${effect.type}`;
      const gap = decision.sfx_interval_s ?? SFX_GAP_S;
      if (this.fired.has(eventKey)) this.debug.effects = "중복 제외";
      else if (this.state.hush || Date.now() - this.lastEffect < gap * 1000) this.debug.effects = `보류 · 최소 ${gap}초 간격`;
      else {
        this.fired.add(eventKey); if (this.fired.size > 2000) this.fired.delete(this.fired.values().next().value!);
        this.lastEffect = Date.now(); const strength = Math.min(Math.max(effect.p1, 0.6), 1);
        this.engine.sfx(effect.type, strength);
        this.state.lastEffect = { type: effect.type, strength, at: Date.now() };
        this.lastEffectKey = frame.key;
        this.debug.effects = `재생 · ${effect.type}`;
      }
    }
    this.emit();
  }

  private async clearSession(closeAudio: boolean) {
    this.generation++; this.episode = 0; this.abort?.abort(new DOMException("연결 초기화", "AbortError"));
    this.transcript.clear(); this.shots = []; this.nextFrame = null; this.current = null; this.settled = null; this.moving = false;
    this.waitingEpisode = false; this.previousScreen = ""; this.fired.clear(); this.lastEffect = -Infinity; this.lastEffectKey = ""; this.lastMusicAt = -Infinity; this.preview = null;
    Object.assign(this.debug, { stage: null, input: "", raw: "", context: "", proposed: null, applied: null, application: "", effects: "", timing: {}, events: [] });
    Object.assign(this.state, { playing: null, lastEffect: null, musicPaused: false, hush: null, alert: null, position: "", phase: "", ocrCount: 0, ocrSkipped: 0, dropped: 0, lines: 0 });
    if (closeAudio) { const old = this.engine; this.engine = null; if (old) await old.close().catch(() => {}); }
    else { this.engine?.stopAll(); this.engine?.hush(false, 0.05); this.engine?.pauseMusic(false, 0.05); }
  }
  async stop(message = "연결을 종료했습니다.") {
    this.connectionIntent++;
    if (this.connecting) this.model.cancelPreparation();
    const tabId = this.state.tabId; this.state.tabId = null;
    if (tabId !== null) void browser.scripting.executeScript({ target: { tabId }, func: () => (window as unknown as { __twice?: { destroy(): void } }).__twice?.destroy() }).catch(() => {});
    await this.clearSession(true);
    Object.assign(this.state, { status: "idle", message, title: "소설 탭을 열어주세요", url: "", windowId: null, userPaused: false, away: false }); this.emit();
  }
  diagnostics() { return { ...this.debug, state: { ...this.state, mix: { ...this.state.mix }, muted: { ...this.state.muted } }, queue: { capture: this.queueCount, paragraphs: this.pendingCount, merged: this.transcript.merged }, audio: this.engine ? { context: this.engine.ctx.state, started: !!this.engine.scene, musicGain: this.engine.musicPauseGain.gain.value, musicRms: this.engine.musicLevel(), timing: this.engine.timing } : null }; }
  async dispose() {
    this.disposed = true; this.listeners.clear(); browser.runtime.onMessage.removeListener(this.onMessage); browser.tabs.onActivated.removeListener(this.onActivated); browser.tabs.onUpdated.removeListener(this.onUpdated); browser.tabs.onRemoved.removeListener(this.onRemoved);
    await this.stop(); await this.vision.dispose(); this.model.dispose();
  }
}
