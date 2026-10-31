import { describe, expect, it } from "vitest";
import { Transcript } from "../src/domain/transcript";
import { completeJsonFields, groundAmbience, groundSfx, linesToParagraphs, MOODS, navigationKind, normalizeSegment, screenDecision, shouldChangeMusic, filterOcrLines, SFX, SFX_GAP_S } from "../src/domain/score.js";
import { accompany, arrangement, compose, INSTRUMENTS, instrumentCuePlan, percussionPattern, preventShortMelodyLoops } from "../src/audio/music.js";
const view = { range: [0, 800] as [number, number], view: 1 };
describe("deduplicated observation queue", () => {
  it("merges overlapping fragments and batches current plus intermediate screens exactly once", () => {
    const store = new Transcript();
    const first = store.ingest("a", [{ text: "그는 문을 열고 오래된 편지를 꺼냈다.", y: 100 }, { text: "아직 읽지 못한 지난 문단이 남았다.", y: 250 }], view, false, false); store.enqueue(first);
    const second = store.ingest("b", [{ text: "오래된 편지를 꺼냈다. 바람이 불었다.", y: 130 }, { text: "그녀는 고요한 숲을 바라보았다.", y: 400 }], view, false, false); store.enqueue(second);
    const batch = store.take(second);
    expect(store.paragraphs.size).toBe(3); expect(store.merged).toBe(1); expect(batch.ids).toHaveLength(3); expect(new Set(batch.ids).size).toBe(3);
    expect(batch.currentIds).toHaveLength(2); expect(batch.texts.filter(text => text.includes("오래된 편지를 꺼냈다."))).toHaveLength(1);
    expect(batch.texts.join(" ")).toContain("편지를 꺼냈다. 바람이 불었다.");
  });
  it("preserves genuinely repeated short paragraphs within a screen", () => {
    const store = new Transcript(); const frame = store.ingest("a", [{ text: "그렇다.", y: 100 }, { text: "그렇다.", y: 140 }], view, false, false);
    expect(frame.ids).toHaveLength(2);
  });
  it("retains overflow instead of losing it when the current screen is prioritized", () => {
    const store = new Transcript(); const first = store.ingest("a", [{ text: "old ".repeat(100), y: 100 }], view, false, false); store.enqueue(first);
    const second = store.ingest("b", [{ text: "new ".repeat(100), y: 600 }], view, false, false); store.enqueue(second);
    const batch = store.take(second, 450); expect(batch.ids).toEqual(second.ids); expect(store.pending.has(first.ids[0]!)).toBe(true);
    store.requeue(batch); expect(store.pending.size).toBe(2);
  });
  it("separates episode geometry while retaining pending story context", () => {
    const store = new Transcript(); const first = store.ingest("a", [{ text: "같은 위치에서 시작하는 문장", y: 50 }], view, false, false); store.enqueue(first); store.nextEpisode();
    const next = store.ingest("b", [{ text: "같은 위치에서 시작하는 문장", y: 50 }], view, false, false); store.enqueue(next);
    expect(next.ids[0]).not.toBe(first.ids[0]); expect(store.take(next).ids).toHaveLength(2);
  });
  it("reuses pixel-identical screens without creating more paragraph identities", () => {
    const store = new Transcript(); const first = store.ingest("a", [{ text: "같은 화면의 본문", y: 30 }], view, false, false);
    expect(store.ingest("a", [{ text: "같은 화면의 본문", y: 30 }], view, false, false)).toBe(first); expect(store.paragraphs.size).toBe(1);
  });
});
describe("decision and navigation contract", () => {
  it("does not apply incomplete numbers or arrays from a stream", () => {
    expect(completeJsonFields('{"music_action":"change","bpm":1').bpm).toBeUndefined();
    expect(completeJsonFields('{"music_action":"keep","ambience":[{"engine":"aero"').music_action).toBe("keep");
    expect(completeJsonFields('{"music_action":"keep","ambience":[{"engine":"aero"').ambience).toBeUndefined();
  });
  it("preserves delimiters and escaped quotes inside JSON strings", () => {
    const value = { reason: 'A "] } , \\"" inside text', sfx: [] };
    expect({ ...completeJsonFields(JSON.stringify(value)) }).toEqual(value);
  });
  it("guards psycho with body-sound evidence instead of generic fear", () => {
    expect(groundAmbience([{ engine: "psycho" }], "He felt afraid in the dark.").ambience).toEqual([]);
    expect(groundAmbience([{ engine: "psycho" }], "His heart was beating loudly.").ambience).toHaveLength(1);
    expect(groundAmbience([{ engine: "psycho" }], "심장이 두근거리며 뛰었다.").ambience).toHaveLength(1);
  });
  it("starts ambience on explicit description, keeps it in the same scene, and clears it on scene change", () => {
    const started = groundAmbience([], "창밖에 거센 비가 내리고 파도가 밀려왔다.", [], "change");
    expect(started.ambience.map((a: { engine: string }) => a.engine)).toEqual(["water", "particle"]);
    const continued = groundAmbience(started.ambience, "그들은 말없이 서 있었다.", started.ambience, "continue");
    expect(continued.ambience).toHaveLength(2);
    const ended = groundAmbience(started.ambience, "다음 날 아침, 조용한 방 안에서 눈을 떴다.", started.ambience, "change");
    expect(ended.ambience).toEqual([]);
  });
  it("extracts explicit sound effects like car crashes, screams, glass shatters, and crowd cheers even when model sfx is empty or uses relative indices", () => {
    const rows = [{ id: 12, text: "트럭이 승용차를 그대로 들이받으며 교통사고가 났다." }, { id: 13, text: "관중석에서 와아아 하고 함성이 터져 나왔다." }];
    expect(groundSfx([], [rows[0]!], [10, 12], [12])).toEqual([{ p: 12, type: "car_crash", p1: 0.92 }]);
    expect(groundSfx([], [rows[1]!], [12, 13], [13])).toEqual([{ p: 13, type: "crowd_cheer", p1: 0.88 }]);
    expect(groundSfx([{ p: 0, type: "crash", p1: 0.8 }], rows, [10, 12, 13], [12, 13])).toEqual([
      { p: 12, type: "car_crash", p1: 0.8 },
      { p: 13, type: "crowd_cheer", p1: 0.88 },
    ]);
    expect(groundSfx([{ p: 10, type: "knock", p1: 0.7 }], rows, [10, 12, 13], [12, 13])).toEqual([
      { p: 12, type: "car_crash", p1: 0.92 },
      { p: 13, type: "crowd_cheer", p1: 0.88 },
    ]);
    const screamAndGlass = [
      { id: 20, text: "\"으아아악! 꺄아아악!\" 사내가 비명을 질렀다." },
      { id: 21, text: "파열음과 함께 거대한 유리창이 산산조각 깨졌다." },
    ];
    expect(groundSfx([], screamAndGlass, [20, 21], [20, 21])).toEqual([
      { p: 20, type: "scream", p1: 0.92 },
      { p: 21, type: "glass_shatter", p1: 0.95 },
    ]);
  });
  it("keeps the playing mood for keep/pause/resume while allowing ambience changes", () => {
    const playing = normalizeSegment({ mood: "calm", intensity: 0.4 });
    const next = screenDecision({ action: "continue", music_action: "pause", mood: "epic", intensity: 0.6, ambience: [{ engine: "aero", p1: 0.5, p2: 0.5, p3: 0.5 }] }, 0, 1, playing);
    expect(next.mood).toBe("calm"); expect(next.intensity).toBe(0.6); expect(next.ambience).toHaveLength(1);
  });
  it("uses caller paragraph bounds, and rejects missing model actions", () => {
    const decision = screenDecision({ action: "continue", music_action: "keep", start_p: 0, end_p: 1 }, 16, 30);
    expect([decision.start_p, decision.end_p]).toEqual([16, 30]); expect(() => screenDecision({ segments: [] }, 0, 3)).toThrow();
  });
  it("upgrades keep to change when the model names a different mood", () => {
    const prev = normalizeSegment({ mood: "calm" });
    const next = screenDecision({ action: "continue", music_action: "keep", mood: "battle", ambience: [{ engine: "water", variant: "waves", p1: 0.6, p2: 0.5, p3: 0.4 }], sfx: [{ p: 5, type: "sword_clash", p1: 0.8 }] }, 4, 8, prev);
    expect(next.music_action).toBe("change"); expect(next.mood).toBe("battle");
    expect(next.ambience[0]).toMatchObject({ engine: "water", variant: "waves" });
    expect(next.sfx[0]).toMatchObject({ p: 5, type: "sword_clash" });
  });
  it("holds the playing piece briefly, longer for a nearby mood, and lets urgent moods cut in", () => {
    const calm = normalizeSegment({ mood: "calm" }), to = (mood: string) => normalizeSegment({ mood, music_action: "change" });
    expect(shouldChangeMusic(null, to("sad"), 0)).toBe(true);
    expect(shouldChangeMusic(calm, to("sad"), 5)).toBe(false);
    expect(shouldChangeMusic(calm, to("sad"), 6)).toBe(true);
    expect(shouldChangeMusic(calm, to("romance"), 9)).toBe(false);
    expect(shouldChangeMusic(calm, to("romance"), 10)).toBe(true);
    expect(shouldChangeMusic(calm, to("battle"), 2)).toBe(true);
    expect(shouldChangeMusic(calm, normalizeSegment({ mood: "sad", music_action: "keep" }), 99)).toBe(false);
  });
  it("composes 16- or 32-bar pieces within the mood's tempo and close to the previous key and tempo", () => {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const mood of Object.keys(MOODS) as (keyof typeof MOODS)[]) {
      const piece = compose(mood, rnd), [lo, hi] = MOODS[mood].bpm;
      expect([16, 32]).toContain(piece.bars.length);
      expect(piece.bpm).toBeGreaterThanOrEqual(lo!); expect(piece.bpm).toBeLessThanOrEqual(hi!);
      // every phrase closes: the last bar of the piece lands on the tonic triad
      expect(piece.bars.at(-1)!.chord[0]! % 12).toBe(piece.key % 12);
      for (const bar of piece.bars) expect(bar.melody.reduce((n: number, e: { len: number }) => n + e.len, 0)).toBeLessThanOrEqual(4);
      const plan = arrangement(mood);
      for (const name of [plan.bed, plan.lead, ...plan.parts.map(part => part.instrument)]) if (name) expect(INSTRUMENTS).toContain(name);
    }
    const next = compose("calm", rnd, 50, 70);
    expect([0, 5, 7]).toContain(Math.min((next.key - 50 + 12) % 12, (50 - next.key + 12) % 12));
    expect(Math.abs(next.bpm - 70)).toBeLessThanOrEqual(4);
    expect(compose("calm", rnd).bars.map(bar => bar.chord)).not.toEqual(compose("calm", rnd).bars.map(bar => bar.chord));
  });
  it("keeps accompaniment voicings within an octave of their register", () => {
    for (const role of ["sustain", "arp", "broken", "bounce", "sparse", "drive", "arp_slow"])
      for (const e of accompany(role, [57, 60, 64], 62, 0.6)) expect(Math.abs(e.note - 62)).toBeLessThanOrEqual(18);
  });
  it("resumes the same work for Munpia/Kakao episode paths and resets on another work", () => {
    expect(navigationKind("https://www.munpia.com/novel/viewer/613825/9002546", "https://www.munpia.com/novel/viewer/613825/9002547")).toBe("episode");
    expect(navigationKind("https://page.kakao.com/content/70712651/viewer/71175312/", "https://page.kakao.com/content/70712651/viewer/71175313/")).toBe("episode");
    expect(navigationKind("https://page.kakao.com/content/70712651/viewer/1/", "https://page.kakao.com/content/22/viewer/2/")).toBe("leave");
    expect(navigationKind("https://x.test/work/1?a=1", "https://x.test/work/1?a=2")).toBe("same");
  });
  it("cuts comments without treating narrative references to comments as section headings", () => {
    const line = (text: string, y: number) => ({ text, bbox: { x0: 0, x1: 500, y0: y, y1: y + 20 } });
    const result = filterOcrLines([line("그는 댓글을 읽다가 문을 두드렸다.", 0), line("3분 전", 40), line("좋아요 25", 80), line("베스트 댓글 12", 120), line("이 장면은 너무 무서워요", 160)]);
    expect(result.lines.map((item: { text: string }) => item.text)).toEqual(["그는 댓글을 읽다가 문을 두드렸다."]); expect(result.cutoff).toBe(120);
  });
  it("reads two-page spread OCR lines in left-page then right-page order without interleaving", () => {
    const spreadLines = [
      { text: "왼쪽 첫 번째 문단의 첫 줄이고 끝까지 이어진다", bbox: { x0: 80, x1: 520, y0: 100, y1: 124 } },
      { text: "오른쪽 첫 번째 문단의 첫 줄이고 끝까지 이어진다", bbox: { x0: 680, x1: 1120, y0: 102, y1: 126 } },
      { text: "왼쪽 첫 번째 문단의 마무리.", bbox: { x0: 80, x1: 310, y0: 132, y1: 156 } },
      { text: "오른쪽 첫 번째 문단의 마무리.", bbox: { x0: 680, x1: 910, y0: 134, y1: 158 } },
      { text: "왼쪽 두 번째 문단이 시작된다.", bbox: { x0: 80, x1: 380, y0: 190, y1: 214 } },
      { text: "오른쪽 두 번째 문단이 시작된다.", bbox: { x0: 680, x1: 980, y0: 192, y1: 216 } },
    ];
    const paragraphs = linesToParagraphs(spreadLines, 900, 1200);
    expect(paragraphs.map((p: { text: string }) => p.text)).toEqual([
      "왼쪽 첫 번째 문단의 첫 줄이고 끝까지 이어진다 왼쪽 첫 번째 문단의 마무리.",
      "왼쪽 두 번째 문단이 시작된다.",
      "오른쪽 첫 번째 문단의 첫 줄이고 끝까지 이어진다 오른쪽 첫 번째 문단의 마무리.",
      "오른쪽 두 번째 문단이 시작된다.",
    ]);
    expect(paragraphs[2]!.y0).toBeGreaterThan(paragraphs[1]!.y0);
  });
});


