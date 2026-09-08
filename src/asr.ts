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
import { requireTool, run, runStreaming, type RunResult } from "./proc";
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
    throw new Error(await sidecarFailure(result, opts.device));
  }
  return JSON.parse(result.stdout) as Transcript;
}

/** The card refusing us, in the several shapes the stack reports it. */
export function isGpuFailure(stderr: string): boolean {
  return /CUDA (failed|error|out of memory)|out of memory|CUBLAS|cuDNN/i.test(stderr);
}

/**
 * Turn a sidecar crash into something a caller can act on.
 *
 * CUDA failures are the common case and the raw traceback buries the one line
 * that matters twelve frames deep. They are also usually not this process's
 * fault -- another program holding the card is enough -- so the message says
 * who has the memory and what to do about it.
 */
export async function sidecarFailure(
  result: Pick<RunResult, "code" | "stderr"> | undefined,
  device: string,
): Promise<string> {
  const stderr = result?.stderr ?? "";
  const tail = stderr.split("\n").filter(Boolean).slice(-12).join("\n");

  if (isGpuFailure(stderr)) {
    const free = await freeVram();
    return [
      "the GPU rejected the transcription.",
      free ? `  ${free}` : "",
      "  Usually something else holds the card -- ComfyUI and llama-swap both keep",
      "  models resident between requests. Free it, or transcribe on the CPU:",
      "",
      `    vid words <workdir> -d cpu${device === "cuda" ? "" : ` (already on ${device})`}`,
      "",
      "  CPU is roughly an order of magnitude slower; a smaller model (-m medium)",
      "  is often the better trade.",
      "",
      tail,
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  return `transcription sidecar exited ${result?.code}.\n${tail}`;
}

/** Best-effort VRAM read; absent nvidia-smi just means a shorter message. */
async function freeVram(): Promise<string | null> {
  const r = await run([
    "nvidia-smi",
    "--query-gpu=memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]).catch(() => null);
  if (!r || r.code !== 0) return null;

  const [used, total] = (r.stdout.split("\n")[0] ?? "").split(",").map((n) => Number(n.trim()));
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
  return `GPU has ${total! - used!} MiB free of ${total} MiB (${used} MiB in use).`;
}

async function* geminiTranscribe(
  audio: string,
  opts: AsrOptions,
  hotwords: string,
): AsyncGenerator<Event, Transcript> {
  const { getClient, jsonResponse, uploadAndWait, transcribeModel } = await import("./gemini");
  const model = opts.model ?? (await transcribeModel());
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
