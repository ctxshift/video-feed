/**
 * Stage 2: speech -> verbatim, timestamped text.
 *
 * Local transcription runs faster-whisper through a Python sidecar. The sidecar
 * is embedded in this binary and written to a cache dir on first use, then run
 * with `uv run --script` -- uv resolves and caches its dependencies, so there is
 * no install step and no virtualenv to manage.
 *
 * The model is never asked to interpret here. Cleanup happens in the vision
 * stage, where the screen is available as evidence.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ASR_HASH, ASR_SCRIPT } from "./asr-embedded";
import { requireTool, runStreaming, type RunResult } from "./proc";
import { SOURCE, TRANSCRIPT, type Event, type Source, type Transcript } from "./types";
import type { WorkDir } from "./workdir";

/** Terms a general ASR model reliably mangles, seeded into the decoder. */
export const DEFAULT_HOTWORDS =
  "kubectl, Kubernetes, Docker, Terraform, Ansible, nginx, Postgres, Redis, " +
  "GraphQL, TypeScript, Rust, Elixir, Phoenix, LiveView, CUDA, PyTorch, " +
  "GitHub, GitLab, CI/CD, YAML, JSON, API, CLI, SDK, LLM, GPU";

/** Materialise the embedded sidecar. Hash in the name means a rebuilt binary
 *  writes a new file instead of silently reusing a stale one. */
async function sidecarPath(): Promise<string> {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "video-feed");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `whisper-${ASR_HASH}.py`);
  if (!(await Bun.file(path).exists())) await Bun.write(path, ASR_SCRIPT);
  return path;
}

export interface AsrOptions {
  engine?: "whisper" | "gemini";
  model?: string;
  device?: string;
  language?: string;
  hotwords?: string;
  force?: boolean;
}

export async function* transcribe(
  wd: WorkDir,
  opts: AsrOptions = {},
): AsyncGenerator<Event, Transcript> {
  const { engine = "whisper", device = "cuda", hotwords = DEFAULT_HOTWORDS, force = false } = opts;

  if ((await wd.has(TRANSCRIPT)) && !force) {
    yield { type: "done", message: "already transcribed" };
    return wd.read<Transcript>(TRANSCRIPT);
  }

  const src = await wd.read<Source>(SOURCE);
  const audio = wd.file(src.audio);
  if (!(await Bun.file(audio).exists())) {
    throw new Error(`audio missing: ${audio} — re-run \`vid fetch\``);
  }

  let out: Transcript;
  if (engine === "whisper") {
    out = yield* whisperLocal(audio, { ...opts, device, hotwords });
  } else {
    out = yield* geminiTranscribe(audio, opts, hotwords);
  }

  out.hotwords = hotwords;
  await wd.write(TRANSCRIPT, out);
  yield { type: "done", message: `${out.segments.length} segments` };
  return out;
}

async function* whisperLocal(
  audio: string,
  opts: AsrOptions & { device: string; hotwords: string },
): AsyncGenerator<Event, Transcript> {
  await requireTool("uv");
  const script = await sidecarPath();
  const model = opts.model ?? "large-v3";

  yield { type: "status", message: `preparing ${model} (first run downloads the model)` };

  const cmd = [
    "uv", "run", "--script", script,
    "--audio", audio,
    "--model", model,
    "--device", opts.device,
    "--hotwords", opts.hotwords,
    ...(opts.language ? ["--language", opts.language] : []),
  ];

  const stream = runStreaming(cmd);
  let result: RunResult | undefined;

  for (;;) {
    const step = await stream.next();
    if (step.done) {
      result = step.value;
      break;
    }
    const ev = step.value as any;
    if (ev?.type === "progress" && ev.total) {
      yield { type: "progress", done: ev.done, total: ev.total, label: "transcribing" };
    } else if (ev?.type === "status") {
      yield { type: "status", message: ev.message };
    } else if (ev?.type === "error") {
      throw new Error(`transcription failed: ${ev.message}`);
    }
  }

  if (!result || result.code !== 0) {
    throw new Error(
      `transcription sidecar exited ${result?.code}.\n` +
        (result?.stderr ?? "").split("\n").slice(-12).join("\n"),
    );
  }
  return JSON.parse(result.stdout) as Transcript;
}

async function* geminiTranscribe(
  audio: string,
  opts: AsrOptions,
  hotwords: string,
): AsyncGenerator<Event, Transcript> {
  const { getClient, jsonResponse, uploadAndWait, DEFAULT_TRANSCRIBE_MODEL } = await import("./gemini");
  const model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
  const client = await getClient();

  yield { type: "status", message: "uploading audio" };
  const file = await uploadAndWait(client, audio);

  yield { type: "status", message: `transcribing with ${model}` };
  const segments = await jsonResponse(client, model, [
    { fileData: { fileUri: file.uri!, mimeType: file.mimeType! } },
    {
      text:
        "Transcribe this audio verbatim, with timestamps.\n" +
        "Return JSON only: a list of objects with keys start (seconds, number), " +
        "end (seconds, number), text (string).\n" +
        "Do not summarise, paraphrase, or clean up filler words.\n" +
        `Expect these technical terms: ${hotwords}`,
    },
  ]);

  return {
    engine: "gemini",
    model,
    language: null,
    segments: segments as Transcript["segments"],
  };
}
