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

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | API key. Falls back to 1Password. |
| `VIDEO_FEED_OP_REF` | 1Password ref, default `op://Homelab/Gemini - video-feed/credential` |
| `VIDEO_FEED_VIDEO_MODEL` | Vision model override |
| `VIDEO_FEED_TRANSCRIBE_MODEL` | Gemini transcription model override |
| `XDG_DATA_HOME` | Where work dirs live |

Model IDs move faster than this code will, so both are overridable and
`vid models` lists what your key can actually see.

## Layout

```
src/          TypeScript: cli, stages, Ink UI
asr/          the Python transcription sidecar (source of truth)
scripts/      embeds the sidecar into the binary at build time
stubs/        resolves Ink's dev-only devtools import to nothing
```
