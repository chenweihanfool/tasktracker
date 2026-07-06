#!/usr/bin/env bash
# Downloads the official Vikunja "full" binary (API + frontend bundled together)
# from go-vikunja/vikunja releases. Idempotent: skips download if already installed.
set -euo pipefail

VIKUNJA_VERSION="${VIKUNJA_VERSION:-2.3.0}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin"
BIN_PATH="$INSTALL_DIR/vikunja"

if [ -x "$BIN_PATH" ]; then
  INSTALLED_VERSION="$("$BIN_PATH" version 2>/dev/null | head -n1 || echo unknown)"
  echo "[install-vikunja] Found existing binary ($INSTALLED_VERSION), skipping download."
  echo "[install-vikunja] Delete $BIN_PATH and re-run to force a re-download."
  exit 0
fi

case "$(uname -m)" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  armv7l)  ARCH="arm-7" ;;
  *) echo "[install-vikunja] ERROR: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

ASSET="vikunja-v${VIKUNJA_VERSION}-linux-${ARCH}-full.zip"
URL="https://github.com/go-vikunja/vikunja/releases/download/v${VIKUNJA_VERSION}/${ASSET}"

mkdir -p "$INSTALL_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[install-vikunja] Downloading $URL"
if ! curl -fL --retry 3 -o "$TMP_DIR/$ASSET" "$URL"; then
  echo "[install-vikunja] ERROR: download failed for $URL" >&2
  echo "[install-vikunja] Check that VIKUNJA_VERSION=${VIKUNJA_VERSION} exists at https://github.com/go-vikunja/vikunja/releases" >&2
  exit 1
fi

unzip -q "$TMP_DIR/$ASSET" -d "$TMP_DIR/extracted"

# The archive contains a single executable (name varies by release); find it
# rather than hardcoding, since it is not always named exactly "vikunja".
FOUND_BIN="$(find "$TMP_DIR/extracted" -maxdepth 2 -type f -perm -u+x | head -n1)"
if [ -z "$FOUND_BIN" ]; then
  FOUND_BIN="$(find "$TMP_DIR/extracted" -maxdepth 2 -type f -iname 'vikunja*' | head -n1)"
fi
if [ -z "$FOUND_BIN" ]; then
  echo "[install-vikunja] ERROR: could not locate the vikunja executable inside $ASSET" >&2
  find "$TMP_DIR/extracted" -maxdepth 2 >&2
  exit 1
fi

cp "$FOUND_BIN" "$BIN_PATH"
chmod +x "$BIN_PATH"
echo "[install-vikunja] Installed to $BIN_PATH"
"$BIN_PATH" version || true
