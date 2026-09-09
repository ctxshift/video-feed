/**
 * Where settings, work dirs and the extracted sidecar live.
 *
 * One layout on every platform, Windows included: `~/.config`,
 * `~/.local/share` and `~/.cache`, each overridable by its XDG variable.
 *
 * 0.2.0 briefly moved these to `%APPDATA%` and `%LOCALAPPDATA%` on Windows to
 * match platform convention. That fixed nothing -- `~/.config` is a perfectly
 * valid Windows path and always worked -- and it orphaned the config of anyone
 * upgrading, who got "no API key" with the key still sitting on disk. One
 * predictable location is worth more here than matching each platform's
 * conventions, so there is exactly one and no fallback to maintain.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "video-feed";

/** Injectable environment, so the layout can be tested without touching $HOME. */
export interface PathEnv {
  env?: Record<string, string | undefined>;
  home?: string;
}

function ctx(o: PathEnv) {
  return {
    env: o.env ?? process.env,
    home: o.home ?? homedir(),
  };
}

export function configHome(o: PathEnv = {}): string {
  const { env, home } = ctx(o);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), APP);
}

export function dataHome(o: PathEnv = {}): string {
  const { env, home } = ctx(o);
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP);
}

export function cacheHome(o: PathEnv = {}): string {
  const { env, home } = ctx(o);
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), APP);
}
