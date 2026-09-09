# video-feed

`vid` produces accurate video transcripts: verbatim speech from local Whisper,
then a vision pass that corrects technical terms against what is visible on
screen. See [README.md](README.md) for the design.

## Using the tool

@./skills/video-feed/SKILL.md
@./skills/video-feed-setup/SKILL.md

## Working on this repo

**The Python sidecar is embedded at build time.** `asr/whisper.py` is the
source of truth; `bun run build` inlines it into `src/asr-embedded.ts` (which is
gitignored) and then into the binary. Editing the sidecar without rebuilding
changes nothing — the binary still carries the old copy.

**`bun test` covers correction application**, which is the part with real logic.
Run it after touching `src/render.ts`. Corrections regularly span segment
boundaries, because speech recognition splits on pauses rather than meaning; the
tests cover one-, two- and three-segment spans for that reason.

**Never widen what the vision pass returns.** It is asked for *edits with
evidence*, never a rewritten transcript, and any edit whose quoted text is
absent from the transcript is discarded as invention. A model handed a whole
transcript rewrites more than it reports, silently. Keeping the pass to
auditable edits is the design, not a limitation to fix.

**Model IDs are configuration, not constants.** They change faster than this
code. Defaults are `-latest` aliases; `vid models` lists what a key can see.

**Windows is a supported platform, not an afterthought.** Nothing here may
require bash: the POSIX installer is `sh`, Windows has its own PowerShell one,
and anything with real logic goes in a `scripts/*.ts` that Bun runs everywhere.
Paths come from `src/paths.ts` rather than a hardcoded `~/.config`, user
commands go through `shellCommand()` rather than `sh -c`, and tool lookup uses
`Bun.which` rather than `command -v`. CI runs the suite on Linux, macOS and
Windows, and the release workflow starts each binary on its own OS before
publishing — a cross-compiled build nobody has run is not a tested build.

**Assume no secret manager.** `vid config --set-key` is the path most users
take; `api_key_command` is for the minority who run `op`, `pass` or similar.
Error messages and docs lead with the former, and only mention 1Password when
the failing command is actually `op`.

**Verify by looking at output, not at summaries.** A stage reporting
"18 corrections" looked like success while four of them silently failed to
apply. Read the rendered document.

## Secrets

The only credential is a Gemini API key, and only `vid see` needs it. Never
write a user's key into a file on their behalf, never echo one, and never add
one to this repo. `vid config` reports where a key came from without printing
it.
