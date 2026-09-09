/** Subprocess helpers. Everything external goes through here. */

export class ToolMissing extends Error {
  constructor(public tool: string, hint: string) {
    super(`${tool} not found on PATH. ${hint}`);
  }
}

/** Install advice worth printing is platform-specific; a Windows user told to
 *  `apt install ffmpeg` learns nothing. */
export function hintFor(tool: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  switch (tool) {
    case "yt-dlp":
      return "Install with: uv tool install yt-dlp";
    case "uv":
      return win
        ? "Install with: winget install --id=astral-sh.uv — needed to run the transcription sidecar."
        : "Install from https://docs.astral.sh/uv/ — needed to run the transcription sidecar.";
    case "ffmpeg":
      if (win) return "Install with: winget install Gyan.FFmpeg";
      if (platform === "darwin") return "Install with: brew install ffmpeg";
      return "Install with your package manager, e.g. apt install ffmpeg";
    default:
      return "";
  }
}

/**
 * Locate an external tool, or say how to install it.
 *
 * Returns the absolute path, and callers spawn *that* rather than the bare
 * name. Bun.which walks PATH in-process and honours PATHEXT, so `uv` resolves
 * to `uv.exe` on Windows -- where spawning a bare name is the ambiguous case,
 * and where the old `sh -c "command -v"` had no shell to run in at all.
 */
export async function requireTool(tool: string): Promise<string> {
  const found = Bun.which(tool);
  if (!found) throw new ToolMissing(tool, hintFor(tool));
  return found;
}

/**
 * Wrap a user-supplied command string for the platform's shell.
 *
 * This exists for `api_key_command`, which is by definition a shell one-liner:
 * pipes, quoting and `$(...)` are the point of it. `cmd.exe` rather than
 * PowerShell on Windows because it is what `%ComSpec%` names, it is always
 * present, and `/d /s /c` is the quoting shape every other tool uses to run one
 * command string. PowerShell users can still say `powershell -c "..."`.
 */
export function shellCommand(
  cmd: string,
  o: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {},
): string[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  return platform === "win32"
    ? [env.ComSpec || "cmd.exe", "/d", "/s", "/c", cmd]
    : ["/bin/sh", "-c", cmd];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[]): Promise<RunResult> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Run a command, streaming its stderr as newline-delimited JSON events while
 * collecting stdout. This is the contract the ASR sidecar speaks: progress on
 * stderr, the single JSON result on stdout.
 */
export async function* runStreaming(
  cmd: string[],
): AsyncGenerator<unknown, RunResult> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

  const stdoutPromise = new Response(p.stdout).text();
  const decoder = new TextDecoder();
  let buf = "";
  const stderrLines: string[] = [];

  const reader = (p.stderr as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Windows Python writes CRLF; a trailing \r would break JSON.parse on every
    // event and silently drop the whole progress stream.
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.trim()) continue;
      stderrLines.push(trimmed);
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Not an event -- library noise (CUDA warnings and the like). Kept for
        // the error message if the process ends up failing.
      }
    }
  }

  const [stdout, code] = await Promise.all([stdoutPromise, p.exited]);
  return { code, stdout, stderr: stderrLines.join("\n") };
}

/**
 * Run a command that prints a secret, capturing only stdout.
 *
 * stdin and stderr are inherited so an interactive credential helper can
 * actually prompt -- `op` without a service-account token, a passphrase for
 * `pass`, a biometric check. Piping those would hang the CLI with no visible
 * reason. Only stdout is captured, so the secret never reaches the terminal.
 */
export async function runForSecret(cmd: string[]): Promise<{ code: number; stdout: string }> {
  const p = Bun.spawn(cmd, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, stdout };
}
