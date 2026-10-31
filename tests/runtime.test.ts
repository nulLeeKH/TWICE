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
let model: { ready: boolean; state: { external?: string }; prepare: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; planChapter: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; cancelPreparation: ReturnType<typeof vi.fn> };
beforeEach(() => {
  harness.engines.length = 0;
  harness.browser.permissions.request.mockResolvedValue(true);
  harness.browser.tabs.query.mockResolvedValue([{ id: 1, windowId: 2, url: "https://read.test/work/1", title: "작품 첫 화", active: true }]);
  harness.browser.tabs.get.mockResolvedValue({ id: 1, active: true, windowId: 2 });
  harness.browser.scripting.executeScript.mockResolvedValue([]);
  harness.browser.storage.local.get.mockResolvedValue({}); harness.browser.storage.local.set.mockResolvedValue(undefined);
  model = { ready: true, state: {}, prepare: vi.fn(async () => {}), decide: vi.fn(),
    planChapter: vi.fn(async (chunk: { sections: { id: number; start: number }[] }) => chunk.sections.map(s => ({
      id: s.id, mood: s.start < 20 ? "calm" : "horror", intensity: 0.6, action: "continue", sfx: [],
    }))), dispose: vi.fn(), cancelPreparation: vi.fn() };
  runtime = new ReaderRuntime(model as unknown as NanoClient);
});
afterEach(async () => { await runtime.dispose(); vi.clearAllMocks(); });
describe("reader ownership and transport", () => {
  it("permission denial closes the new graph and leaves a retryable disconnected state", async () => {
    harness.browser.permissions.request.mockResolvedValue(false); await runtime.connect();
    expect(runtime.connected).toBe(false); expect(runtime.state.message).toContain("권한"); expect(harness.engines[0]!.close).toHaveBeenCalledTimes(1);
  });
  it("model preparation failure keeps non-blocking provisional audio with a visible warning", async () => {
    model.prepare.mockRejectedValue(new Error("모델이 없습니다")); await runtime.connect();
    await vi.waitFor(() => expect(runtime.state.alert).toContain("모델이 없습니다"));
    expect(runtime.connected).toBe(true);
    expect(harness.engines[0]!.setScene).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics().queue.provisional).toBe(true);
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
  it("starts provisional acoustic music without waiting for a slow model", async () => {
    model.ready = false;
    let finish!: () => void;
    model.prepare.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await runtime.connect();
    const engine = harness.engines[0]!;
    expect(engine.setScene).toHaveBeenCalledTimes(1);
    expect((engine.setScene.mock.calls[0]![0] as { mood: string }).mood).toBe("calm");
    expect(runtime.diagnostics().queue.provisional).toBe(true);
    model.ready = true; finish();
    await Promise.resolve();
  });
  it("applies mapped chapter music at the reader's position and changes when moving", async () => {
    await runtime.connect();
    const engine = harness.engines[0]!;
    const blocks = Array.from({length: 55}, (_, i) => ({ text: `문단 ${i} ` + "평화로운 이야기 ".repeat(9), y: 100 + i * 42 }));
    harness.browser.runtime.onMessage.emit({ type: "twice:chapter", fingerprint: "story:55:123", blocks }, { tab: { id: 1 } });
    await vi.waitFor(() => expect(runtime.diagnostics().queue.fullChapter?.analyzed).toBe(55));
    harness.browser.runtime.onMessage.emit({ type: "twice:position", fingerprint: "story:55:123", index: 7 }, { tab: { id: 1 } });
    expect(runtime.state.playing?.mood).toBe("calm");
    (runtime as unknown as {lastMusicAt: number}).lastMusicAt = Date.now() - 30_000;
    harness.browser.runtime.onMessage.emit({ type: "twice:position", fingerprint: "story:55:123", index: 39 }, { tab: { id: 1 } });
    expect(runtime.state.playing?.mood).toBe("horror");
    expect(engine.setScene).toHaveBeenCalledTimes(3); // provisional + initial scored + position change
    expect(runtime.diagnostics().queue.provisional).toBe(false);
  });
  it("re-prioritizes the remaining chapter chunks when the reader jumps ahead", async () => {
    await runtime.connect();
    const blocks = Array.from({ length: 120 }, (_, i) => ({ text: `문단 ${i} ` + "한글 소설 내용 ".repeat(12), y: 100 + i * 42 }));
    let firstResolve!: (value: unknown[]) => void;
    model.planChapter.mockImplementationOnce((chunk: {sections: {id: number}[]}) =>
      new Promise(resolve => { firstResolve = resolve; }));
    harness.browser.runtime.onMessage.emit({ type: "twice:chapter", fingerprint: "story:120:999", blocks }, {tab:{id:1}});
    expect(model.planChapter).toHaveBeenCalledTimes(1);
    const first = model.planChapter.mock.calls[0]![0] as {sections: {id: number;start: number}[]};
    harness.browser.runtime.onMessage.emit({type:"twice:position", fingerprint:"story:120:999", index:113}, {tab:{id:1}});
    firstResolve(first.sections.map(s => ({ id:s.id, mood:"calm", intensity:.5, action:"continue", sfx:[] })));
    await vi.waitFor(() => expect(model.planChapter.mock.calls.length).toBeGreaterThan(1));
    const second = model.planChapter.mock.calls[1]![0] as {sections: {start:number;end:number}[]};
    expect(second.sections.some(s => s.start <= 113 && s.end >= 113)).toBe(true);
  });

});
