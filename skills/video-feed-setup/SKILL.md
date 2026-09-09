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
| `ffmpeg` | audio handling | see below |
| NVIDIA GPU | `vid words` | optional — `--device cpu` works, much slower |

`vid` reports a missing tool by name with the install command for the platform
it is running on, so trust the error rather than guessing. On Windows that is
`winget install --id=astral-sh.uv` and `winget install Gyan.FFmpeg`; on macOS,
`brew install uv ffmpeg`.

## Install

One binary, no runtime. The installer picks the right build for the platform and
verifies its checksum.

**If you are an agent, use the two-step form.** Piping a downloaded script
straight into an interpreter — `curl … | sh`, `irm … | iex` — is a blocked
pattern and you will be refused. It is the piping that is blocked, not the
shell, so download the file, read it, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh -o install.sh
sh install.sh
```

```powershell
irm https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.ps1 -OutFile install.ps1
./install.ps1
```

The one-liners below are for a human at a keyboard.

**Linux and macOS** — POSIX `sh`; bash is not required:

```bash
curl -fsSL https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh | sh
```

**Windows** — PowerShell. Do not reach for WSL or Git Bash here; neither is
needed:

```powershell
irm https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.ps1 | iex
```

The Windows installer lands in `%LOCALAPPDATA%\Programs\vid` and adds it to the
user `PATH` itself, so a **new terminal** is usually all that is missing if
`vid` is still not found afterwards.

`VID_INSTALL_DIR` changes where it lands and `VID_VERSION` pins a tag, in both:

```bash
VID_INSTALL_DIR=/usr/local/bin VID_VERSION=v0.2.0 sh -c "$(curl -fsSL \
  https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh)"
```

```powershell
$env:VID_INSTALL_DIR = 'C:\tools\vid'; $env:VID_VERSION = 'v0.2.0'
irm https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.ps1 | iex
```

If an installer says the directory is not on PATH, that is the whole problem --
add it and re-run `vid config`.

Builds exist for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and
windows-x64. Windows on arm64 runs the x64 build under emulation. On anything
else, build from source.

## Build from source

Only needed to change the code, or for a platform with no published build.
Requires [Bun](https://bun.sh); nothing else.

```bash
git clone https://github.com/ctxshift/video-feed && cd video-feed
bun install
bun run build                  # -> dist/vid, or dist\vid.exe on Windows
bun run scripts/dev.ts link    # put it on PATH; works on every platform
```

That links rather than copies, so a rebuild takes effect without reinstalling.
On Windows, where symlinks need Developer Mode, it writes a `.cmd` shim instead
-- same effect, no privileges. `bun run scripts/dev.ts unlink` reverses it and
reinstalls the published release.

The build embeds the Python sidecar into the binary, so `bun run build` must be
re-run after editing `asr/whisper.py` -- editing that file alone changes
nothing.

## The API key

`vid see` needs a Gemini key. Nothing else does — fetching, transcribing and
rendering are entirely local. Keys come from https://aistudio.google.com/apikey.

Resolution order: **`$GEMINI_API_KEY` > `api_key_command` > `api_key` > nothing**.

### Most users: no secret manager

Have the user run this themselves. It prompts, does not echo, and writes the key
to the config file with owner-only permissions:

```bash
vid config --set-key
```

This is the default answer. Do **not** assume 1Password or any other manager is
installed — most machines have none, and Windows machines almost never have `op`.

### If they do run a secret manager

Store a command that prints the key, so no secret is on disk:

```toml
[gemini]
api_key_command = "op read 'op://Vault/Item/credential'"              # 1Password
# api_key_command = "pass show gemini/api-key"                        # pass
# api_key_command = "security find-generic-password -w -s gemini"     # macOS Keychain
# api_key_command = "powershell -c (Get-Secret gemini -AsPlainText)"  # Windows
```

The command runs through `sh` on POSIX and `cmd.exe` on Windows.

### CI and one-off runs

`GEMINI_API_KEY` in the environment beats everything above.

### Your rules for handling the key

**Never put a user's API key into a file yourself, never echo one, and never run
`vid config --set-key` on their behalf with the key in the command.** Tell them
to run it and type the key at the prompt — that is what the prompt is for. If
something must be scripted, pipe from a file so the key never lands in argv or
shell history:

```bash
vid config --set-key < keyfile
```

## Failure modes

**`api_key_command failed`** — the command ran and did not print a key. The
command inherits stdin and stderr, so an interactive prompt works and its output
is visible. With 1Password specifically: a service account needs
`OP_SERVICE_ACCOUNT_TOKEN` in the environment; otherwise `op signin` first. If
the user does not actually run a secret manager, the fix is `vid config
--set-key` instead — not debugging the command.

**`vid` not found on Windows right after installing** — the installer adds its
directory to the user `PATH`, which existing terminals do not pick up. A human
opens a new terminal. You cannot, so refresh the current session from the
registry instead — this is what a new shell would have read:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

Each tool call may also be a fresh process that never saw the update, so prefer
the full path — `$env:LOCALAPPDATA\Programs\vid\vid.exe` — if a bare `vid`
keeps coming back not found.

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

The same three directories on every platform, Windows included — `~` is the
user profile there, so `C:\Users\<name>\.config\video-feed\config.toml`:

| Path | What |
|---|---|
| `~/.config/video-feed/config.toml` | settings (mode 600 on POSIX) |
| `~/.local/share/video-feed/<video>/` | per-video work dirs and artifacts |
| `~/.cache/video-feed/` | the extracted Python sidecar |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` override these. There is
no per-platform variant and nothing to migrate. `vid config --path` prints the
settings path; do not guess it.

Work dirs hold the downloaded video and audio and are large. `vid ls` shows
them and which stages are done.
