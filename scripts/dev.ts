/**
 * Put the freshly built binary on PATH, and take it back off again.
 *
 *   bun run scripts/dev.ts link
 *   bun run scripts/dev.ts unlink
 *
 * This was a shell snippet in .mise.toml, which meant the dev loop needed a
 * POSIX shell and `ln -s` -- exactly what a Windows contributor does not have.
 * Bun already runs everywhere the build does, so it does the work instead.
 *
 * Both platforms keep the property that matters: rebuild and the thing on PATH
 * is the new binary, with no reinstall. A plain copy would not.
 */
import { chmod, lstat, mkdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const WINDOWS = process.platform === "win32";
const repo = resolve(import.meta.dir, "..");

function installDir(): string {
  if (process.env.VID_INSTALL_DIR) return process.env.VID_INSTALL_DIR;
  // Windows has no ~/.local/bin convention; %LOCALAPPDATA%\Programs is where
  // user-scoped tools go, and it is what scripts/install.ps1 uses.
  if (WINDOWS && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Programs", "vid");
  return join(homedir(), ".local", "bin");
}

/** The compiled binary. `bun build --compile` appends .exe on Windows. */
function builtBinary(): string {
  return join(repo, "dist", WINDOWS ? "vid.exe" : "vid");
}

const dir = installDir();
/** What `vid` on PATH resolves to. A .cmd shim on Windows without symlinks. */
const linkTarget = join(dir, WINDOWS ? "vid.exe" : "vid");
const shim = join(dir, "vid.cmd");

async function kind(path: string): Promise<"symlink" | "file" | "missing"> {
  const s = await lstat(path).catch(() => null);
  if (!s) return "missing";
  return s.isSymbolicLink() ? "symlink" : "file";
}

function onPath(): boolean {
  const sep = WINDOWS ? ";" : ":";
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, "");
    return WINDOWS ? trimmed.toLowerCase() : trimmed;
  };
  return (process.env.PATH ?? "")
    .split(sep)
    .filter(Boolean)
    .map(norm)
    .includes(norm(dir));
}

async function link() {
  const binary = builtBinary();
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`${binary} does not exist — run \`bun run build\` first`);
  }
  await mkdir(dir, { recursive: true });

  // Say what is being replaced. A released install is a real file; leaving that
  // in place silently is how you end up debugging a binary you did not build.
  for (const existing of [linkTarget, shim]) {
    switch (await kind(existing)) {
      case "symlink":
        console.log(`  replacing existing symlink -> ${await readlink(existing)}`);
        await unlink(existing);
        break;
      case "file":
        if (existing === shim) {
          await rm(existing, { force: true });
        } else {
          const version = await run(existing, ["--version"]);
          console.log(`  replacing installed release (${version ?? "unknown"})`);
          await rm(existing, { force: true });
        }
        break;
    }
  }

  let created = linkTarget;
  try {
    await symlink(binary, linkTarget, "file");
    if (!WINDOWS) await chmod(binary, 0o755);
  } catch (e) {
    // Windows refuses symlinks to unprivileged users unless Developer Mode is
    // on. A .cmd shim forwarding to the build is the same thing in effect, and
    // needs no privileges. Note that PATHEXT prefers .EXE over .CMD, which is
    // why any vid.exe in this directory was removed above.
    if (!WINDOWS) throw e;
    await writeFile(shim, `@echo off\r\n"${binary}" %*\r\n`);
    created = shim;
    console.log("  no symlink permission (Developer Mode is off); wrote a .cmd shim instead");
  }

  console.log(`  ${created} -> ${binary}`);
  const version = await run(binary, ["--version"]);
  if (version) console.log(`  vid ${version}`);
  if (!onPath()) console.log(`  note: ${dir} is not on PATH`);
  console.log("  rebuild with: mise run build   (the link picks it up)");
}

async function unlinkDev() {
  let removed = false;
  for (const existing of [linkTarget, shim]) {
    const k = await kind(existing);
    if (k === "symlink" || (k === "file" && existing === shim)) {
      await rm(existing, { force: true });
      console.log(`  removed ${existing}`);
      removed = true;
    } else if (k === "file") {
      console.log(`  ${existing} is not a dev link; leaving it alone`);
      return;
    }
  }
  if (!removed) console.log(`  nothing to remove in ${dir}`);
  await reinstallRelease();
}

/** Put the published release back, so `undev` really is the inverse of `dev`. */
async function reinstallRelease() {
  const env = { ...process.env, VID_INSTALL_DIR: dir };
  const cmd = WINDOWS
    ? [Bun.which("pwsh") ?? "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
       "-File", join(repo, "scripts", "install.ps1")]
    : ["/bin/sh", join(repo, "scripts", "install.sh")];

  const p = Bun.spawn(cmd, { env, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error("reinstalling the published release failed");
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

const action = process.argv[2];
try {
  if (action === "link") await link();
  else if (action === "unlink") await unlinkDev();
  else {
    console.error("usage: bun run scripts/dev.ts link|unlink");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
