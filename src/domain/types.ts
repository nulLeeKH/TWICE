export type Availability = "available" | "downloadable" | "downloading" | "unavailable";
export type ModelKind = "checking" | "unsupported" | "unavailable" | "available" | "downloadable" | "downloading" | "initializing" | "ready" | "error";
export interface ModelState {
  kind: ModelKind;
  title: string;
  detail: string;
  lm?: Availability;
  progress?: number;
  /** Host of the OpenAI-compatible endpoint in use; story text leaves the device. */
  external?: string;
  component?: string;
}
export interface Ambience { engine: string; variant?: string; p1: number; p2: number; p3: number }
export interface Effect { p: number; type: string; p1: number }
export interface Decision {
  action: "continue" | "change" | "silence" | "non_story";
  music_action: "keep" | "change" | "pause" | "resume";
  mood: string; intensity: number; muffle: number; room: number;
  start_p: number; end_p: number;
  ambience: Ambience[]; sfx: Effect[];
  reason?: string; context_summary?: string; sfx_interval_s?: number;
  guards?: string[]; model_ambience?: Ambience[];
}
export interface Rect { x: number; y: number; w: number; h: number }
export interface Shot {
  type: "twice:shot"; paged: boolean; top: number; rect: Rect; vh: number;
  range: [number, number]; view: number; at: number;
}
export interface Settled { mode: "scroll" | "paged"; range: [number, number]; view: number; reason: string }
export interface Paragraph { idx: number; text: string; y: number; scope: string; key: string }
export interface Frame {
  key: string; ids: number[]; range: [number, number]; view: number;
  nonStory: boolean; decision?: Decision; recentLines?: string[];
}
export interface Batch { ids: number[]; currentIds: number[]; texts: string[] }
export interface AnalysisProgress {
  phase: "nano" | "music" | "ambience" | "parse";
  decision?: Decision; raw?: string; input?: string; ms?: number;
}
export interface AnalysisResult {
  segments: Decision[]; context_summary: string; reason: string; sfx_interval_s: number;
  raw: string; input: string; ms: { nano: number };
}
export interface Playback {
  sound: string; musicPaused: boolean; musicStarted: boolean;
  context: string; previousScreen: string; recentLines?: string[];
}
export interface Mix { master: number; music: number; ambience: number; sfx: number }
export interface ModelStage { phase: string; started: number; elapsed: number; batch?: { current: number; merged: number } }
export interface Diagnostics {
  stage: ModelStage | null;
  input: string; raw: string; context: string;
  proposed: Decision | null; applied: Decision | null;
  application: string; effects: string; events: string[];
  timing: Record<string, number>;
}
