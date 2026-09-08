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
import { join, resolve } from "node:path";

export function defaultRoot(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "video-feed");
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

  static async open(path: string): Promise<WorkDir> {
    const p = resolve(path.replace(/^~/, homedir()));
    const s = await stat(p).catch(() => null);
    if (!s?.isDirectory()) throw new Error(`no such work dir: ${p}`);
    return new WorkDir(p);
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
