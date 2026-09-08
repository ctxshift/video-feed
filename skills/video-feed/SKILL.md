---
name: video-feed
description: Transcribe a video accurately with the `vid` CLI - verbatim speech from local Whisper, corrected against on-screen text by a Gemini vision pass. Use when asked to transcribe, summarize, quote, or answer questions about a YouTube or other video URL, or when someone shares a video and wants its content as text. If `vid` is missing or unconfigured, use the video-feed-setup skill instead.
---

# video-feed

`vid` turns a video into a timestamped document: verbatim speech, what was on
screen, and a table of corrections with the evidence for each.

The point of the tool is the correction pass. Speech recognition mangles
technical terms — "the vent" for `venv`, "deep seat" for `deepspeed`, "cu 1.1"
for `cu121` — and the screen usually shows the right spelling. Nothing that
reads only the audio can fix those.

## Check for existing captions first

```bash
vid captions <url>
```

If it reports human-written captions, say so before spending GPU time or API
credit. They are usually better than anything generated, and free.

## Normal flow

```bash
vid fetch  <url>              # prints the work dir path — capture it
vid words  <dir>              # local GPU, free, no length limit
vid see    <dir>              # vision pass. COSTS MONEY.
vid render <dir> -F md -o transcript.md
```

`vid run <url> -o out.md` does all four. Each stage skips itself if its
artifact already exists, so re-running is cheap and safe; `--force` redoes one.

Roughly a quarter of the video's runtime end to end (a 9-minute video takes
about 2 minutes on an RTX 3090).

## Reading output without flooding context

**Do not `cat` a full transcript.** A 40-minute video is thousands of lines.

- `vid show <dir> corrections` — just the fixes, usually the interesting part
- `vid show <dir> screen` — just the on-screen observations
- `vid render <dir> -F txt | head -50` — a sample
- `vid render <dir> -o file.md`, then grep or read specific line ranges

Answering a question about a video usually means grepping the rendered text,
not reading the whole document.

## Cost and tuning

`vid see` uploads video to Gemini and is the only step that costs money.

| Flag | Effect |
|---|---|
| `--fps 1` | default; fine for a talking head. Raise to 2-4 for a screencast |
| `--chunk 600` | seconds per request; lower it if a request fails |
| `--low-res` | cheaper, but loses fine on-screen text — usually the whole point |
| `--skip-see` | transcript only: entirely local and free |

Ask before running `vid see` on anything long unless the user already asked for
the visual pass.

## What the corrections mean

The vision pass never rewrites the transcript. It returns edits, each with the
text it replaces and the evidence:

```json
{"t": "04:12", "was": "cube cuttle", "now": "kubectl",
 "evidence": "command visible in terminal", "confidence": "high"}
```

`vid render` applies those at or above `--min-confidence` (default `medium`)
and lists the rest, so nothing is silently dropped.

A correction being *present* does not make it *right*. Check its evidence field
before repeating a fix as fact.

## When something fails

Use the **video-feed-setup** skill. Do not try to diagnose install or auth
problems from here.
