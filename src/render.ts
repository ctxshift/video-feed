/**
 * Stage 4: merge the artifacts into something readable.
 *
 * Corrections are applied here, mechanically, and only where `was` still
 * matches exactly. Anything below the confidence floor is reported rather than
 * applied -- the point of keeping the evidence is being able to decide.
 */
import { clock, parseClock } from "./vision";
import {
  CORRECTIONS,
  SCREEN,
  SOURCE,
  TRANSCRIPT,
  type Confidence,
  type Correction,
  type ScreenNote,
  type Segment,
  type Source,
  type Transcript,
} from "./types";
import type { WorkDir } from "./workdir";

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function srtClock(seconds: number): string {
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    `${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`
  );
}

export interface Applied {
  segments: Segment[];
  applied: Correction[];
  skipped: Correction[];
}

/**
 * Apply corrections. Pure: never mutates the input segments.
 *
 * A quoted phrase often straddles a segment boundary -- ASR splits on pauses,
 * not on meaning, so "git checkout windows-main" can land half in one segment
 * and half in the next. Searching segment by segment misses those entirely, and
 * they were a fifth of all corrections on the first real video tested. So the
 * match runs against the joined text and the replacement is written back across
 * however many segments it spanned.
 */
export function applyCorrections(
  segments: Segment[],
  corrections: Correction[],
  minConfidence: Confidence = "medium",
): Applied {
  const floor = RANK[minConfidence] ?? 2;
  const out = segments.map((s) => ({ ...s }));
  const applied: Correction[] = [];
  const skipped: Correction[] = [];

  for (const c of corrections) {
    const rank = RANK[String(c.confidence).toLowerCase() as Confidence] ?? 2;
    if (rank < floor || !c.was || c.now == null) {
      skipped.push(c);
      continue;
    }

    // Offsets of each segment within the joined text, rebuilt every time
    // because a previous correction may have changed the lengths.
    const offsets: number[] = [];
    let joined = "";
    for (const seg of out) {
      offsets.push(joined.length);
      joined += (joined ? " " : "") + seg.text;
      if (offsets.length > 1) offsets[offsets.length - 1] = joined.length - seg.text.length;
    }

    const at = joined.indexOf(c.was);
    if (at < 0) {
      skipped.push(c);
      continue;
    }
    const endAt = at + c.was.length;

    const segmentAt = (pos: number) => {
      let idx = 0;
      for (let i = 0; i < out.length; i++) if (offsets[i]! <= pos) idx = i;
      return idx;
    };
    const first = segmentAt(at);
    const last = segmentAt(endAt - 1);

    if (first === last) {
      const local = at - offsets[first]!;
      const seg = out[first]!;
      seg.text = seg.text.slice(0, local) + c.now + seg.text.slice(local + c.was.length);
    } else {
      // Whole replacement goes into the segment where the match began; the
      // matched tail is removed from the ones it ran into. Wording stays
      // correct, and the timestamp is the one the phrase started at.
      const head = out[first]!;
      head.text = (head.text.slice(0, at - offsets[first]!) + c.now).trim();

      for (let i = first + 1; i <= last; i++) {
        const seg = out[i]!;
        const consumedTo = endAt - offsets[i]!;
        seg.text = (consumedTo >= seg.text.length ? "" : seg.text.slice(consumedTo)).trim();
      }
    }
    applied.push(c);
  }

  return { segments: out.filter((s) => s.text), applied, skipped };
}

export interface RenderOptions {
  format?: "md" | "txt" | "srt";
  minConfidence?: Confidence;
  includeScreen?: boolean;
  showFixes?: boolean;
}

export async function render(wd: WorkDir, opts: RenderOptions = {}): Promise<string> {
  const { format = "md", minConfidence = "medium", includeScreen = true, showFixes = true } = opts;

  const src = await wd.read<Source>(SOURCE);
  const transcript = await wd.read<Transcript>(TRANSCRIPT);
  const corrections = (await wd.has(CORRECTIONS)) ? await wd.read<Correction[]>(CORRECTIONS) : [];
  const screen =
    includeScreen && (await wd.has(SCREEN)) ? await wd.read<ScreenNote[]>(SCREEN) : [];

  const { segments, applied, skipped } = applyCorrections(
    transcript.segments,
    corrections,
    minConfidence,
  );

  if (format === "txt") return segments.map((s) => s.text).join("\n") + "\n";

  if (format === "srt") {
    return segments
      .map((s, i) => `${i + 1}\n${srtClock(s.start)} --> ${srtClock(s.end)}\n${s.text}\n`)
      .join("\n");
  }

  const L: string[] = [`# ${src.title ?? src.id}`, ""];
  if (src.uploader) L.push(`**${src.uploader}** · ${src.url}`);
  if (src.durationS) {
    L.push(
      `Duration ${clock(src.durationS)} · transcribed with ` +
        `${transcript.engine} ${transcript.model ?? ""}`.trimEnd(),
    );
  }
  L.push("", "---", "");

  const notesBetween = (from: number, to: number) =>
    screen.filter((o) => {
      const at = parseClock(o.start);
      return at !== null && at >= from && at < to;
    });

  segments.forEach((s, i) => {
    const next = segments[i + 1]?.start ?? s.end + 1;
    // The first segment claims everything before it: a note timestamped 00:00
    // would otherwise be dropped whenever speech starts a fraction of a second
    // in, which is almost always.
    const from = i === 0 ? Number.NEGATIVE_INFINITY : s.start;
    L.push(`**[${clock(s.start)}]** ${s.text}`);
    for (const note of notesBetween(from, next)) {
      if (note.summary) L.push(`> 🖥 ${note.summary.trim()}`);
      if (note.text) {
        L.push("> ```");
        for (const line of String(note.text).split("\n")) L.push(`> ${line}`);
        L.push("> ```");
      }
    }
    L.push("");
  });

  if (showFixes && (applied.length || skipped.length)) {
    L.push("---", "", "## Corrections", "");
    if (applied.length) {
      L.push(`Applied ${applied.length}:`, "", "| At | Was | Now | Evidence |", "|---|---|---|---|");
      for (const c of applied) {
        L.push(`| ${c.t ?? ""} | \`${c.was}\` | \`${c.now}\` | ${c.evidence ?? ""} |`);
      }
      L.push("");
    }
    if (skipped.length) {
      L.push(
        `Not applied (${skipped.length}) — below \`${minConfidence}\` confidence, ` +
          "or the original text no longer matched:",
        "",
      );
      for (const c of skipped) {
        L.push(`- ${c.t ?? ""} \`${c.was}\` → \`${c.now}\` (${c.confidence ?? "?"}) — ${c.evidence ?? ""}`);
      }
      L.push("");
    }
  }

  return L.join("\n");
}
