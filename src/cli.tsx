#!/usr/bin/env bun
/**
 * vid — context-aware video transcripts.
 *
 * Each stage writes one JSON artifact into a work dir and skips itself if that
 * artifact already exists, so a failure costs one step rather than the run.
 */
import { chmod, mkdir } from "node:fs/promises";
import { basename } from "node:path";

import { Command } from "commander";

// Bundled into the binary at compile time, so `vid --version` and package.json
// cannot disagree.
import { version } from "../package.json";

import { DEFAULT_HOTWORDS, transcribe } from "./asr";
import { captionTracks, fetchVideo, probe } from "./fetch";
import { getClient, listModels } from "./gemini";
import {
  STARTER,
  configDir,
  configIsExposed,
  configPath,
  loadConfig,
  resolveApiKey,
  writeApiKey,
} from "./config";
import { readSecret } from "./secret";
import { render as renderDoc } from "./render";
import { runPipeline, type Stage } from "./ui";
import {
  CORRECTIONS,
  SCREEN,
  SOURCE,
  TRANSCRIPT,
  type Confidence,
  type Source,
} from "./types";
import { watch } from "./vision";
import { WorkDir, defaultRoot } from "./workdir";

const program = new Command();

program
  .name("vid")
  .description("Verbatim video transcripts, corrected against what is on screen.")
  .version(version);

