/**
 * Does the built binary actually run on this machine?
 *
 * `--version` and `--help` must work with no API key, no GPU and none of the
 * three external tools -- that is the difference between "installed" and
 * "installed and broken". Written in TypeScript rather than as two shell lines
 * because CI runs it on Windows too.
 */
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const binary = join(repo, "dist", process.platform === "win32" ? "vid.exe" : "vid");

if (!(await Bun.file(binary).exists())) {
  console.error(`error: ${binary} does not exist — run \`bun run build\` first`);
  process.exit(1);
}

async function capture(args: string[]): Promise<string> {
  const p = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) {
    console.error(`error: \`vid ${args.join(" ")}\` exited ${code}\n${err}`);
    process.exit(1);
  }
  return out.trim();
}

const expected = (await Bun.file(join(repo, "package.json")).json()).version;
const version = await capture(["--version"]);
if (version !== expected) {
  console.error(`error: --version said ${version}, package.json says ${expected}`);
  process.exit(1);
}

const help = await capture(["--help"]);
for (const command of ["fetch", "words", "see", "render", "config"]) {
  if (!help.includes(command)) {
    console.error(`error: \`${command}\` is missing from --help`);
    process.exit(1);
  }
}

console.log(`vid ${version} runs on ${process.platform}-${process.arch}`);
