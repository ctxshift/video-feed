/**
 * Settings, layered: environment > config file > built-in default.
 *
 * Secrets are handled differently from settings. The preferred way to supply a
 * key is `api_key_command` -- a shell command that prints it -- so nothing
 * sensitive is stored on disk and any secret manager works. A literal `api_key`
 * is supported for people not running one, and warns if the file is readable by
 * anyone else.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runForSecret } from "./proc";

export interface Config {
  gemini: {
    apiKey?: string;
    apiKeyCommand?: string;
    videoModel: string;
    transcribeModel: string;
  };
  whisper: { model: string; device: string; hotwords?: string };
  vision: { fps: number; chunkS: number; highRes: boolean };
  paths: { dataDir?: string };
}

const DEFAULTS: Config = {
  // Aliases, not pinned IDs: model names rot fast, and a stale default is the
  // more likely failure. `vid models` lists what a key can actually see.
  gemini: { videoModel: "gemini-flash-latest", transcribeModel: "gemini-flash-latest" },
  whisper: { model: "large-v3", device: "cuda" },
  vision: { fps: 1, chunkS: 600, highRes: true },
  paths: {},
};

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "video-feed");
}

export function configPath(): string {
  return join(configDir(), "config.toml");
}

/** Where a resolved value came from. Shown by `vid config`; never the value itself. */
export type Origin = "env" | "config" | "command" | "default" | "unset";

let cached: { config: Config; raw: any } | undefined;

export async function loadConfig(): Promise<{ config: Config; raw: any }> {
  if (cached) return cached;

  let raw: any = {};
  const file = Bun.file(configPath());
  if (await file.exists()) {
    try {
      raw = Bun.TOML.parse(await file.text());
    } catch (e) {
      throw new Error(
        `${configPath()} is not valid TOML: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const g = raw.gemini ?? {};
  const w = raw.whisper ?? {};
  const v = raw.vision ?? {};
  const p = raw.paths ?? {};

  const config: Config = {
    gemini: {
      apiKey: g.api_key,
      apiKeyCommand: g.api_key_command,
      videoModel: process.env.VIDEO_FEED_VIDEO_MODEL || g.video_model || DEFAULTS.gemini.videoModel,
      transcribeModel:
        process.env.VIDEO_FEED_TRANSCRIBE_MODEL ||
        g.transcribe_model ||
        DEFAULTS.gemini.transcribeModel,
    },
    whisper: {
      model: w.model || DEFAULTS.whisper.model,
      device: w.device || DEFAULTS.whisper.device,
      hotwords: w.hotwords,
    },
    vision: {
      fps: v.fps ?? DEFAULTS.vision.fps,
      chunkS: v.chunk_s ?? DEFAULTS.vision.chunkS,
      highRes: v.high_res ?? DEFAULTS.vision.highRes,
    },
    paths: { dataDir: p.data_dir },
  };

  cached = { config, raw };
  return cached;
}

/** True if anyone but the owner can read the config file. */
export async function configIsExposed(): Promise<boolean> {
  const s = await stat(configPath()).catch(() => null);
  return s ? (s.mode & 0o077) !== 0 : false;
}

export interface KeyResolution {
  key: string;
  origin: Origin;
  detail?: string;
}

/**
 * Resolve the API key. Returns its origin so `vid config` can report where it
 * came from without ever printing it.
 */
let resolvedKey: KeyResolution | undefined;

/**
 * Resolve once per process. `api_key_command` shells out to a secret manager,
 * which costs a second or so, and several code paths may want the key in one
 * run.
 *
 * Deliberately not cached to disk: the whole point of `api_key_command` is that
 * the secret is not stored. Anyone happy to have it on disk should set
 * `api_key` in the config file instead -- same trade, one obvious location,
 * already supported.
 */
export async function resolveApiKey(): Promise<KeyResolution> {
  if (resolvedKey) return resolvedKey;
  return (resolvedKey = await resolveApiKeyUncached());
}

async function resolveApiKeyUncached(): Promise<KeyResolution> {
  const fromEnv = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (fromEnv?.trim()) {
    return { key: fromEnv.trim(), origin: "env", detail: "GEMINI_API_KEY" };
  }

  const { config } = await loadConfig();

  if (config.gemini.apiKeyCommand) {
    const cmd = config.gemini.apiKeyCommand;
    const r = await runForSecret(["sh", "-c", cmd]);
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Error(
        `api_key_command failed (exit ${r.code}): ${cmd}\n` +
          "Its output is above, if it printed anything.\n" +
          "If this is 1Password: a service account needs OP_SERVICE_ACCOUNT_TOKEN " +
          "in the environment, otherwise run `op signin` first.\n" +
          `Configured in ${configPath()}`,
      );
    }
    return { key: r.stdout.trim(), origin: "command", detail: cmd };
  }

  if (config.gemini.apiKey) {
    if (await configIsExposed()) {
      process.stderr.write(
        `warning: ${configPath()} holds an API key and is readable by others.\n` +
          `         Fix with: chmod 600 ${configPath()}\n`,
      );
    }
    return { key: config.gemini.apiKey, origin: "config", detail: "gemini.api_key" };
  }

  throw new Error(
    "No Gemini API key found.\n\n" +
      "Set one of:\n" +
      "  export GEMINI_API_KEY=...\n" +
      `  ${configPath()}  ->  [gemini] api_key_command = "op read op://Vault/Item/credential"\n` +
      `  ${configPath()}  ->  [gemini] api_key = "..."\n\n" ` +
      "Run `vid config --init` to write a starter config.",
  );
}

export const STARTER = `# video-feed configuration
# Every value here is optional; these are the defaults.

[gemini]
# Preferred: a command that prints the key. Nothing sensitive is stored on disk,
# and any secret manager works (op, pass, gopass, security, vault).
# api_key_command = "op read op://Vault/Item/credential"

# Alternative: the key itself. If you use this, run:  chmod 600 this file
# api_key = "..."

# Defaults track the newest release. Pin an exact ID for reproducibility;
# \`vid models\` lists what your key can actually see.
# video_model = "gemini-flash-latest"          # or gemini-pro-latest for hard material
# transcribe_model = "gemini-flash-latest"     # needs timestamps, so not a pure ASR model

[whisper]
# model = "large-v3"     # tiny, base, small, medium, large-v3
# device = "cuda"        # cpu works, much slower
# hotwords = "kubectl, Kubernetes, Terraform"   # bias the decoder

[vision]
# fps = 1                # raise to 2-4 for screencasts
# chunk_s = 600          # seconds of video per request
# high_res = true        # false is cheaper, loses fine on-screen text

[paths]
# data_dir = "~/.local/share/video-feed"
`;
