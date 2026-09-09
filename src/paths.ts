/**
 * Where settings, work dirs and the extracted sidecar live.
 *
 * POSIX follows the XDG layout. Windows has its own, and it is not cosmetic:
 * settings belong in roaming `%APPDATA%`, bulk data and caches in machine-local
 * `%LOCALAPPDATA%` so they are not copied between machines on a domain profile.
 * A dotted `~/.config` there is litter in a directory users actually open.
 *
 * `XDG_*` still wins wherever it is set, Windows included -- someone who
 * exports it means it.
 */
import { homedir } from "node:os";
import { posix as posixPath, win32 as winPath } from "node:path";

const APP = "video-feed";

/** Injectable environment, so the layout can be tested for a platform that is
 *  not the one running the tests. */
export interface PathEnv {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
}

function ctx(o: PathEnv) {
  const platform = o.platform ?? process.platform;
  return {
    env: o.env ?? process.env,
    platform,
    home: o.home ?? homedir(),
    // Pick the joiner by target platform rather than by host. At runtime the
    // two are the same thing; being explicit is what lets the Windows layout be
    // tested from anywhere.
    join: platform === "win32" ? winPath.join : posixPath.join,
  };
}

export function configHome(o: PathEnv = {}): string {
  const { env, platform, home, join } = ctx(o);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, APP);
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, APP);
  return join(home, ".config", APP);
}

export function dataHome(o: PathEnv = {}): string {
  const { env, platform, home, join } = ctx(o);
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, APP);
  // Split from the cache below rather than sharing one directory: work dirs are
  // named after the video and would sit alongside the sidecar file otherwise.
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP, "data");
  return join(home, ".local", "share", APP);
}

export function cacheHome(o: PathEnv = {}): string {
  const { env, platform, home, join } = ctx(o);
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, APP);
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP, "cache");
  return join(home, ".cache", APP);
}
