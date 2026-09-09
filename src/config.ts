/**
 * Settings, layered: environment > config file > built-in default.
 *
 * Secrets are handled differently from settings. The preferred way to supply a
 * key is `api_key_command` -- a shell command that prints it -- so nothing
 * sensitive is stored on disk and any secret manager works. A literal `api_key`
 * is supported for people not running one, and warns if the file is readable by
 * anyone else.
 */
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { configHome } from "./paths";
import { runForSecret, shellCommand } from "./proc";

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
  return configHome();
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

/**
 * True if anyone but the owner can read the config file.
 *
 * Windows has no POSIX mode bits -- node synthesises 0o666 for every file, so
 * this would warn on every config and then advise a `chmod` that does not
 * exist. Files under the user profile are already ACL'd to that user there.
 */
export async function configIsExposed(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === "win32") return false;
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
    const r = await runForSecret(shellCommand(cmd));
    if (r.code !== 0 || !r.stdout.trim()) {
      const managerHint = /^\s*op\b/.test(cmd)
        ? "1Password: a service account needs OP_SERVICE_ACCOUNT_TOKEN in the " +
          "environment, otherwise run `op signin` first.\n"
        : "";
      throw new Error(
        `api_key_command failed (exit ${r.code}): ${cmd}\n` +
          "Its output is above, if it printed anything.\n" +
          managerHint +
          `Configured in ${configPath()}\n` +
          "No secret manager? Run `vid config --set-key` and store the key directly.",
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

  const setEnv =
    process.platform === "win32"
      ? '  $env:GEMINI_API_KEY = "..."   (PowerShell; `setx` to keep it)'
      : "  export GEMINI_API_KEY=...";

  // Ordered by how many people can actually use each one. A secret manager is
  // the nicest answer and the one fewest users have, so it goes last.
  throw new Error(
    "No Gemini API key found. Get one at https://aistudio.google.com/apikey, then:\n\n" +
      "  vid config --set-key          enter it once, stored in the config file\n" +
      `${setEnv}\n` +
      "  api_key_command = \"...\"       if you run a secret manager\n" +
      `                                (in ${configPath()})`,
  );
}

export const STARTER = `# video-feed configuration
# Every value here is optional; these are the defaults.

[gemini]
# The key itself. The easiest way to set it is \`vid config --set-key\`, which
# prompts without echoing and writes it here with the right permissions.
# api_key = "..."

# Or, if you run a secret manager, a command that prints the key -- then no
# secret is stored on disk at all. Any of these shapes work:
#   api_key_command = "op read op://Vault/Item/credential"              # 1Password
#   api_key_command = "pass show gemini/api-key"                        # pass
#   api_key_command = "security find-generic-password -w -s gemini"     # macOS Keychain
#   api_key_command = "powershell -c (Get-Secret gemini -AsPlainText)"  # Windows

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
# data_dir = "~/.local/share/video-feed"   # %LOCALAPPDATA%\\video-feed\\data on Windows
`;

/**
 * Store an API key in the config file, creating it if it does not exist.
 *
 * Text surgery rather than a TOML round-trip: the starter file is mostly
 * comments explaining the options, and re-emitting parsed TOML would silently
 * throw all of them away.
 */
export async function writeApiKey(key: string): Promise<{ path: string; created: boolean }> {
  const path = configPath();
  const file = Bun.file(path);
  const created = !(await file.exists());
  let text = created ? STARTER : await file.text();

  const literal = `api_key = "${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  const commentedPlaceholder = /^[ \t]*#[ \t]*api_key[ \t]*=.*$/m;

  if (/^[ \t]*api_key[ \t]*=/m.test(text)) {
    text = text.replace(/^[ \t]*api_key[ \t]*=.*$/m, literal);
  } else if (commentedPlaceholder.test(text)) {
    // Land on the commented-out example, so the key sits under the comment
    // that explains it rather than above it.
    text = text.replace(commentedPlaceholder, literal);
  } else if (/^\[gemini\][ \t]*$/m.test(text)) {
    text = text.replace(/^\[gemini\][ \t]*$/m, `[gemini]\n${literal}`);
  } else {
    text = `${text.trimEnd()}\n\n[gemini]\n${literal}\n`;
  }

  await mkdir(configDir(), { recursive: true });
  await Bun.write(path, text);
  // Windows has no mode bits to set; the profile directory is already ACL'd to
  // this user, and chmod there would only toggle the read-only flag.
  if (process.platform !== "win32") await chmod(path, 0o600);

  // Both caches are now stale -- the file they were read from just changed.
  cached = undefined;
  resolvedKey = undefined;

  return { path, created };
}
