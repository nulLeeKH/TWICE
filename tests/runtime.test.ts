import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NanoClient } from "../src/model/nano";
const harness = vi.hoisted(() => {
  const event = () => {
    const listeners = new Set<(...args: unknown[]) => void>();
    return { listeners, addListener: (listener: (...args: unknown[]) => void) => listeners.add(listener), removeListener: (listener: (...args: unknown[]) => void) => listeners.delete(listener), emit: (...args: unknown[]) => { for (const listener of listeners) listener(...args); } };
  };
  const browser = {
    runtime: { onMessage: event() },
    tabs: { onActivated: event(), onUpdated: event(), onRemoved: event(), query: vi.fn(), get: vi.fn() },
    permissions: { request: vi.fn() }, scripting: { executeScript: vi.fn() }, storage: { local: { get: vi.fn(), set: vi.fn() } },
  };
  const engines: ReturnType<typeof engine>[] = [];
  function engine() {
    const param = () => ({ value: 1, setTargetAtTime: vi.fn() });
    const context = { state: "suspended", currentTime: 0, resume: vi.fn(async () => { context.state = "running"; }), suspend: vi.fn(async () => { context.state = "suspended"; }) };
    const result = { ctx: context, master: { gain: param() }, mix: { music: { gain: param() }, ambience: { gain: param() }, sfx: { gain: param() } }, musicPauseGain: { gain: param() }, scene: null as unknown,
      setScene: vi.fn((scene: unknown) => { result.scene = scene; }), updateScene: vi.fn(), hush: vi.fn(), pauseMusic: vi.fn(), stopAll: vi.fn(), stopSfx: vi.fn(), sfx: vi.fn(), musicLevel: () => 0.02, timing: { lateBars: 0 }, close: vi.fn(async () => { context.state = "closed"; }) };
    return result;
  }
  return { browser, engines, engine: () => { const result = engine(); engines.push(result); return result; } };
});
vi.mock("wxt/browser", () => ({ browser: harness.browser }));
vi.mock("../src/audio/audio.js", () => ({ createEngine: harness.engine }));
import { ReaderRuntime } from "../src/session/runtime";
let runtime: ReaderRuntime;
let model: { ready: boolean; prepare: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; cancelPreparation: ReturnType<typeof vi.fn> };
beforeEach(() => {
  harness.engines.length = 0;
  harness.browser.permissions.request.mockResolvedValue(true);
  harness.browser.tabs.query.mockResolvedValue([{ id: 1, windowId: 2, url: "https://read.test/work/1", title: "작품 첫 화", active: true }]);
  harness.browser.tabs.get.mockResolvedValue({ id: 1, active: true, windowId: 2 });
  harness.browser.scripting.executeScript.mockResolvedValue([]);
  harness.browser.storage.local.get.mockResolvedValue({}); harness.browser.storage.local.set.mockResolvedValue(undefined);
  model = { ready: true, prepare: vi.fn(async () => {}), decide: vi.fn(), dispose: vi.fn(), cancelPreparation: vi.fn() };
  runtime = new ReaderRuntime(model as unknown as NanoClient);
});
afterEach(async () => { await runtime.dispose(); vi.clearAllMocks(); });
describe("reader ownership and transport", () => {
  it("permission denial closes the new graph and leaves a retryable disconnected state", async () => {
    harness.browser.permissions.request.mockResolvedValue(false); await runtime.connect();
    expect(runtime.connected).toBe(false); expect(runtime.state.message).toContain("권한"); expect(harness.engines[0]!.close).toHaveBeenCalledTimes(1);
  });
  it("an unavailable model never leaves silent audio resources behind", async () => {
    model.prepare.mockRejectedValue(new Error("모델이 없습니다")); await runtime.connect();
    expect(runtime.connected).toBe(false); expect(runtime.state.message).toContain("모델이 없습니다"); expect(harness.engines[0]!.close).toHaveBeenCalled();
  });
  it("protected browser pages are rejected with a useful explanation", async () => {
    harness.browser.tabs.query.mockResolvedValue([{ id: 1, windowId: 2, url: "chrome://settings", title: "설정" }]); await runtime.connect();
    expect(runtime.state.status).toBe("error"); expect(runtime.state.message).toContain("보호된 페이지"); expect(runtime.connected).toBe(false);
  });
  it("tab pause/resume preserves manual pause instead of overriding user intent", async () => {
    await runtime.connect(); const engine = harness.engines[0]!;
    harness.browser.tabs.onActivated.emit({ tabId: 3, windowId: 2 }); await vi.waitFor(() => expect(engine.ctx.state).toBe("suspended"));
    harness.browser.tabs.onActivated.emit({ tabId: 1, windowId: 2 }); await vi.waitFor(() => expect(engine.ctx.state).toBe("running"));
    const observed: string[] = []; const unsubscribe = runtime.subscribe(() => observed.push(runtime.diagnostics().audio?.context ?? "none"));
    runtime.togglePause(); await vi.waitFor(() => expect(observed.at(-1)).toBe("suspended")); unsubscribe();
    harness.browser.tabs.onActivated.emit({ tabId: 3, windowId: 2 }); harness.browser.tabs.onActivated.emit({ tabId: 1, windowId: 2 });
    await Promise.resolve(); await Promise.resolve(); expect(engine.ctx.state).toBe("suspended"); expect(runtime.state.userPaused).toBe(true);
  });
  it("keeps audio and memory across episode paths, and auto-pauses on work exit for reconnection", async () => {
    await runtime.connect(); const engine = harness.engines[0]!; runtime.debug.context = "앞선 이야기의 맥락";
    harness.browser.tabs.onUpdated.emit(1, { status: "complete" }, { id: 1, active: true, status: "complete", url: "https://read.test/work/2", title: "다음 화" });
    expect(runtime.audio).toBe(engine); expect(engine.close).not.toHaveBeenCalled(); expect(runtime.debug.context).toBe("앞선 이야기의 맥락");
    harness.browser.tabs.onUpdated.emit(1, { status: "complete" }, { id: 1, active: true, status: "complete", url: "https://read.test/other/1" });
    await vi.waitFor(() => expect(engine.ctx.state).toBe("suspended"));
    expect(runtime.debug.context).toBe("");
    expect(runtime.state.away).toBe(true);
    expect(runtime.state.userPaused).toBe(true);
    expect(runtime.state.message).toContain("일시정지");
  });
  it("reinjects the reader after same-URL reload without resetting audio or context", async () => {
    await runtime.connect(); const engine = runtime.audio; runtime.debug.context = "이전 맥락";
    harness.browser.scripting.executeScript.mockClear();
    harness.browser.tabs.onUpdated.emit(1, { status: "complete" }, { id: 1, active: true, status: "complete", url: "https://read.test/work/1" });
    expect(harness.browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ["/reader.js"] });
    expect(runtime.audio).toBe(engine); expect(runtime.debug.context).toBe("이전 맥락");
  });
  it("does not mistake document navigation visibility for tab departure", async () => {
    await runtime.connect(); const engine = harness.engines[0]!;
    harness.browser.runtime.onMessage.emit({ type: "twice:vis", hidden: true }, { tab: { id: 1 } });
    await Promise.resolve(); await Promise.resolve(); expect(runtime.state.away).toBe(false); expect(engine.ctx.suspend).not.toHaveBeenCalled();
  });
  it("persists volume only, clamps invalid settings, and excludes story data", async () => {
    harness.browser.storage.local.get.mockResolvedValue({ mix: { master: 8, music: -1, ambience: Number.NaN, sfx: 0.3 } }); await runtime.loadPreferences();
    expect(runtime.state.mix).toEqual({ master: 1, music: 0, ambience: 0.4, sfx: 0.3 });
    runtime.setVolume("music", 0.7); expect(harness.browser.storage.local.set).toHaveBeenCalledWith({ mix: { master: 1, music: 0.7, ambience: 0.4, sfx: 0.3 }, muted: { master: false, music: false, ambience: false, sfx: false } });
  });
  it("mutes a bus without losing its level, restores mutes on load, and unmutes when the slider moves", async () => {
    harness.browser.storage.local.get.mockResolvedValue({ mix: { music: 0.5 }, muted: { ambience: true, sfx: "yes" } }); await runtime.loadPreferences();
    expect(runtime.state.muted).toEqual({ master: false, music: false, ambience: true, sfx: false });
    runtime.toggleMute("music"); expect(runtime.state.muted.music).toBe(true); expect(runtime.state.mix.music).toBe(0.5);
    expect(harness.browser.storage.local.set).toHaveBeenLastCalledWith(expect.objectContaining({ muted: expect.objectContaining({ music: true }) }));
    runtime.setVolume("music", 0.6); expect(runtime.state.muted.music).toBe(false); expect(runtime.state.mix.music).toBe(0.6);
  });
  it("clears active effect state and stops lingering SFX audio when requested", async () => {
    await runtime.connect(); const engine = harness.engines[0]!;
    runtime.state.lastEffect = { type: "knock", strength: 0.5, at: Date.now() };
    runtime.clearEffect();
    expect(runtime.state.lastEffect).toBeNull();
    expect(engine.stopSfx).toHaveBeenCalledTimes(1);
  });
});
