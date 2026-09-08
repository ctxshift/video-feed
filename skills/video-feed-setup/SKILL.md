---
name: video-feed-setup
description: Install, build, authenticate or troubleshoot the `vid` video transcription CLI. Use when `vid` is not found, when `vid config` reports no API key, when a transcription or vision pass fails, or when setting video-feed up on a new machine. For normal transcription use the video-feed skill instead.
---

# video-feed setup

`vid` is one compiled binary that shells out to three external tools. Almost
every failure is a missing one of those, and each has a distinct symptom.

## Diagnose first

```bash
vid config      # resolved settings, and where the API key came from
```

It never prints the key itself — only its source. Run this before changing
anything; it answers most questions in one call.

## Requirements

| Tool | Needed for | Install |
|---|---|---|
| `uv` | runs the transcription sidecar | https://docs.astral.sh/uv/ |
| `yt-dlp` | downloading | `uv tool install yt-dlp` |
| `ffmpeg` | audio handling | system package manager |
| NVIDIA GPU | `vid words` | optional — `--device cpu` works, much slower |

`vid` reports a missing tool by name with its install command, so trust the
error rather than guessing.

## Install

One binary, no runtime. The script picks the right build for the platform,
verifies its checksum, and drops it in `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh | bash
```

`VID_INSTALL_DIR` changes where it lands, `VID_VERSION` pins a tag:

```bash
VID_INSTALL_DIR=/usr/local/bin VID_VERSION=v0.1.0 bash -c "$(curl -fsSL \
  https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh)"
```

If the script says the directory is not on PATH, that is the whole problem --
add it and re-run `vid config`.

Builds exist for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and
windows-x64. On anything else, build from source.

## Build from source

Only needed to change the code, or for a platform with no published build.
Requires [Bun](https://bun.sh); nothing else.

```bash
git clone https://github.com/ctxshift/video-feed && cd video-feed
bun install
bun run build        # -> dist/vid
ln -sfn "$PWD/dist/vid" ~/.local/bin/vid
```

Symlink rather than copy, so a rebuild takes effect without reinstalling.

The build embeds the Python sidecar into the binary, so `bun run build` must be
re-run after editing `asr/whisper.py` -- editing that file alone changes
nothing.

## The API key

`vid see` needs a Gemini key. Nothing else does — fetching, transcribing and
rendering are entirely local.

Resolution order: **`$GEMINI_API_KEY` > config file > nothing**.

```bash
vid config --init     # writes ~/.config/video-feed/config.toml, mode 600
```

Then set **one** of these in that file:

```toml
[gemini]
# Preferred: a command that prints the key. No secret stored on disk, and any
# secret manager works (op, pass, gopass, security, vault).
api_key_command = "op read 'op://Vault/Item/credential'"

# Or the key itself. `vid config` warns if the file is readable by others.
api_key = "..."
```

**Never put a user's API key into a file yourself, and never echo one.** Tell
the user where it goes and let them enter it. If they ask you to store it, have
them pipe it in without it entering the conversation:

```bash
read -rs -p "key: " K && op item edit "Item" --vault=V credential="$K"; unset K
```

Keys come from https://aistudio.google.com/apikey.

## Failure modes

**`api_key_command failed`** — the command ran and did not print a key. With
1Password: a service account needs `OP_SERVICE_ACCOUNT_TOKEN` in the
environment; otherwise `op signin` first. The command inherits stdin and
stderr, so an interactive prompt works and its output is visible.

**First `vid words` looks hung** — the first run resolves faster-whisper and
its CUDA wheels (a few GB), then downloads the model. Say so rather than
letting it look stuck. Later runs start in seconds.

**A model name is rejected** — model IDs change. `vid models` lists what the
key can actually see; set `video_model` / `transcribe_model` in the config.
Defaults are `-latest` aliases for this reason.

**`vid see` fails on a long video** — lower `--chunk`. Each chunk is one
request.

**Transcription is slow** — check it is on the GPU. `[whisper] device` in the
config, `cuda` by default; `cpu` is many times slower.

## Where things live

| Path | What |
|---|---|
| `~/.config/video-feed/config.toml` | settings (mode 600) |
| `~/.local/share/video-feed/<video>/` | per-video work dirs and artifacts |
| `~/.cache/video-feed/` | the extracted Python sidecar |

Work dirs hold the downloaded video and audio and are large. `vid ls` shows
them and which stages are done.
