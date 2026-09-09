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
maintain. Git on Windows only creates real symlinks when `core.symlinks` is on
(Developer Mode, or an elevated clone); otherwise the checkout gets small text
files holding a path. If that happens, copy the real directories over them:

```powershell
Remove-Item -Recurse -Force .agents\skills\*
Copy-Item -Recurse skills\* .agents\skills\
```

This affects Codex only. The Claude Code plugin loads `skills/` directly and is
unaffected either way.

## Install

One binary, no runtime. The installer picks the build for your platform, checks
its sha256, and puts it somewhere you can run it.

**Linux and macOS** — POSIX `sh`, so bash is not required:

```sh
curl -fsSL https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh | sh
```

**Windows** — PowerShell, no bash, no Git for Windows, no WSL:

```powershell
irm https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.ps1 | iex
```

It installs to `%LOCALAPPDATA%\Programs\vid` and adds that to your user `PATH`,
because Windows has no equivalent of `~/.local/bin` that is already on it.

`VID_INSTALL_DIR` changes the destination and `VID_VERSION` pins a tag, in both.
Builds are published for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and
windows-x64; on arm64 Windows the x64 build runs under emulation.

Then three external tools, none of them bundled:

```sh
uv tool install yt-dlp                       # downloading
# uv and ffmpeg must also be on PATH:
#   macOS    brew install uv ffmpeg
#   Linux    your package manager
#   Windows  winget install --id=astral-sh.uv ; winget install Gyan.FFmpeg
```

### From source

Only for changing the code, or a platform with no published build. Needs
[Bun](https://bun.sh) and nothing else:

```sh
bun install
bun run build                     # -> dist/vid, or dist\vid.exe on Windows
bun run scripts/dev.ts link       # puts it on PATH, any platform
```

`scripts/dev.ts link` symlinks the build onto `PATH` so a rebuild takes effect
with no reinstall. On Windows, where symlinks need Developer Mode, it falls back
to a `.cmd` shim that does the same job with no privileges. `mise run dev` wraps
it, and `mise run undev` puts the published release back.

`uv` runs the transcription sidecar. The sidecar is embedded in the binary,
written to the user cache directory on first use, and run with `uv run --script` —
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

```sh
vid config --set-key   # enter a Gemini API key; nothing is echoed
vid config             # shows resolved settings and where each came from
vid config --init      # just the starter file, no key
vid config --path      # where that file is
```

Settings resolve **environment > config file > built-in default**.

### The API key

Only `vid see` needs one. Fetching, transcribing and rendering are entirely
local. Keys come from <https://aistudio.google.com/apikey>.

**No secret manager?** This is the whole setup:

```sh
vid config --set-key
```

It prompts, hides what you type, and writes the key to the config file with
owner-only permissions — so the key never reaches your shell history, your
scrollback, or a command line that other processes can read. Piping works too,
for scripts: `vid config --set-key < keyfile`.

**If you do run a secret manager**, store a *command* instead and no secret
lands on disk at all:

```toml
[gemini]
api_key_command = "op read op://Vault/Item/credential"              # 1Password
# api_key_command = "pass show gemini/api-key"                      # pass
# api_key_command = "security find-generic-password -w -s gemini"   # macOS Keychain
# api_key_command = "powershell -c (Get-Secret gemini -AsPlainText)"  # Windows
```

The command runs through `sh` on POSIX and `cmd.exe` on Windows, and inherits
stdin and stderr, so one that needs to prompt or unlock can do so — a piped
credential helper would otherwise hang with nothing on screen. For 1Password
specifically: a service account needs `OP_SERVICE_ACCOUNT_TOKEN` in the
environment and never prompts; otherwise `op signin` first.

**For CI and one-off runs**, the environment wins over both:

```sh
export GEMINI_API_KEY=...          # PowerShell: $env:GEMINI_API_KEY = "..."
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
src/paths.ts    per-platform config, data and cache directories
asr/            the Python transcription sidecar (source of truth)
scripts/        sidecar embedding, the two installers, dev linking, smoke test
stubs/          resolves Ink's dev-only devtools import to nothing
test/           correction application, config writing, platform behaviour
skills/         agent skills: video-feed, video-feed-setup
.agents/skills/ symlinks to the above, for Codex
.claude-plugin/ plugin and marketplace manifests
AGENTS.md       always-on rules, and @includes of the skills
```

Where files land:

| | POSIX | Windows |
|---|---|---|
| settings | `~/.config/video-feed/` | `%APPDATA%\video-feed\` |
| work dirs | `~/.local/share/video-feed/` | `%LOCALAPPDATA%\video-feed\data\` |
| sidecar cache | `~/.cache/video-feed/` | `%LOCALAPPDATA%\video-feed\cache\` |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` override all six.
