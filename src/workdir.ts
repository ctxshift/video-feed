/**
 * Per-video working directory.
 *
 * Each stage writes exactly one JSON artifact and reads the previous stage's.
 * A stage whose artifact exists is skipped unless forced -- these stages are
 * slow (GPU transcription) or cost money (the vision pass), so a failure should
 * cost one step, not the whole pipeline.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix as posixPath, resolve, win32 as winPath } from "node:path";

import { dataHome } from "./paths";

export function defaultRoot(): string {
  return dataHome();
}

/** `~` only counts as home when it is the whole first segment: `~files` is a
 *  directory name, not a home-relative path. */
export function expandHome(p: string, home: string = homedir()): string {
  return p.replace(/^~(?=$|[\\/])/, home);
}

/**
 * Is this one of the bare names `vid ls` prints, rather than a path?
 *
 * Windows separates with either slash, so `C:\\videos\\talk` has to read as a
 * path there. On POSIX a backslash is a legal filename character and must not.
 */
export function isBareName(p: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === "win32";
  if (!p || (win ? winPath : posixPath).isAbsolute(p)) return false;
  return !(win ? /[\\/]/ : /\//).test(p);
}

export function slug(text: string, limit = 60): string {
  return (
    text
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, limit)
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

export class WorkDir {
  constructor(readonly path: string) {}

  static async forVideo(id: string, title: string | null, root?: string): Promise<WorkDir> {
    const name = title ? `${slug(title)}-${id}` : id;
    const wd = new WorkDir(join(root ?? defaultRoot(), name));
    await mkdir(wd.path, { recursive: true });
    return wd;
  }

  /**
   * Accept either a path or a bare work-dir name.
   *
   * `vid ls` prints bare names, so those are what a caller has to hand; without
   * the second lookup they resolve against the current directory and every
   * command fails on the name the tool just printed.
   */
  static async open(path: string): Promise<WorkDir> {
    const expanded = expandHome(path);
    const candidates = [resolve(expanded)];
    if (isBareName(expanded)) candidates.push(join(defaultRoot(), expanded));

    for (const p of candidates) {
      const s = await stat(p).catch(() => null);
      if (s?.isDirectory()) return new WorkDir(p);
    }
    throw new Error(`no such work dir: ${candidates.join(" or ")}`);
  }

  file(name: string): string {
    return join(this.path, name);
  }

  async has(name: string): Promise<boolean> {
    const f = Bun.file(this.file(name));
    return (await f.exists()) && f.size > 0;
  }

  async read<T>(name: string): Promise<T> {
    return (await Bun.file(this.file(name)).json()) as T;
  }

  /** Write-then-rename: a killed process leaves the old artifact intact
   *  rather than a truncated one that `has()` would happily accept. */
  async write(name: string, data: unknown): Promise<string> {
    const target = this.file(name);
    const tmp = `${target}.tmp`;
    await Bun.write(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, target);
    return target;
  }

  static async list(root?: string): Promise<WorkDir[]> {
    const base = root ?? defaultRoot();
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => new WorkDir(join(base, e.name)));
  }
}