function die(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nerror: ${msg}\n`);
  process.exit(1);
}

interface Ctx {
  url?: string;
  wd?: WorkDir;
}

program
  .command("captions <url>")
  .description("What captions already exist? Human-written ones beat any ASR.")
  .action(async (url: string) => {
    try {
      const meta = await probe(url);
      const caps = captionTracks(meta);
      console.log(`${meta.title}  [${meta.id}]`);
      console.log(`  human-written : ${caps.manual.join(", ") || "(none)"}`);
      const auto = caps.auto.slice(0, 12).join(", ");
      console.log(`  auto-generated: ${auto || "(none)"}${caps.auto.length > 12 ? " …" : ""}`);
      if (caps.manual.length) {
        console.log("\nThis video has real captions — likely better than any ASR:");
        console.log(`  yt-dlp --write-subs --sub-langs en --skip-download ${url}`);
      }
    } catch (e) {
      die(e);
    }
  });

program
  .command("models")
  .description("List Gemini models this API key can see.")
  .action(async () => {
    try {
      for (const m of await listModels(await getClient())) console.log(m);
    } catch (e) {
      die(e);
    }
  });

program
  .command("ls")
  .description("Show work dirs and which stages are done.")
  .action(async () => {
    const dirs = await WorkDir.list();
    if (!dirs.length) {
      console.log(`no work dirs yet (${defaultRoot()})`);
      return;
    }
    for (const wd of dirs) {
      const flags = await Promise.all(
        ([["F", SOURCE], ["W", TRANSCRIPT], ["S", SCREEN], ["C", CORRECTIONS]] as const).map(
          async ([c, f]) => ((await wd.has(f)) ? c : "·"),
        ),
      );
      console.log(`  [${flags.join("")}]  ${basename(wd.path)}`);
    }
    console.log("\n  F=fetched  W=words  S=screen  C=corrections");
  });

program
  .command("fetch <url>")
  .description("Download audio, video and any existing captions.")
  .option("--no-video", "Audio only; skips the visual pass.")
  .option("--lang <code>", "Caption language to pull.", "en")
  .option("-f, --force", "Redo even if already fetched.")
  .action(async (url: string, o: any) => {
    try {
      const ctx = await runPipeline<Ctx>(
        [{ name: "fetch", run: async function* (c) { c.wd = yield* fetchVideo(url, { wantVideo: o.video, lang: o.lang, force: o.force }); } }],
        {},
      );
      console.log(ctx.wd!.path);
    } catch (e) {
      die(e);
    }
  });

program
  .command("words <workdir>")
  .description("Transcribe speech, verbatim, with timestamps.")
  .option("-e, --engine <name>", "whisper (local GPU) or gemini", "whisper")
  .option("-m, --model <name>", "Override the model.")
  .option("-d, --device <name>", "cuda or cpu (whisper only).", "cuda")
  .option("-l, --language <code>", "Force a language; default auto-detect.")
  .option("--hotwords <list>", "Terms to bias the decoder toward.", DEFAULT_HOTWORDS)
  .option("-f, --force", "Re-transcribe.")
  .action(async (workdir: string, o: any) => {
    try {
      const wd = await WorkDir.open(workdir);
      await runPipeline<Ctx>(
        [{ name: "transcribe", run: async function* () { yield* transcribe(wd, o); } }],
        { wd },
      );
      console.log(wd.file(TRANSCRIPT));
    } catch (e) {
      die(e);
    }
  });

program
  .command("see <workdir>")
  .description("Watch the video: propose corrections, describe the screen.")
  .option("-m, --model <name>", "Override the model.")
  .option("-c, --chunk <seconds>", "Seconds per request; 0 sends the whole video.", "600")
  .option("--fps <n>", "Frames sampled per second. Raise for screencasts.", "1")
  .option("--low-res", "Cheaper, but fine on-screen text may be lost.")
  .option("-f, --force", "Redo the pass.")
  .action(async (workdir: string, o: any) => {
    try {
      const wd = await WorkDir.open(workdir);
      if (!(await wd.has(TRANSCRIPT))) throw new Error("no transcript yet — run `vid words` first");
      await runPipeline<Ctx>(
        [{
          name: "watch",
          run: async function* () {
            yield* watch(wd, {
              model: o.model,
              chunkS: Number(o.chunk),
              fps: Number(o.fps),
              hiRes: !o.lowRes,
              force: o.force,
            });
          },
        }],
        { wd },
      );
    } catch (e) {
      die(e);
    }
  });

program
  .command("render <workdir>")
  .description("Merge everything into a document.")
  .option("-F, --format <fmt>", "md, txt or srt", "md")
  .option("-o, --out <file>", "Write to a file instead of stdout.")
  .option("--min-confidence <level>", "high, medium or low", "medium")
  .option("--no-screen", "Omit on-screen observations.")
  .option("--no-fixes", "Omit the corrections table.")
  .action(async (workdir: string, o: any) => {
    try {
      const wd = await WorkDir.open(workdir);
      if (!(await wd.has(TRANSCRIPT))) throw new Error("no transcript yet — run `vid words` first");
      const text = await renderDoc(wd, {
        format: o.format,
        minConfidence: o.minConfidence as Confidence,
        includeScreen: o.screen,
        showFixes: o.fixes,
      });
      if (o.out) {
        await Bun.write(o.out, text);
        process.stderr.write(`wrote ${o.out}\n`);
      } else {
        process.stdout.write(text);
      }
    } catch (e) {
      die(e);
    }
  });

program
  .command("run <url>")
  .description("fetch → words → see → render")
  .option("-e, --engine <name>", "whisper or gemini", "whisper")
  .option("--fps <n>", "Frames sampled per second.", "1")
  .option("-c, --chunk <seconds>", "Seconds per vision request.", "600")
  .option("--skip-see", "Transcript only; no visual pass.")
  .option("-o, --out <file>", "Write the document to a file.")
  .action(async (url: string, o: any) => {
    const stages: Stage<Ctx>[] = [
      { name: "fetch", run: async function* (c) { c.wd = yield* fetchVideo(url, { wantVideo: !o.skipSee }); } },
      { name: "transcribe", run: async function* (c) { yield* transcribe(c.wd!, { engine: o.engine }); } },
    ];
    if (!o.skipSee) {
      stages.push({
        name: "watch",
        run: async function* (c) {
          yield* watch(c.wd!, { chunkS: Number(o.chunk), fps: Number(o.fps) });
        },
      });
    }
    try {
      const ctx = await runPipeline<Ctx>(stages, {});
      const text = await renderDoc(ctx.wd!);
      if (o.out) {
        await Bun.write(o.out, text);
        process.stderr.write(`wrote ${o.out}\n`);
      } else {
        process.stdout.write(text);
      }
    } catch (e) {
      die(e);
    }
  });

program
  .command("config")
  .description("Show resolved settings and where each came from.")
  .option("--init", "Write a starter config file.")
  .option("--path", "Print the config file path and exit.")
  .option("--set-key", "Enter a Gemini API key and store it. Input is not echoed.")
  .action(async (o: any) => {
    try {
      if (o.path) {
        console.log(configPath());
        return;
      }

      if (o.init) {
        if (await Bun.file(configPath()).exists()) {
          throw new Error(`${configPath()} already exists — edit it, or delete it first`);
        }
        await mkdir(configDir(), { recursive: true });
        await Bun.write(configPath(), STARTER);
        // Windows has no mode bits to set -- chmod there only toggles the
        // read-only flag, which is not what 0o600 means and would be a lie to
        // report. The profile directory is already ACL'd to this user.
        if (process.platform !== "win32") await chmod(configPath(), 0o600);
        console.log(`wrote ${configPath()}`);
        return;
      }

      if (o.setKey) {
        const key = (await readSecret("Gemini API key (not shown): ")).trim();
        if (!key) throw new Error("no key entered — nothing written");
        // A warning, not a refusal: Google has changed key formats before, and
        // rejecting a valid key would be worse than accepting a wrong-looking
        // one that fails loudly on first use.
        if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) {
          process.stderr.write("warning: that does not look like a Gemini API key\n");
        }

        const { path, created } = await writeApiKey(key);
        console.log(`${created ? "wrote" : "updated"} ${path}`);
        console.log(
          process.platform === "win32"
            ? "  readable by your Windows account only"
            : "  mode 600",
        );

        // Say so when something else will win, rather than leaving the user to
        // wonder why the key they just set is not the one being used.
        const { config: after } = await loadConfig();
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
          console.log("  note: GEMINI_API_KEY in the environment takes precedence over this");
        } else if (after.gemini.apiKeyCommand) {
          console.log("  note: api_key_command in that file takes precedence over this");
        }
        return;
      }

      const { config } = await loadConfig();
      const exists = await Bun.file(configPath()).exists();
      console.log(`config file : ${configPath()}${exists ? "" : "  (not present — using defaults)"}`);

      // The key itself is never printed; only where it was found.
      let keyLine: string;
      // How to set one, kept whole. Squeezing it onto the summary line used to
      // cut it at the first newline, which left a new user reading "...then:"
      // with the actual instructions missing.
      let keyHelp = "";
      try {
        const r = await resolveApiKey();
        const shown = { env: `environment (${r.detail})`, command: `command: ${r.detail}`,
                        config: `config file (${r.detail})`, default: "default", unset: "unset" }[r.origin];
        keyLine = `set — from ${shown}`;
        if (r.origin === "config" && (await configIsExposed())) {
          keyLine += "  [readable by others: chmod 600]";
        }
      } catch (e) {
        keyLine = "NOT SET";
        keyHelp = e instanceof Error ? e.message : String(e);
      }

      console.log(`gemini key  : ${keyLine}`);
      console.log(`video model : ${config.gemini.videoModel}`);
      console.log(`transcribe  : ${config.gemini.transcribeModel}`);
      console.log(`whisper     : ${config.whisper.model} on ${config.whisper.device}`);
      console.log(`vision      : fps ${config.vision.fps}, chunk ${config.vision.chunkS}s, ` +
                  `${config.vision.highRes ? "high" : "low"} res`);
      if (keyHelp) console.log(`\n${keyHelp}`);
      else if (!exists) console.log(`\nWrite a starter config with:  vid config --init`);
    } catch (e) {
      die(e);
    }
  });

program
  .command("show <workdir> [artifact]")
  .description("Dump one artifact as JSON (source, transcript, screen, corrections).")
  .action(async (workdir: string, artifact = "source") => {
    try {
      const wd = await WorkDir.open(workdir);
      const name = ({ source: SOURCE, transcript: TRANSCRIPT, screen: SCREEN, corrections: CORRECTIONS } as Record<string, string>)[artifact];
      if (!name) throw new Error(`unknown artifact '${artifact}'`);
      if (!(await wd.has(name))) throw new Error(`${artifact} not produced yet`);
      console.log(JSON.stringify(await wd.read(name), null, 2));
    } catch (e) {
      die(e);
    }
  });

program.parseAsync(process.argv);
