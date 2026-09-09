/**
 * Reading a secret from the person at the keyboard.
 *
 * Not every user runs a secret manager, and telling someone without one to
 * paste a key into a config file by hand is how keys end up in shell history,
 * in a screenshot, or in a repo. So `vid config --set-key` asks for it
 * directly: no echo, no argv, no history.
 *
 * A pipe is accepted too, which is what a script or an agent should use --
 * `vid config --set-key < keyfile` never puts the key on a command line.
 */

const CTRL_C = "\u0003";
const DELETE = "\u007f";
const BACKSPACE = "\b";

/** Read one secret. Hidden while typing on a TTY; the whole of stdin if piped. */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return (await new Response(Bun.stdin.stream()).text()).trim();
  }

  // Raw mode is what suppresses the echo; without it the key is on screen and
  // in the scrollback of whatever the user pastes into next.
  if (typeof stdin.setRawMode !== "function") {
    throw new Error(
      "this terminal cannot hide typed input.\n" +
        "Pipe the key in instead:  vid config --set-key < keyfile",
    );
  }

  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let buf = "";

    const finish = (settle: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      settle();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(buf));
        if (ch === CTRL_C) return finish(() => reject(new Error("cancelled")));
        // Backspace arrives as DEL on POSIX terminals, \b in the Windows console.
        if (ch === DELETE || ch === BACKSPACE) {
          buf = buf.slice(0, -1);
          continue;
        }
        // Drop the rest of the control range: arrow keys and the like arrive as
        // escape sequences and would otherwise land in the middle of the key.
        if (ch < " ") continue;
        buf += ch;
      }
    };

    stdin.on("data", onData);
  });
}
