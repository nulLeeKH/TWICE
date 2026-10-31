import { SYSTEM, analyze } from "@twice/director";
import { CHAPTER_SCHEMA, CHAPTER_SYSTEM, type ChapterChunk, type ChapterPlanRow } from "../domain/chapter";
import type { AnalysisProgress, AnalysisResult, Availability, Batch, Decision, ModelState, Playback } from "../domain/types";

interface ModelSession {
  clone(options?: { signal?: AbortSignal }): Promise<ModelSession>;
  prompt(input: string, options?: Record<string, unknown>): Promise<string>;
  promptStreaming?: (input: string, options?: Record<string, unknown>) => AsyncIterable<string>;
  destroy(): void;
}
interface Factory<T> {
  availability(options: Record<string, unknown>): Promise<Availability>;
  create(options: Record<string, unknown>): Promise<T>;
}
export interface AiHost { LanguageModel?: Factory<ModelSession> }
/** An OpenAI-compatible endpoint the user chose in settings. Off unless saved there. */
export interface ExternalModel { baseURL: string; apiKey: string; model: string }
// Story text goes in untranslated (Korean or English); the system prompt and the JSON output are English.
const LM = { expectedInputs: [{ type: "text" }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const destroyed = new WeakSet<object>();
function destroy(session: { destroy(): void } | null | undefined) {
  if (!session || destroyed.has(session)) return;
  destroyed.add(session); try { session.destroy(); } catch {}
}
function supported(factory: Factory<unknown> | undefined) { return !!factory && typeof factory.availability === "function" && typeof factory.create === "function"; }
const unavailable = "Chrome 설정·기기 지원 여부를 단정할 수 없어 기기 상태 확인이 필요합니다.";

export class ModelError extends Error {
  constructor(readonly code: "unsupported" | "unavailable" | "timeout" | "permission" | "download" | "not-ready" | "inference", message: string) { super(message); this.name = "ModelError"; }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function classify(error: unknown): ModelError {
  const name = error instanceof Error ? error.name : "";
  if (error instanceof ModelError) return error;
  if (name === "NotAllowedError" || name === "SecurityError") return new ModelError("permission", "모델 준비가 허용되지 않았습니다. 준비 버튼을 직접 눌러 주세요.");
  if (name === "NotSupportedError") return new ModelError("unavailable", `요청한 모델을 사용할 수 없습니다. ${unavailable}`);
  if (name === "NetworkError" || name === "NotReadableError") return new ModelError("download", "모델 다운로드 실패. 네트워크와 저장 공간을 확인해 주세요.");
  if (name === "QuotaExceededError") return new ModelError("inference", "입력 한도를 초과했습니다. 다시 연결하면 초기화됩니다.");
  return new ModelError("inference", `AI 오류: ${errorMessage(error)}`);
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ModelError("timeout", "상태 확인이 지연되고 있습니다.")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** OpenAI-compatible chat completions behind the same session interface analyze() drives. No streaming. */
export function openAiSession(config: ExternalModel): ModelSession {
  const session: ModelSession = {
    clone: async () => session,
    destroy() {},
    async prompt(input, options = {}) {
      const response = await fetch(`${config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: options.signal as AbortSignal | undefined,
        headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: config.model, temperature: 0.2,
          messages: [{ role: "system", content: typeof options.systemPrompt === "string" ? options.systemPrompt : SYSTEM }, { role: "user", content: input }],
          response_format: { type: "json_schema", json_schema: { name: "scene", schema: options.responseConstraint } },
        }),
      });
      if (!response.ok) throw new ModelError("inference", `외부 모델 오류 ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const content = (await response.json())?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new ModelError("inference", "외부 모델 응답이 비어 있습니다");
      return content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    },
  };
  return session;
}

/** Model ids from an OpenAI-compatible `GET {baseURL}/models`, for the settings picker. */
export async function listModels(config: Pick<ExternalModel, "baseURL" | "apiKey">): Promise<string[]> {
  const response = await fetch(`${config.baseURL.replace(/\/+$/, "")}/models`, { headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {} });
  if (!response.ok) throw new ModelError("inference", `모델 목록 오류 ${response.status}`);
  const ids = ((await response.json())?.data ?? []).map((item: { id?: unknown }) => item?.id).filter((id: unknown): id is string => typeof id === "string");
  if (!ids.length) throw new ModelError("inference", "모델 목록이 비어 있습니다");
  return ids.sort();
}

export class NanoClient {
  state: ModelState = { kind: "checking", title: "AI 확인 중", detail: "모델 상태를 확인합니다." };
  private base: ModelSession | null = null;
  private external: ExternalModel | null = null;
  private preparation: Promise<void> | null = null;
  private preparationAbort: AbortController | null = null;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(private host: AiHost = globalThis as AiHost, private timeout = 4000, private prepareTimeout = 45000) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get ready() { return !!this.base; }
  get preparing() { return this.preparation !== null; }
  get canPrepare() { return ["available", "downloadable", "downloading", "error"].includes(this.state.kind) && this.state.lm !== undefined && supported(this.host.LanguageModel) && this.state.lm !== "unavailable"; }
  private drop() { destroy(this.base); this.base = null; }
  private set(state: ModelState) { this.state = state; this.listeners.forEach(fn => fn()); }

  /** Switches analysis to an OpenAI-compatible endpoint, or back to Nano with null. Never falls back on its own. */
  setExternal(config: ExternalModel | null) {
    this.cancelPreparation(); this.revision++; this.drop(); this.external = config;
    if (!config) { void this.inspect(); return; }
    this.base = openAiSession(config);
    this.set({ kind: "ready", external: new URL(config.baseURL).host, title: "외부 API 사용 중", detail: "읽는 화면의 본문이 이 서버로 전송됩니다." });
  }

  async inspect(): Promise<ModelState> {
    if (this.preparation || this.external) return this.state;
    const revision = ++this.revision;
    this.set({ kind: "checking", title: "AI 확인 중", detail: "모델 상태를 확인합니다." });
    if (!supported(this.host.LanguageModel)) {
      this.drop();
      this.set({ kind: "unsupported", title: "AI 사용 불가", detail: "Gemini Nano API가 비활성화되어 있습니다." });
      return this.state;
    }
    try {
      const lm = await bounded(this.host.LanguageModel!.availability(LM), this.timeout);
      if (revision !== this.revision) return this.state;
      if (lm === "unavailable") {
        this.drop();
        this.set({ kind: "unavailable", lm, title: "Gemini Nano 사용 불가", detail: unavailable });
      } else if (this.ready) this.set({ kind: "ready", lm, title: "AI 준비 완료", detail: "기기 안에서 처리합니다." });
      else if (lm === "downloading") this.set({ kind: "downloading", lm, title: "모델 다운로드 중", detail: "준비 버튼으로 진행 상태를 연결할 수 있습니다." });
      else if (lm === "downloadable") this.set({ kind: "downloadable", lm, title: "모델 준비 필요", detail: "Gemini Nano 모델을 준비합니다." });
      else this.set({ kind: "available", lm, title: "모델 설치됨", detail: "시작하면 세션을 엽니다." });
    } catch (error) {
      if (revision === this.revision) this.set({ kind: "error", title: "상태 확인 실패", detail: classify(error).message });
    }
    return this.state;
  }

  prepare(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.preparation) return this.preparation;
    if (!supported(this.host.LanguageModel)) return Promise.reject(new ModelError("unsupported", "지원되는 AI API가 없습니다."));
    if (this.state.lm === "unavailable") return Promise.reject(new ModelError("unavailable", unavailable));
    const before = this.state, revision = ++this.revision;
    const controller = new AbortController(); this.preparationAbort = controller;
    this.set({ ...before, kind: "initializing", title: "모델 여는 중", detail: "세션을 준비합니다." });
    const monitor = (component: string, availability?: Availability) => (target: { addEventListener(type: string, fn: (event: { loaded: number }) => void): void }) => {
      target.addEventListener("downloadprogress", event => {
        if (revision !== this.revision || controller.signal.aborted) return;
        if (availability !== "downloadable" && availability !== "downloading") return;
        const progress = Math.max(0, Math.min(1, event.loaded));
        this.set({
          ...before, kind: progress < 1 ? "downloading" : "initializing", progress: progress < 1 ? progress : undefined, component,
          title: progress < 1 ? `${component} 다운로드 중` : "세션 초기화 중", detail: "최초 1회 다운로드합니다.",
        });
      });
    };
    const invoke = <T>(fn: () => Promise<T>): Promise<T> => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
    const lm = invoke(() => this.host.LanguageModel!.create({ ...LM, signal: controller.signal, initialPrompts: [{ role: "system", content: SYSTEM }], temperature: 0.2, topK: 3, monitor: monitor("Gemini Nano", before.lm) }));
    void lm.then(session => { if (revision !== this.revision || controller.signal.aborted) destroy(session); }, () => {});
    const timeout = setTimeout(() => controller.abort(new DOMException("모델 준비 시간 초과", "TimeoutError")), this.prepareTimeout);
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    this.preparation = (async () => {
      try {
        const base = await Promise.race([lm, cancelled]);
        if (revision !== this.revision || controller.signal.aborted || !base) {
          destroy(base);
          throw new DOMException("모델 준비 취소", "AbortError");
        }
        this.base = base;
        this.set({ kind: "ready", lm: "available", title: "AI 준비 완료", detail: "기기 안에서 처리합니다." });
      } catch (error) {
        if (revision !== this.revision || (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError")) {
          throw new DOMException("모델 준비 취소", "AbortError");
        }
        throw classify(error);
      }
    })().catch(error => {
      if (revision === this.revision && (!controller.signal.aborted || controller.signal.reason?.name === "TimeoutError")) this.set({ ...before, kind: "error", title: "모델 준비 실패", detail: classify(error).message });
      throw error;
    }).finally(() => { clearTimeout(timeout); if (this.preparationAbort === controller) { this.preparation = null; this.preparationAbort = null; this.listeners.forEach(fn => fn()); } });
    return this.preparation;
  }

  cancelPreparation() {
    if (!this.preparationAbort) return;
    this.preparationAbort?.abort(new DOMException("모델 준비 취소", "AbortError")); this.revision++;
    this.preparationAbort = null; this.preparation = null;
    this.set({ kind: "error", title: "준비 취소됨", detail: "필요할 때 다시 준비할 수 있습니다." });
  }

  /** Analyze multiple labelled reading sections in one request, not one request per screen. */
  async planChapter(chunk: ChapterChunk, signal: AbortSignal, context = ""): Promise<ChapterPlanRow[]> {
    if (!this.ready || !this.base) throw new ModelError("not-ready", "모델 준비가 필요합니다.");
    signal.throwIfAborted();
    const session = await this.base.clone({ signal });
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException("취소", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const prompt = `${CHAPTER_SYSTEM}\nReturn segments for these section ids, in order: ${chunk.sections.map(s => s.id).join(", ")}\n${context ? `Surrounding story for continuity ONLY (do not score these lines or trigger effects from them):\n${context}\n` : ""}${chunk.text}`;
      const raw = await Promise.race([
        session.prompt(prompt, { responseConstraint: CHAPTER_SCHEMA, signal, systemPrompt: CHAPTER_SYSTEM }),
        cancelled,
      ]);
      signal.throwIfAborted();
      const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { segments?: ChapterPlanRow[] };
      if (!Array.isArray(parsed.segments)) throw new ModelError("inference", "사전 분석 응답 형식이 올바르지 않습니다.");
      return parsed.segments;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      try { session.destroy(); } catch {}
    }
  }

  async decide(batch: Batch, previous: Decision | null, playback: Playback, signal: AbortSignal, onProgress: (progress: AnalysisProgress) => void): Promise<AnalysisResult> {
    if (!this.ready) throw new ModelError("not-ready", "모델 준비가 필요합니다.");
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = analyze(batch.texts, Math.min(...batch.ids), previous, { ...playback, ...batch, signal }, onProgress, { base: this.base });
      return await Promise.race([result, cancelled]) as AnalysisResult;
    } catch (error) {
      if (signal.aborted) {
        if (signal.reason?.name === "TimeoutError" && !this.external) {
          this.drop();
          this.set({ kind: "error", lm: "available", title: "응답 지연", detail: "다시 시도하면 세션을 새로 엽니다." });
        }
        throw signal.reason;
      }
      const failure = classify(error);
      if (!this.external && ["NotSupportedError", "InvalidStateError", "NotReadableError"].includes(error instanceof Error ? error.name : "")) {
        this.drop();
        this.set({ kind: "error", title: "모델 재연결 필요", detail: failure.message });
      }
      throw failure;
    } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }
  dispose() { this.cancelPreparation(); this.drop(); this.listeners.clear(); }
}
