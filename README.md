# video-feed

Verbatim video transcripts, corrected against what is on screen.

Speech recognition gets the words. A vision pass then watches the video and
proposes fixes — because **on-screen text is the ground truth for technical
vocabulary**. A terminal showing `kubectl get pods` is what tells you the
transcript's "cube cuttle get pods" is wrong, and exactly how.

```
yt-dlp ──> faster-whisper ──> Gemini (sees the screen) ──> merged document
 audio        verbatim            corrections + notes       transcript + screen
```

## Install as a plugin

Agents discover setup, auth and usage from the bundled skills.

**Claude Code**

```bash
/plugin marketplace add ctxshift/video-feed
/plugin install video-feed@video-feed
```

**Codex** reads `.agents/skills/`, so a clone is enough — either in the repo, or
copied to `~/.codex/agents/` to make it global:

```bash
cp -r .agents/skills/* ~/.codex/agents/
```

Both get two skills: `video-feed` for normal use, and `video-feed-setup` for
installing, authenticating and troubleshooting. They are split so the setup
instructions only load when something is actually wrong.

`.agents/skills/` entries are symlinks into `skills/`, so there is one copy to
maintain. A Windows checkout without symlink support gets text files holding a
path instead — copy the directories there.

## Install


One binary, three external tools:

```bash
bun run build            # -> dist/vid
uv tool install yt-dlp   # required
# ffmpeg and uv must also be on PATH
```

`uv` runs the transcription sidecar. The sidecar is embedded in the binary,
written to `~/.cache/video-feed` on first use, and run with `uv run --script` —
so faster-whisper and its CUDA wheels are resolved and cached automatically.
There is no virtualenv to manage and no Python package to install.

## Use

```bash
vid captions <url>          # do human-written captions already exist?
vid run <url> -o out.md     # the whole pipeline

# or a stage at a time
vid fetch <url>             # -> work dir path
vid words  <dir>            # faster-whisper on the GPU
vid see    <dir>            # Gemini watches; corrections + screen notes
vid render <dir> -F md      # merge

vid ls                      # work dirs and which stages are done
vid show <dir> corrections  # any artifact, as JSON
```

Each stage writes one JSON artifact and skips itself if that artifact exists.
These stages are slow or cost money, so a failure costs one step, not the run.
`--force` redoes one.

## Design

**Check for real captions first.** `vid fetch` says so when a video has
human-written ones. They beat any ASR and cost nothing.

**The model never returns the transcript.** The vision pass gets the transcript
as context and returns *edits* — each with a timestamp, the exact text it
replaces, and the evidence for it:

```json
{"t": "04:12", "was": "cube cuttle", "now": "kubectl",
 "evidence": "command visible in terminal", "confidence": "high"}
```

A model handed a transcript rewrites more than it reports, quietly. Edits are
auditable, applied mechanically, and rejectable one at a time. Any edit whose
`was` is not in the transcript is discarded before it reaches `render` — that is
the model inventing text.

**Confidence is a floor, not a filter.** `--min-confidence` decides what gets
applied; everything else still appears in the document's corrections table, so
nothing is silently dropped.

**Sampling is tunable.** `--fps` (1 is plenty for a talking head, more for a
screencast) and `--chunk` control cost. `--low-res` is cheaper but loses fine
on-screen text, which is usually the point of the pass.

## Configuration

```bash
vid config --init   # writes ~/.config/video-feed/config.toml, mode 600
vid config          # shows resolved settings and where each came from
```

Settings resolve **environment > config file > built-in default**.

### The API key

Preferred — store a *command*, not the secret:

```toml
[gemini]
api_key_command = "op read op://Homelab/Gemini - video-feed/credential"
```

Nothing sensitive lands on disk, and any secret manager works: `op`, `pass`,
`gopass`, `security` on macOS, `vault`. The command inherits stdin and stderr, so
one that needs to prompt or unlock can do so — a piped credential helper would
otherwise hang with nothing on screen.

For 1Password specifically: a service account needs `OP_SERVICE_ACCOUNT_TOKEN`
in the environment and never prompts; otherwise `op signin` first.

Two alternatives:

```toml
[gemini]
api_key = "..."     # plain; `vid config` warns if the file is readable by others
```

```bash
export GEMINI_API_KEY=...   # highest precedence — CI, one-off runs
```

`vid config` reports which source supplied the key. It never prints the key.

### Other settings

| | |
|---|---|
| `[gemini] video_model`, `transcribe_model` | model IDs — `vid models` lists real ones |
| `[whisper] model`, `device`, `hotwords` | local ASR |
| `[vision] fps`, `chunk_s`, `high_res` | cost/detail trade-offs |
| `[paths] data_dir` | where work dirs live |

Model IDs change faster than this code will, which is why they are configuration
rather than constants.

## Layout

```
src/            TypeScript: cli, config, stages, Ink UI
asr/            the Python transcription sidecar (source of truth)
scripts/        embeds the sidecar into the binary at build time
stubs/          resolves Ink's dev-only devtools import to nothing
test/           correction-application tests (bun test)
skills/         agent skills: video-feed, video-feed-setup
.agents/skills/ symlinks to the above, for Codex
.claude-plugin/ plugin and marketplace manifests
AGENTS.md       always-on rules, and @includes of the skills
```