describe("instrument-only events and non-repetitive scoring", () => {
  it("covers every story event with instrument voices, never sampled Foley", () => {
    expect(SFX_GAP_S).toBe(8);
    for (const type of SFX) {
      const plan = instrumentCuePlan(type, 0.7, () => 0.6);
      if (type === "sudden_silence") { expect(plan).toEqual([]); continue; }
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.length).toBeLessThanOrEqual(3);
      for (const note of plan) {
        expect(INSTRUMENTS).toContain(note.instrument);
        expect(note.offset).toBeGreaterThanOrEqual(0);
        expect(note.offset + note.duration).toBeLessThan(1.5);
      }
    }
  });
  it("prevents full-bar melody loops within eight seconds at slow and fast tempi", () => {
    for (const bpm of [45, 80, 155]) {
      const melody = () => [{ beat: 0, len: 2, note: 60 }, { beat: 2, len: 2, note: 64 }];
      const bars = Array.from({ length: 12 }, () => ({ chord: [60, 64, 67], melody: melody() }));
      preventShortMelodyLoops(bars, bpm, [60, 62, 64, 65, 67, 69, 71, 72]);
      const signature = (i: number) => JSON.stringify(bars[i]!.melody);
      for (let i = 0; i < bars.length; i++) for (let j = 0; j < i; j++)
        if ((i - j) * 240 / bpm < 8) expect(signature(i)).not.toBe(signature(j));
    }
  });
});


