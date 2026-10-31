import { browser } from "wxt/browser";
import { filterOcrLines, linesToParagraphs } from "../domain/score.js";
import type { Shot } from "../domain/types";
interface Line { text: string; bbox: { x0: number; x1: number; y0: number; y1: number }; confidence?: number }
interface OcrWorker {
  recognize(image: Blob, options: object, output: object): Promise<{ data: { blocks?: { paragraphs?: { lines?: Line[] }[] }[] } }>;
  terminate(): Promise<void>;
}
interface OcrModule { createWorker(language: string, engine: number, options: Record<string, unknown>): Promise<OcrWorker> }
export interface Snapshot { canvas: OffscreenCanvas; fingerprint: string; scale: number }
export interface OcrResult { paragraphs: { text: string; y: number }[]; lines?: { text: string; y: number }[]; nonStory: boolean; stats: { lines: number; filtered: number; ms: number } }
const asset = (path: string) => browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]);
export class Vision {
  private worker: Promise<OcrWorker> | null = null;
  async snapshot(windowId: number, shot: Shot): Promise<Snapshot> {
    const data = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
    const full = await createImageBitmap(await (await fetch(data)).blob());
    try {
      const ratio = full.height / shot.vh;
      const x = Math.max(0, Math.round(shot.rect.x * ratio)), y = Math.max(0, Math.round(shot.rect.y * ratio));
      const width = Math.max(1, Math.min(full.width - x, Math.round(shot.rect.w * ratio)));
      const height = Math.max(1, Math.min(full.height - y, Math.round(shot.rect.h * ratio)));
      const down = Math.min(1, 1440 / Math.max(width, height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * down)), Math.max(1, Math.round(height * down)));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("화면 전처리를 시작하지 못했습니다.");
      context.filter = "grayscale(1) contrast(1.6)";
      context.drawImage(full, x, y, width, height, 0, 0, canvas.width, canvas.height);
      let fingerprint = 2166136261;
      for (const value of context.getImageData(0, 0, canvas.width, canvas.height).data) fingerprint = Math.imul(fingerprint ^ value, 16777619);
      return { canvas, fingerprint: `${canvas.width}x${canvas.height}:${fingerprint >>> 0}`, scale: ratio * down };
    } finally { full.close(); }
  }
  private load() {
    if (!this.worker) this.worker = (async () => {
      const module = await import(/* @vite-ignore */ asset("/vendor/tesseract/tesseract.esm.min.js")) as { default: OcrModule };
      return module.default.createWorker("kor+eng", 1, {
        workerPath: asset("/vendor/tesseract/worker.min.js"), corePath: asset("/vendor/tesseract/core"),
        langPath: asset("/vendor/tesseract/lang"), workerBlobURL: false, cacheMethod: "none",
      });
    })().catch(error => { this.worker = null; throw error; });
    return this.worker;
  }
  async read(snapshot: Snapshot, shot: Shot): Promise<OcrResult> {
    const worker = await this.load(), started = performance.now();
    const { data } = await worker.recognize(await snapshot.canvas.convertToBlob({ type: "image/png" }), {}, { blocks: true, text: false });
    const lines = (data.blocks ?? []).flatMap(block => (block.paragraphs ?? []).flatMap(paragraph => paragraph.lines ?? []));
    const filtered = filterOcrLines(lines);
    const paragraphs = linesToParagraphs(filtered.lines, snapshot.canvas.height, snapshot.canvas.width) as { text: string; y0: number }[];
    return {
      paragraphs: paragraphs.map(p => ({ text: p.text, y: shot.top + p.y0 / snapshot.scale })),
      lines: filtered.lines.map(line => ({ text: line.text.trim(), y: shot.top + line.bbox.y0 / snapshot.scale })),
      nonStory: !paragraphs.length && (filtered.cutoff !== null || filtered.removed > 0),
      stats: { lines: lines.length, filtered: lines.length - filtered.lines.length, ms: performance.now() - started },
    };
  }
  async dispose() { const worker = this.worker; this.worker = null; if (worker) await worker.then(w => w.terminate()).catch(() => {}); }
}
