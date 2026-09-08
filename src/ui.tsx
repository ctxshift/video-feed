/**
 * Progress display.
 *
 * Ink when stdout is a TTY, plain stderr lines otherwise. The plain path is not
 * a fallback -- it is what an agent, a pipe, or a cron job should get, and
 * escape codes in a captured log are worse than useless.
 */
import { Box, render, Text } from "ink";
import Spinner from "ink-spinner";
import React, { useEffect, useState } from "react";

import type { Event } from "./types";

export interface Stage<C> {
  name: string;
  run: (ctx: C) => AsyncGenerator<Event, unknown>;
}

type Status = "pending" | "active" | "done" | "failed" | "skipped";

interface StageState {
  name: string;
  status: Status;
  detail: string;
  progress?: { done: number; total: number };
  warnings: string[];
}

const BAR_WIDTH = 24;

function Bar({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  return (
    <Text color="cyan">
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(BAR_WIDTH - filled)}</Text>
      <Text> {Math.round(ratio * 100)}%</Text>
    </Text>
  );
}

const MARK: Record<Status, string> = {
  pending: "·",
  active: "",
  done: "✔",
  failed: "✖",
  skipped: "–",
};

const COLOR: Record<Status, string> = {
  pending: "gray",
  active: "cyan",
  done: "green",
  failed: "red",
  skipped: "gray",
};

function Pipeline({ subscribe }: { subscribe: (cb: (s: StageState[]) => void) => void }) {
  const [stages, setStages] = useState<StageState[]>([]);
  useEffect(() => subscribe(setStages), [subscribe]);

  return (
    <Box flexDirection="column">
      {stages.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Box>
            <Text color={COLOR[s.status]}>
              {s.status === "active" ? <Spinner type="dots" /> : MARK[s.status]}
            </Text>
            <Text> {s.name}</Text>
            {s.detail ? <Text dimColor> — {s.detail}</Text> : null}
          </Box>
          {s.status === "active" && s.progress ? (
            <Box marginLeft={2}>
              <Bar done={s.progress.done} total={s.progress.total} />
            </Box>
          ) : null}
          {s.warnings.map((w, i) => (
            <Box key={i} marginLeft={2}>
              <Text color="yellow">! {w}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/**
 * Run stages in order, showing progress. Returns the mutated context so the
 * caller can pick results out of it.
 */
export async function runPipeline<C>(stages: Stage<C>[], ctx: C, opts: { tty?: boolean } = {}): Promise<C> {
  const useInk = opts.tty ?? Boolean(process.stdout.isTTY);

  const state: StageState[] = stages.map((s) => ({
    name: s.name,
    status: "pending",
    detail: "",
    warnings: [],
  }));

  let notify: (s: StageState[]) => void = () => {};
  const push = () => notify(state.map((s) => ({ ...s })));

  let inkApp: ReturnType<typeof render> | undefined;
  if (useInk) {
    inkApp = render(
      <Pipeline
        subscribe={(cb) => {
          notify = cb;
          push();
        }}
      />,
    );
  }

  const line = (msg: string) => {
    if (!useInk) process.stderr.write(msg + "\n");
  };

  try {
    for (const [i, stage] of stages.entries()) {
      const st = state[i]!;
      st.status = "active";
      push();
      line(`▶ ${stage.name}`);

      try {
        const gen = stage.run(ctx);
        for (;;) {
          const step = await gen.next();
          if (step.done) break;
          const ev = step.value;
          if (ev.type === "status") {
            st.detail = ev.message;
            line(`  ${ev.message}`);
          } else if (ev.type === "progress") {
            st.progress = { done: ev.done, total: ev.total };
            if (ev.label) st.detail = ev.label;
          } else if (ev.type === "warn") {
            st.warnings.push(ev.message);
            line(`  ! ${ev.message}`);
          } else if (ev.type === "done") {
            st.detail = ev.message;
          }
          push();
        }
        st.status = "done";
        st.progress = undefined;
        push();
        line(`✔ ${stage.name}${st.detail ? ` — ${st.detail}` : ""}`);
      } catch (err) {
        st.status = "failed";
        st.detail = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        push();
        throw err;
      }
    }
  } finally {
    inkApp?.unmount();
    await inkApp?.waitUntilExit().catch(() => {});
  }

  return ctx;
}
