import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, ModelError, NanoClient, type AiHost } from "../src/model/nano";
import { SCHEMA } from "../src/domain/score.js";
import type { Availability } from "../src/domain/types";
const decision = { action: "continue", music_action: "keep", ambience: [], sfx: [], sfx_interval_s: 8, reason: "The same quiet room continues.", context_summary: "A letter is being read." };
function fixture(lm: Availability = "available") {
  const session = { clone: vi.fn(async () => session), prompt: vi.fn(async () => JSON.stringify(decision)), destroy: vi.fn() };
  const host: AiHost = {
    LanguageModel: { availability: vi.fn(async () => lm), create: vi.fn(async () => session) },
  };
  return { host, session };
}
afterEach(() => vi.useRealTimers());
describe("on-device model lifecycle", () => {
  it("does not call create or pretend to be ready when APIs are absent", async () => {
    const client = new NanoClient({}); await client.inspect();
    expect(client.state.kind).toBe("unsupported"); expect(client.ready).toBe(false); expect(client.canPrepare).toBe(false);
    await expect(client.prepare()).rejects.toMatchObject({ code: "unsupported" });
  });
  it("reports a disabled/unavailable LM without guessing which Chrome setting caused it", async () => {
    const { host } = fixture("unavailable"); const client = new NanoClient(host); await client.inspect();
    expect(client.state.kind).toBe("unavailable"); expect(client.state.detail).toContain("단정할 수 없어");
    expect(host.LanguageModel!.create).not.toHaveBeenCalled(); await expect(client.prepare()).rejects.toBeInstanceOf(ModelError);
  });
  it("invalidates cached readiness when AI becomes unavailable", async () => {
    const { host, session } = fixture(); const client = new NanoClient(host); await client.inspect(); await client.prepare();
    host.LanguageModel!.availability = vi.fn(async () => "unavailable" as Availability); await client.inspect();
    expect(client.state.kind).toBe("unavailable"); expect(client.ready).toBe(false); expect(client.canPrepare).toBe(false);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });
  it("starts model creation in the click stack, caches preparation and reuses installed sessions", async () => {
    const { host } = fixture(); const client = new NanoClient(host); await client.inspect();
    expect(client.state.kind).toBe("available");
    const preparing = client.prepare(); expect(host.LanguageModel!.create).toHaveBeenCalledTimes(1);
    expect(client.prepare()).toBe(preparing); await preparing; await client.prepare();
    expect(client.ready).toBe(true); expect(host.LanguageModel!.create).toHaveBeenCalledTimes(1);
  });
  it("reports genuine downloads and turns 100% into initialization", async () => {
    const { host, session } = fixture("downloadable"); const states: { kind: string; progress?: number }[] = [];
    host.LanguageModel!.create = vi.fn(async options => {
      const monitor = options.monitor as (target: object) => void;
      monitor({ addEventListener: (_: string, cb: (e: { loaded: number }) => void) => { cb({ loaded: 0.5 }); cb({ loaded: 1 }); } });
      return session;
    });
    const client = new NanoClient(host); client.subscribe(() => states.push({ kind: client.state.kind, progress: client.state.progress }));
    await client.inspect(); expect(host.LanguageModel!.create).not.toHaveBeenCalled(); await client.prepare();
    expect(states).toContainEqual({ kind: "downloading", progress: 0.5 });
    expect(states.some(state => state.kind === "downloading" && state.progress === 1)).toBe(false); expect(client.state.kind).toBe("ready");
  });
  it("ignores download callbacks when the model is already installed", async () => {
    const { host, session } = fixture(); const phases: string[] = [];
    host.LanguageModel!.create = vi.fn(async options => {
      (options.monitor as (target: object) => void)({ addEventListener: (_: string, cb: (e: { loaded: number }) => void) => { cb({ loaded: 0 }); cb({ loaded: 1 }); } }); return session;
    });
    const client = new NanoClient(host); client.subscribe(() => phases.push(client.state.kind)); await client.inspect(); await client.prepare();
    expect(phases).not.toContain("downloading"); expect(client.state.kind).toBe("ready");
  });
  it("bounds availability checks and remains retryable", async () => {
    vi.useFakeTimers(); const { host } = fixture(); host.LanguageModel!.availability = vi.fn(() => new Promise<never>(() => {}));
    const client = new NanoClient(host, 20); const check = client.inspect(); await vi.advanceTimersByTimeAsync(25); await check;
    expect(client.state.kind).toBe("error"); expect(client.state.detail).toContain("지연"); expect(client.canPrepare).toBe(false);
    host.LanguageModel!.availability = vi.fn(async () => "available" as Availability); await client.inspect(); expect(client.canPrepare).toBe(true);
  });
  it("handles synchronous create errors cleanly", async () => {
    const { host } = fixture(); host.LanguageModel!.create = vi.fn(() => { throw new DOMException("denied", "NotAllowedError"); });
    const client = new NanoClient(host); await client.inspect(); await expect(client.prepare()).rejects.toMatchObject({ code: "permission" });
    expect(client.state.kind).toBe("error"); expect(client.ready).toBe(false);
  });
  it("cancel allows a fresh attempt and cleans late, uncancellable results", async () => {
    const { host, session } = fixture("downloadable");
    let finishLm!: (value: typeof session) => void;
    host.LanguageModel!.create = vi.fn(() => new Promise<typeof session>(resolve => { finishLm = resolve; }));
    const client = new NanoClient(host); await client.inspect(); const pending = client.prepare(); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    client.cancelPreparation(); await rejected; expect(client.preparing).toBe(false);
    finishLm(session); await Promise.resolve(); await Promise.resolve();
    expect(session.destroy).toHaveBeenCalled();
    host.LanguageModel!.create = vi.fn(async () => ({ ...session, destroy: vi.fn() }));
    await client.inspect(); await client.prepare(); expect(client.state.kind).toBe("ready");
  });
  it("a hanging create times out without blocking the UI forever", async () => {
    vi.useFakeTimers(); const { host } = fixture("downloadable"); host.LanguageModel!.create = vi.fn(() => new Promise<never>(() => {}));
    const client = new NanoClient(host, 20, 50); await client.inspect(); const pending = client.prepare(); const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(60); await rejected; expect(client.state.kind).toBe("error"); expect(client.preparing).toBe(false);
  });
  it("never analyzes without a prepared model", async () => {
    const { host } = fixture(); const client = new NanoClient(host);
    await expect(client.decide({ ids: [0], currentIds: [0], texts: ["본문"] }, null, {} as never, new AbortController().signal, () => {})).rejects.toMatchObject({ code: "not-ready" });
    expect(host.LanguageModel!.create).not.toHaveBeenCalled();
  });
  it("keeps historical text out of one-shots and separates earlier vs current screen paragraphs", async () => {
    const { host, session } = fixture(); session.prompt = vi.fn(async () => JSON.stringify({ ...decision, sfx: [{ p: 1, type: "knock", p1: 0.6 }] }));
    const client = new NanoClient(host); await client.inspect(); await client.prepare();
    const output = await client.decide({ ids: [1, 5], currentIds: [5], texts: ["An old knock.", "A quiet room."] }, null, { context: "A story", previousScreen: "", musicPaused: false, musicStarted: false, sound: "playing" }, new AbortController().signal, () => {});
    expect(output.segments[0]!.sfx).toEqual([]); expect(output.input).toContain("earlier:\n[1] An old knock."); expect(output.input).toContain("current_screen:\n[5] A quiet room.");
  });
  it("passes Korean and English paragraphs directly to Nano without translation delay", async () => {
    const { host } = fixture(); const client = new NanoClient(host); await client.inspect(); await client.prepare();
    const korean = "문밖에서 거센 바람 소리가 들려왔다.";
    const output = await client.decide({ ids: [1], currentIds: [1], texts: [korean] }, null, {} as never, new AbortController().signal, () => {});
    expect(output.input).toContain("[1] " + korean);
  });
  it("sends the same prompt to an OpenAI-compatible endpoint and reports its failures without falling back", async () => {
    const fetch = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify({ ...decision, mood: "calm", intensity: 0.4 }) + "\n```" } }] })));
    vi.stubGlobal("fetch", fetch);
    try {
      const { host } = fixture(); const client = new NanoClient(host);
      client.setExternal({ baseURL: "https://api.example.test/v1/", apiKey: "test-key", model: "m" });
      expect(client.ready).toBe(true); expect(client.state.external).toBe("api.example.test");
      const output = await client.decide({ ids: [1], currentIds: [1], texts: ["비가 내렸다."] }, null, {} as never, new AbortController().signal, () => {});
      const [url, init] = fetch.mock.calls[0]!, body = JSON.parse(init.body);
      expect(url).toBe("https://api.example.test/v1/chat/completions"); expect(init.headers.authorization).toBe("Bearer test-key");
      expect(body.response_format.json_schema.schema).toEqual(SCHEMA); expect(body.messages[1].content).toContain("[1] 비가 내렸다.");
      expect(output.segments[0]!.mood).toBe("calm"); expect(host.LanguageModel!.create).not.toHaveBeenCalled();
      fetch.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
      await expect(client.decide({ ids: [2], currentIds: [2], texts: ["..."] }, null, {} as never, new AbortController().signal, () => {})).rejects.toThrow("401");
      expect(client.ready).toBe(true); expect(host.LanguageModel!.create).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("lists OpenAI-compatible model ids for the settings picker", async () => {
    const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, {}] })));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await listModels({ baseURL: "https://api.example.test/v1/", apiKey: "k" })).toEqual(["a-model", "b-model"]);
      expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/v1/models"); expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer k");
      fetch.mockResolvedValueOnce(new Response("no", { status: 403 }));
      await expect(listModels({ baseURL: "https://api.example.test/v1", apiKey: "" })).rejects.toThrow("403");
    } finally { vi.unstubAllGlobals(); }
  });
});
