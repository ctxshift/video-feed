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
 * Upload a media file and block until it is usable.
 *
 * Video is not ready the moment the upload returns -- the API marks it
 * PROCESSING first, and using it too early fails in ways that read like a bad
 * request rather than a timing problem.
 */
export async function uploadAndWait(c: GoogleGenAI, path: string, timeoutMs = 900_000) {
  let file = await c.files.upload({ file: path });
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

/** One call, JSON out. temperature 0 because these are extraction tasks. */
export async function jsonResponse(
  c: GoogleGenAI,
  model: string,
  parts: unknown[],
  extraConfig: Record<string, unknown> = {},
): Promise<unknown> {
  const resp = await c.models.generateContent({
    model,
    contents: [{ role: "user", parts: parts as any }],
    config: { temperature: 0, responseMimeType: "application/json", ...extraConfig },
  });
  const text = resp.text;
  if (!text) throw new Error(`${model} returned an empty response`);
  return extractJson(text);
}
