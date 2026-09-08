/**
 * Gemini plumbing: credentials, uploads, strict-JSON calls.
 *
 * Model IDs move faster than this code will, so both defaults are environment
 * overridable and `vid models` lists what the key can actually see. A renamed
 * model is then a config change, not a code change.
 */
import { GoogleGenAI } from "@google/genai";

import { loadConfig, resolveApiKey } from "./config";

/** Model IDs come from config (or env); `vid models` shows what the key can see. */
export async function videoModel(): Promise<string> {
  return (await loadConfig()).config.gemini.videoModel;
}

export async function transcribeModel(): Promise<string> {
  return (await loadConfig()).config.gemini.transcribeModel;
}

let client: GoogleGenAI | undefined;

/** Lazy, so commands that never touch Gemini never need a key. */
export async function getClient(): Promise<GoogleGenAI> {
  if (!client) {
    const { key } = await resolveApiKey();
    client = new GoogleGenAI({ apiKey: key });
  }
  return client;
}

export async function listModels(c: GoogleGenAI): Promise<string[]> {
  const names: string[] = [];
  for await (const m of await c.models.list()) {
    if (m.name) names.push(m.name.replace(/^models\//, ""));
  }
  return names.sort();
}

/**
 * Media types the Files API needs told about.
 *
 * The SDK infers the type from the extension and refuses the upload when it
 * cannot -- and its table does not cover `.m4a`, which is exactly what yt-dlp
 * hands us for audio. So we state it. Keyed on what yt-dlp actually produces.
 */
const MIME_TYPES: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
};

export function mimeTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : MIME_TYPES[path.slice(dot).toLowerCase()];
}

/**
 * Upload a media file and block until it is usable.
 *
 * Video is not ready the moment the upload returns -- the API marks it
 * PROCESSING first, and using it too early fails in ways that read like a bad
 * request rather than a timing problem.
 */
export async function uploadAndWait(c: GoogleGenAI, path: string, timeoutMs = 900_000) {
  const mimeType = mimeTypeFor(path);
  let file = await c.files.upload({ file: path, ...(mimeType ? { config: { mimeType } } : {}) });
  const deadline = Date.now() + timeoutMs;

  while (file.state === "PROCESSING") {
    if (Date.now() > deadline) throw new Error(`${path} still PROCESSING after ${timeoutMs}ms`);
    await Bun.sleep(5000);
    file = await c.files.get({ name: file.name! });
  }
  if (file.state === "FAILED") throw new Error(`upload failed for ${path}: ${file.error?.message ?? ""}`);
  return file;
}

/** Parse a JSON body, tolerating a fenced code block around it. */
export function extractJson(text: string): unknown {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) body = fence[1]!.trim();
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!m) throw new Error(`model did not return JSON:\n${text.slice(0, 400)}`);
    return JSON.parse(m[1]!);
  }
}

/** Not every model has JSON mode -- the dedicated ASR models notably do not. */
function rejectsJsonMode(err: unknown): boolean {
  return /JSON mode is not enabled|responseMimeType/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * One call, JSON out. temperature 0 because these are extraction tasks.
 *
 * JSON mode is asked for but not depended on: `gemini-3.5-transcribe` and the
 * other speech-specialised models reject it outright, and since the model IDs
 * are configuration rather than code, that has to degrade instead of failing.
 * `extractJson` is doing the real work either way.
 */
export async function jsonResponse(
  c: GoogleGenAI,
  model: string,
  parts: unknown[],
  extraConfig: Record<string, unknown> = {},
): Promise<unknown> {
  const contents = [{ role: "user", parts: parts as any }];

  const call = (json: boolean) =>
    c.models.generateContent({
      model,
      contents,
      config: {
        temperature: 0,
        ...(json ? { responseMimeType: "application/json" } : {}),
        ...extraConfig,
      },
    });

  let resp;
  try {
    resp = await call(true);
  } catch (err) {
    if (!rejectsJsonMode(err)) throw err;
    resp = await call(false);
  }

  const text = resp.text;
  if (!text) {
    // The speech-only models answer in an `audioTranscription` part rather than
    // text: a plain blob with no timestamps, which is not what any caller here
    // is asking for. Say so, rather than reporting an empty response.
    const parts = (resp.candidates?.[0]?.content?.parts ?? []) as Array<Record<string, unknown>>;
    if (parts.some((part) => "audioTranscription" in part)) {
      throw new Error(
        `${model} is a speech-only model: it returns a plain transcript with no ` +
          `timestamps, and every stage here is keyed on them. Use a general model ` +
          `such as gemini-flash-latest for transcribe_model.`,
      );
    }
    throw new Error(`${model} returned an empty response`);
  }
  return extractJson(text);
}
