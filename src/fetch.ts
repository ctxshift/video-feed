/**
 * Stage 1: pull the video down.
 *
 * Metadata, an audio track for ASR, and (unless skipped) the video itself for
 * the vision pass. Also records whether the uploader published real captions --
 * human-written captions beat any ASR, and that is worth knowing before
 * spending GPU time or API credit.
 */
import { requireTool, run } from "./proc";
import { SOURCE, type Event, type Source } from "./types";
import { WorkDir } from "./workdir";

async function ytdlp(args: string[]) {
  return run(["yt-dlp", "--no-warnings", ...args]);
}

export async function probe(url: string): Promise<any> {
  await requireTool("yt-dlp");
  const r = await ytdlp(["--dump-single-json", url]);
  if (r.code !== 0) throw new Error(`yt-dlp could not read ${url}:\n${r.stderr.trim().slice(0, 800)}`);
  return JSON.parse(r.stdout);
}

export function captionTracks(meta: any): { manual: string[]; auto: string[] } {
  return {
    manual: Object.keys(meta.subtitles ?? {}).sort(),
    auto: Object.keys(meta.automatic_captions ?? {}).sort(),
  };
}

export interface FetchOptions {
  root?: string;
  wantVideo?: boolean;
  lang?: string;
  force?: boolean;
}

export async function* fetchVideo(
  url: string,
  opts: FetchOptions = {},
): AsyncGenerator<Event, WorkDir> {
  const { wantVideo = true, lang = "en", force = false } = opts;

  yield { type: "status", message: "reading metadata" };
  const meta = await probe(url);
  const id: string = meta.id ?? "unknown";
  const wd = await WorkDir.forVideo(id, meta.title ?? null, opts.root);

  if ((await wd.has(SOURCE)) && !force) {
    yield { type: "done", message: "already fetched" };
    return wd;
  }

  const captions = captionTracks(meta);
  if (captions.manual.length) {
    yield {
      type: "warn",
      message: `human-written captions exist (${captions.manual.join(", ")}) — likely better than ASR`,
    };
  }

  // Audio: m4a is small and ffmpeg-friendly; ASR gains nothing from more.
  yield { type: "status", message: "downloading audio" };
  const a = await ytdlp([
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "-o", wd.file("audio.%(ext)s"),
    url,
  ]);
  if (a.code !== 0) throw new Error(`audio download failed:\n${a.stderr.trim().slice(0, 800)}`);

  const files = await Array.fromAsync(new Bun.Glob("audio.*").scan({ cwd: wd.path }));
  const audio = files.find((f) => !f.endsWith(".tmp"));
  if (!audio) throw new Error("audio download reported success but wrote no file");

  let video: string | null = null;
  if (wantVideo) {
    // 720p cap: slides and terminal text survive it, and higher costs download
    // time and upload tokens for detail the model does not need.
    yield { type: "status", message: "downloading video" };
    const v = await ytdlp([
      "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
      "--merge-output-format", "mp4",
      "-o", wd.file("video.%(ext)s"),
      url,
    ]);
    if (v.code !== 0) throw new Error(`video download failed:\n${v.stderr.trim().slice(0, 800)}`);
    video = (await Bun.file(wd.file("video.mp4")).exists()) ? "video.mp4" : null;
  }

  if (captions.manual.length) {
    await ytdlp([
      "--write-subs", "--sub-langs", lang, "--sub-format", "vtt",
      "--skip-download", "-o", wd.file("captions"), url,
    ]);
  }

  const source: Source = {
    url,
    id,
    title: meta.title ?? null,
    uploader: meta.uploader ?? null,
    durationS: meta.duration ?? null,
    captions,
    audio,
    video,
  };
  await wd.write(SOURCE, source);
  yield { type: "done", message: source.title ?? id };
  return wd;
}
