import { describe, expect, it, vi } from "vitest";
import { normalizeSegment, SFX, SFX_GAP_S } from "../src/domain/score.js";
import { playSfx, SFX_TYPES } from "@twice/sound";

function fixture() {
  const nodes: { kind: string; gain: { value: number }; connect: ReturnType<typeof vi.fn> }[] = [];
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const node = (kind: string) => {
    const result = { kind, gain: param(), frequency: param(), Q: param(), pan: param(), connect: vi.fn((to: unknown) => to), start: vi.fn(), stop: vi.fn() };
    nodes.push(result);
    return result;
  };
  const ctx = {
    createGain: () => node("gain"), createStereoPanner: () => node("pan"),
    createBufferSource: () => node("source"), createBiquadFilter: () => node("filter"), createOscillator: () => node("oscillator"),
  };
  const out = {};
  return { env: { ctx, out, noise: { pink: {} } }, nodes, out };
}

describe("dedicated procedural effects", () => {
  it("exposes exactly the supported tuned effects and retires coin_drop", () => {
    expect([...SFX].sort()).toEqual([...SFX_TYPES].sort());
    expect(SFX).toHaveLength(47);
    expect(SFX_GAP_S).toBe(8);
    expect(SFX).not.toContain("coin_drop");
    expect(normalizeSegment({ sfx: [{ p: 1, type: "coin_drop", p1: 0.8 }] }).sfx).toEqual([]);
  });
  it("applies the tuned knock level and routes it to the engine's effect output", () => {
    const { env, nodes, out } = fixture();
    expect(playSfx(env, "knock", 0, 0.7)).toBe(true);
    const level = nodes[0]!;
    expect(level.gain.value).toBe(2.5);
    expect(level.connect).toHaveBeenCalledWith(out);
    expect(nodes.some(n => n.kind === "oscillator")).toBe(true);
  });
  it("keeps stereo footsteps behind the same stoppable level instead of bypassing it", () => {
    const { env, nodes, out } = fixture();
    playSfx(env, "footsteps", 0, 0.7);
    const level = nodes[0]!, pans = nodes.filter(n => n.kind === "pan");
    expect(level.gain.value).toBe(5);
    expect(level.connect).toHaveBeenCalledWith(out);
    expect(pans).toHaveLength(6);
    for (const pan of pans) expect(pan.connect).toHaveBeenCalledWith(level);
  });
  it("ignores retired or unknown effects without an unrelated fallback", () => {
    const { env, nodes } = fixture();
    for (const type of ["coin_drop", "unknown", "toString"]) expect(playSfx(env, type, 0)).toBe(false);
    expect(nodes).toHaveLength(0);
  });
  it("keeps sudden silence as ducking without synthesizing a sound", () => {
    const { env, nodes } = fixture(), duck = vi.fn();
    expect(playSfx(env, "sudden_silence", 1, 0.7, { duck })).toBe(true);
    expect(duck).toHaveBeenCalledWith(1);
    expect(nodes).toHaveLength(0);
  });
});
