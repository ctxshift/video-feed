/**
 * Stage 3: watch the video, correct the transcript.
 *
 * The transcript goes in as context and comes back untouched. What comes out is
 * a list of proposed edits, each carrying its evidence, plus timestamped notes
 * on what was on screen. Applying the edits is the render stage's job, and it
 * is mechanical.
 *
 * Asking for a corrected transcript instead would work, and would be wrong: a
 * model handed a transcript rewrites more than it reports, quietly. Edits are
 * auditable, cheap to review, and can be rejected one at a time.
 */
import { getClient, jsonResponse, uploadAndWait, videoModel } from "./gemini";
import {
  CORRECTIONS,
  SCREEN,
  SOURCE,
  TRANSCRIPT,
  type Correction,
  type Event,
  type ScreenNote,
  type Segment,
  type Source,
  type Transcript,
} from "./types";
import type { WorkDir } from "./workdir";

const PROMPT = `You are given a video and a machine transcript of its audio. The transcript is
verbatim but contains speech-recognition errors, especially in technical terms.

Return JSON with exactly two keys.

"corrections": proposed edits to the transcript. Only include an edit when you
have concrete evidence -- most valuably, text visible on screen (a terminal, an
editor, slides, a diagram). Each item:
  {"t": "MM:SS", "was": "<exact text from the transcript>",
   "now": "<corrected text>", "evidence": "<what shows this, e.g. 'command in
   terminal at 04:12'>", "confidence": "high"|"medium"|"low"}
Rules:
  - "was" MUST appear verbatim in the transcript. Never invent it.
  - Fix misheard words, wrong technical spellings, and mangled identifiers.
  - Do NOT rewrite for style, grammar, conciseness or filler words.
  - If nothing on screen or in context supports a change, leave it alone.
  - An empty list is a correct answer.

"screen": what the video showed, as timestamped observations. Each item:
  {"start": "MM:SS", "end": "MM:SS", "summary": "<one or two sentences>",
   "text": "<literal on-screen text: commands, code, slide titles; empty if none>"}
Cover the whole clip. Describe what is actually visible -- do not narrate the
speech again.

Transcript for this clip:
`;

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function parseClock(t: string): number | null {
  const parts = String(t).split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

const asText = (segs: Segment[]) =>
  segs.map((s) => `[${clock(s.start)}] ${s.text}`).join("\n");

export interface VisionOptions {
  model?: string;
  chunkS?: number;
  fps?: number;
  hiRes?: boolean;
  force?: boolean;
}

export interface VisionResult {
  screen: ScreenNote[];
  corrections: Correction[];
  dropped: number;
  model: string;
}

export async function* watch(
  wd: WorkDir,
  opts: VisionOptions = {},
): AsyncGenerator<Event, VisionResult> {
  const { chunkS = 600, fps = 1, hiRes = true, force = false } = opts;
  const model = opts.model ?? (await videoModel());

  if ((await wd.has(SCREEN)) && (await wd.has(CORRECTIONS)) && !force) {
    yield { type: "done", message: "already watched" };
    return {
      screen: await wd.read<ScreenNote[]>(SCREEN),
      corrections: await wd.read<Correction[]>(CORRECTIONS),
      dropped: 0,
      model,
    };
  }

  const src = await wd.read<Source>(SOURCE);
  if (!src.video) throw new Error("no video in this work dir — re-run `vid fetch` without --no-video");
  const videoPath = wd.file(src.video);
  if (!(await Bun.file(videoPath).exists())) throw new Error(`video missing: ${videoPath}`);

  const transcript = await wd.read<Transcript>(TRANSCRIPT);
  const segments = transcript.segments;
  const duration = src.durationS ?? (segments.at(-1)?.end ?? 0);

  const client = await getClient();
  yield { type: "status", message: "uploading video" };
  const file = await uploadAndWait(client, videoPath);

  const spans: [number, number][] =
    chunkS <= 0
      ? [[0, duration]]
      : Array.from({ length: Math.ceil(duration / chunkS) }, (_, i) => {
          const start = i * chunkS;
          return [start, Math.min(start + chunkS, duration)] as [number, number];
        });

  const screen: ScreenNote[] = [];
  const corrections: Correction[] = [];

  for (const [i, [start, end]] of spans.entries()) {
    const window = segments.filter((s) => s.end > start && s.start < end);
    if (!window.length) continue;

    yield {
      type: "progress",
      done: i,
      total: spans.length,
      label: `watching ${clock(start)}–${clock(end)}`,
    };

    const parts = [
      {
        fileData: { fileUri: file.uri!, mimeType: file.mimeType! },
        // start/end clip this request to one span instead of re-sending the
        // whole video; fps trades detail against tokens -- 1 is plenty for a
        // talking head, more for a screencast where the screen moves.
        videoMetadata: {
          startOffset: `${Math.floor(start)}s`,
          endOffset: `${Math.floor(end)}s`,
          fps,
        },
      },
      { text: PROMPT + asText(window) },
    ];

    // Fine on-screen text -- terminal output, code, slide bullets -- is the
    // entire point of this pass, and it is the first thing lost at low
    // resolution.
    const config = hiRes ? { mediaResolution: "MEDIA_RESOLUTION_HIGH" } : {};
    const out = (await jsonResponse(client, model, parts, config)) as any;

    if (out && typeof out === "object") {
      if (Array.isArray(out.screen)) screen.push(...out.screen);
      if (Array.isArray(out.corrections)) corrections.push(...out.corrections);
    }
  }

  // A correction whose "was" is not in the transcript cannot be applied, and is
  // the model inventing text. Drop it here so render never has to reason about it.
  const haystack = segments.map((s) => s.text).join(" ");
  const kept = corrections.filter((c) => c?.was && haystack.includes(c.was));
  const dropped = corrections.length - kept.length;

  await wd.write(SCREEN, screen);
  await wd.write(CORRECTIONS, kept);

  if (dropped) {
    yield { type: "warn", message: `${dropped} corrections discarded — quoted text not in transcript` };
  }
  yield { type: "done", message: `${kept.length} corrections, ${screen.length} screen notes` };
  return { screen, corrections: kept, dropped, model };
}
