#!/usr/bin/env bash
# Downloads yt-dlp, ffmpeg and ffprobe for a target platform into src-tauri/tools/.
# They are bundled as app resources (a private folder), so they never clash with
# system packages. Override the platform with TARGET_TRIPLE=<rust target triple>.
#
# Works on Linux, macOS and Windows (Git Bash). Requires: curl, unzip, tar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/tools"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rm -rf "$OUT" && mkdir -p "$OUT"

TRIPLE="${TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
echo "→ Target: $TRIPLE"

YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
BTBN="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
dl() { echo "  ↓ $1"; curl -fL --retry 3 --retry-delay 3 -o "$2" "$1"; }

case "$TRIPLE" in
  *windows*)
    dl "$YTDLP_BASE/yt-dlp.exe" "$OUT/yt-dlp.exe"
    dl "$BTBN/ffmpeg-master-latest-win64-gpl.zip" "$TMP/ff.zip"
    unzip -q "$TMP/ff.zip" -d "$TMP/ff"
    cp "$TMP"/ff/*/bin/ffmpeg.exe  "$OUT/ffmpeg.exe"
    cp "$TMP"/ff/*/bin/ffprobe.exe "$OUT/ffprobe.exe"
    ;;
  x86_64-unknown-linux-gnu)
    dl "$YTDLP_BASE/yt-dlp_linux" "$OUT/yt-dlp"
    dl "$BTBN/ffmpeg-master-latest-linux64-gpl.tar.xz" "$TMP/ff.tar.xz"
    mkdir -p "$TMP/ff" && tar -xJf "$TMP/ff.tar.xz" -C "$TMP/ff"
    cp "$TMP"/ff/*/bin/ffmpeg  "$OUT/ffmpeg"
    cp "$TMP"/ff/*/bin/ffprobe "$OUT/ffprobe"
    ;;
  aarch64-unknown-linux-gnu)
    dl "$YTDLP_BASE/yt-dlp_linux_aarch64" "$OUT/yt-dlp"
    dl "$BTBN/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" "$TMP/ff.tar.xz"
    mkdir -p "$TMP/ff" && tar -xJf "$TMP/ff.tar.xz" -C "$TMP/ff"
    cp "$TMP"/ff/*/bin/ffmpeg  "$OUT/ffmpeg"
    cp "$TMP"/ff/*/bin/ffprobe "$OUT/ffprobe"
    ;;
  *apple-darwin)
    dl "$YTDLP_BASE/yt-dlp_macos" "$OUT/yt-dlp"
    ARCH="arm64"; [[ "$TRIPLE" == x86_64* ]] && ARCH="amd64"
    for tool in ffmpeg ffprobe; do
      if dl "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$ARCH/release/$tool.zip" "$TMP/$tool.zip"; then :;
      else
        echo "  ! martin-riedl.de failed, falling back to evermeet.cx (x86_64, runs via Rosetta)"
        dl "https://evermeet.cx/ffmpeg/getrelease/$tool/zip" "$TMP/$tool.zip"
      fi
      unzip -q -o "$TMP/$tool.zip" -d "$TMP/$tool"
      cp "$(find "$TMP/$tool" -type f -name "$tool" | head -1)" "$OUT/$tool"
    done
    ;;
  *)
    echo "Unsupported target: $TRIPLE" >&2; exit 1 ;;
esac

chmod +x "$OUT"/* 2>/dev/null || true
echo "✓ Tools ready in $OUT:"
ls -lh "$OUT"
