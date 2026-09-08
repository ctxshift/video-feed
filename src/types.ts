/** Artifacts each stage writes into the work dir. */
export const SOURCE = "source.json";
export const TRANSCRIPT = "transcript.json";
export const SCREEN = "screen.json";
export const CORRECTIONS = "corrections.json";

export interface Source {
  url: string;
  id: string;
  title: string | null;
  uploader: string | null;
  durationS: number | null;
  captions: { manual: string[]; auto: string[] };
  audio: string;
  video: string | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  engine: "whisper" | "gemini";
  model: string;
  language: string | null;
  languageConfidence?: number;
  durationS?: number;
  hotwords?: string;
  segments: Segment[];
}

export type Confidence = "high" | "medium" | "low";

/**
 * A proposed edit, with the evidence for it. The vision stage never returns a
 * rewritten transcript -- only these -- so every change is reviewable and
 * applying them stays mechanical.
 */
export interface Correction {
  t: string;
  was: string;
  now: string;
  evidence: string;
  confidence: Confidence;
}

export interface ScreenNote {
  start: string;
  end: string;
  summary: string;
  text?: string;
}

/** Progress events streamed by every stage; the UI decides how to show them. */
export type Event =
  | { type: "status"; message: string }
  | { type: "progress"; done: number; total: number; label?: string }
  | { type: "warn"; message: string }
  | { type: "done"; message: string };
