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

/** Pure: never mutates the input segments. */
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
    const rank = RANK[(String(c.confidence).toLowerCase() as Confidence)] ?? 2;
    if (rank < floor || !c.was || c.now == null) {
      skipped.push(c);
      continue;
    }
    const hit = out.find((s) => s.text.includes(c.was));
    if (hit) {
      hit.text = hit.text.split(c.was).join(c.now);
      applied.push(c);
    } else {
      skipped.push(c);
    }
  }
  return { segments: out, applied, skipped };
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
