/** Subprocess helpers. Everything external goes through here. */

export class ToolMissing extends Error {
  constructor(public tool: string, hint: string) {
    super(`${tool} not found on PATH. ${hint}`);
  }
}

const HINTS: Record<string, string> = {
  "yt-dlp": "Install with: uv tool install yt-dlp",
  uv: "Install from https://docs.astral.sh/uv/ — needed to run the transcription sidecar.",
  ffmpeg: "Install with your package manager, e.g. apt install ffmpeg",
};

export async function requireTool(tool: string): Promise<void> {
  const which = Bun.spawn(["sh", "-c", `command -v ${tool}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await which.exited) !== 0) {
    throw new ToolMissing(tool, HINTS[tool] ?? "");
  }
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
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      try {
        yield JSON.parse(line);
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