describe("gentle acoustic timbre policy", () => {
  const acoustic = new Set(["strings", "cello", "harp", "piano", "marimba", "timpani", "bass_drum", "frame_drum"]);
  it("uses only gentle acoustic voices for all mood presets and arrangements", () => {
    for (const mood of Object.keys(MOODS)) {
      const preset = MOODS[mood as keyof typeof MOODS];
      expect(acoustic.has(preset.lead)).toBe(true);
      expect(preset.support.every((name: string) => acoustic.has(name))).toBe(true);
      const plan = arrangement(mood);
      expect(acoustic.has(plan.bed)).toBe(true);
      expect(plan.lead === null || acoustic.has(plan.lead)).toBe(true);
      expect(plan.parts.every((part: { instrument: string }) => acoustic.has(part.instrument))).toBe(true);
      expect(plan.percussion.every((name: string) => acoustic.has(name))).toBe(true);
    }
  });
  it("uses only gentle acoustic voices for all sound effect cues", () => {
    for (const type of SFX) for (const random of [0.05, 0.45, 0.95])
      expect(instrumentCuePlan(type, 1, () => random).every(note => acoustic.has(note.instrument))).toBe(true);
  });
});


describe("organic percussion instead of drum-machine loops", () => {
  it("keeps reflective and quiet music free of percussion", () => {
    for (const mood of ["calm", "sad", "romance", "mystic", "comedy"])
      for (let bar = 0; bar < 32; bar++) expect(percussionPattern(mood, 1, bar)).toEqual([]);
    for (const mood of ["battle", "epic", "anger", "tension", "horror"])
      for (let bar = 0; bar < 32; bar++) expect(percussionPattern(mood, .2, bar)).toEqual([]);
  });
  it("adds sparse warm acoustic drums only to suitable energetic scenes", () => {
    const drums = new Set(["timpani", "bass_drum", "frame_drum"]);
    for (const mood of ["battle", "epic", "anger", "tension", "horror", "adventure"]) {
      const bars = Array.from({length: 16}, (_, i) => percussionPattern(mood, .9, i));
      expect(bars.some(notes => notes.length > 0)).toBe(true);
      expect(bars.filter(notes => notes.length === 0).length).toBeGreaterThan(0);
      for (const notes of bars) for (const note of notes) {
        expect(drums.has(note.instrument)).toBe(true);
        expect(note.beat).toBeGreaterThanOrEqual(0);
        expect(note.beat).toBeLessThan(4);
        expect(note.vel).toBeLessThanOrEqual(.83);
      }
    }
  });
});
