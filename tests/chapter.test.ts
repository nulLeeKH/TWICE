import { describe, expect, it } from "vitest";
import { chapterChunks, eligibleChapter, mapChapterChunk } from "../src/domain/chapter";

const blocks = Array.from({ length: 30 }, (_, i) => ({ text: i === 12 ? "검을 부딪치며 전투를 시작했다. " .repeat(4) : `그들은 저 멀리 걸었다. ${i} ` .repeat(6), y: i * 32 }));
describe("preplanned chapter with source paragraph anchors", () => {
  it("splits a complete chapter into disjoint, ordered sections and bounded requests", () => {
    const chunks = chapterChunks(blocks);
    const sections = chunks.flatMap(c => c.sections);
    expect(sections[0]!.start).toBe(0);
    expect(sections.at(-1)!.end).toBe(blocks.length - 1);
    expect(chunks.every(c => c.text.length < 4700)).toBe(true);
    for (let i = 1; i < sections.length; i++) expect(sections[i]!.start).toBe(sections[i - 1]!.end + 1);
  });
  it("restricts effect sounds to the source paragraph, not the whole section", () => {
    const chunk = chapterChunks(blocks).find(c => c.sections.some(s => s.start <= 12 && s.end >= 12))!;
    const rows = chunk.sections.map(s => ({ id: s.id, mood: s.start <= 12 && s.end >= 12 ? "battle" : "calm", intensity: .5, action: "continue", sfx: s.start <= 12 && s.end >= 12 ? [{ p: 12, type: "sword_clash", p1: .8 }] : [] }));
    const mapped = mapChapterChunk(chunk, blocks, { segments: rows });
    expect(mapped.get(12)!.sfx).toEqual([{ p: 12, type: "sword_clash", p1: .8 }]);
    const section = chunk.sections.find(s => s.start <= 12 && s.end >= 12)!;
    for (let i = section.start; i <= section.end; i++) if (i !== 12) expect(mapped.get(i)!.sfx).toEqual([]);
  });
  it("rejects incomplete or huge DOM extraction and invalid model rows", () => {
    expect(eligibleChapter(blocks, 9000, 800, 1000)).toBe(false);
    expect(eligibleChapter(blocks, 1200, 800, 960)).toBe(true);
    const chunk = chapterChunks(blocks)[0]!;
    expect(() => mapChapterChunk(chunk, blocks, { segments: [] })).toThrow();
  });
});
