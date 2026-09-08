#!/usr/bin/env bash
# Install the `vid` binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.sh | bash
#
# Environment:
#   VID_VERSION      tag to install, e.g. v0.1.0   (default: latest)
#   VID_INSTALL_DIR  where to put it               (default: ~/.local/bin)
set -euo pipefail

REPO="ctxshift/video-feed"
VERSION="${VID_VERSION:-latest}"
INSTALL_DIR="${VID_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

# --- which build? -----------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)  os_tag=linux ;;
  Darwin) os_tag=darwin ;;
  MINGW*|MSYS*|CYGWIN*) os_tag=windows ;;
  *) die "unsupported OS: $os. Build from source: https://github.com/$REPO" ;;
esac

case "$arch" in
  x86_64|amd64)  arch_tag=x64 ;;
  arm64|aarch64) arch_tag=arm64 ;;
  *) die "unsupported architecture: $arch. Build from source: https://github.com/$REPO" ;;
esac

asset="vid-${os_tag}-${arch_tag}"
[ "$os_tag" = windows ] && asset="${asset}.exe"

# Only x64 is built for Windows, and only x64/arm64 for the rest.
if [ "$os_tag" = windows ] && [ "$arch_tag" != x64 ]; then
  die "no Windows build for $arch"
fi

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

# --- fetch ------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "need curl or wget"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset ($VERSION)"
fetch "$base/$asset" "$tmp/$asset" || die "no build published for $os_tag-$arch_tag at $VERSION"

# --- verify -----------------------------------------------------------------
# A truncated download is otherwise a binary that installs fine and then dies
# on first run, which is a much worse failure than refusing to install.
if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    sum="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
  else
    sum=""
    info "no sha256 tool; skipping checksum"
  fi

  if [ -n "$sum" ]; then
    want="$(awk -v a="$asset" '$2 == a || $2 == "*"a { print $1 }' "$tmp/SHA256SUMS")"
    [ -n "$want" ] || die "$asset is not listed in SHA256SUMS"
    [ "$sum" = "$want" ] || die "checksum mismatch for $asset (got $sum, want $want)"
    info "checksum ok"
  fi
else
  info "no SHA256SUMS published; skipping checksum"
fi

# --- install ----------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/vid"
[ "$os_tag" = windows ] && target="$INSTALL_DIR/vid.exe"

# Replace by rename so a running `vid` is not corrupted mid-write.
mv "$tmp/$asset" "$target.new"
chmod +x "$target.new"
mv "$target.new" "$target"

info "installed $target"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\n  %s is not on your PATH. Add:\n    export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac

"$target" --version >/dev/null 2>&1 \
  && printf '\n  vid %s\n  Next: vid config --init\n' "$("$target" --version)" \
  || die "installed binary does not run"
