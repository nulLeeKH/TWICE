import { hash, mergeOcrText } from "./score.js";
import type { Batch, Frame, Paragraph } from "./types";

/** Session-local text only. Stable IDs make overlap and one-shot dedup independent of the model. */
export class Transcript {
  readonly paragraphs = new Map<number, Paragraph>();
  readonly frames = new Map<string, Frame>();
  readonly pending = new Set<number>();
  merged = 0;
  private nextId = 0;
  private scope = 0;

  nextEpisode() { this.scope++; this.frames.clear(); }
  clear() { this.paragraphs.clear(); this.frames.clear(); this.pending.clear(); this.nextId = 0; this.scope = 0; this.merged = 0; }

  ingest(key: string, lines: { text: string; y: number }[], shot: Pick<Frame, "range" | "view">, page: boolean, nonStory: boolean): Frame {
    const known = this.frames.get(key);
    if (known) return known;
    const scope = `${this.scope}:${page ? key : "scroll"}`;
    const ids: number[] = [];
    for (const line of lines) {
      let match: Paragraph | undefined;
      let merged: string | null = null;
      for (const paragraph of this.paragraphs.values()) {
        if (paragraph.scope !== scope || ids.includes(paragraph.idx) || Math.abs(paragraph.y - line.y) > 90) continue;
        merged = mergeOcrText(paragraph.text, line.text);
        if (merged !== null) { match = paragraph; break; }
      }
      if (match && merged !== null) {
        match.text = merged; match.y = Math.min(match.y, line.y);
        ids.push(match.idx); this.merged++;
      } else {
        const idx = this.nextId++;
        this.paragraphs.set(idx, { idx, ...line, scope, key: `${scope}:${idx}:${hash(line.text)}` });
        ids.push(idx);
      }
    }
    const frame: Frame = { key, ids: [...new Set(ids)], ...shot, nonStory };
    this.frames.set(key, frame);
    // Screen bitmaps are not retained; bounded frame references also bound replay history.
    while (this.frames.size > 64) {
      const first = this.frames.keys().next().value;
      if (first === undefined) break;
      this.frames.delete(first);
    }
    return frame;
  }

  enqueue(frame: Frame) { if (!frame.nonStory) frame.ids.forEach(id => this.pending.add(id)); }

  take(frame: Frame, budget = 1800): Batch {
    const selected = new Set(frame.ids);
    let chars = frame.ids.reduce((n, id) => n + (this.paragraphs.get(id)?.text.length ?? 0), 0);
    for (const id of this.pending) {
      if (selected.has(id)) continue;
      const paragraph = this.paragraphs.get(id);
      if (!paragraph) continue;
      if (chars + paragraph.text.length > budget) break;
      selected.add(id); chars += paragraph.text.length;
    }
    const ids = [...selected].sort((a, b) => a - b);
    ids.forEach(id => this.pending.delete(id));
    return { ids, currentIds: [...frame.ids], texts: ids.map(id => this.paragraphs.get(id)?.text ?? "") };
  }

  requeue(batch: Batch) { batch.ids.forEach(id => this.pending.add(id)); }

  prune(protectedIds: number[] = []) {
    if (this.paragraphs.size <= 2000) return;
    const protectedSet = new Set([...protectedIds, ...this.pending, ...[...this.frames.values()].flatMap(f => f.ids)]);
    for (const id of this.paragraphs.keys()) {
      if (this.paragraphs.size <= 1600) break;
      if (!protectedSet.has(id)) this.paragraphs.delete(id);
    }
  }
}
