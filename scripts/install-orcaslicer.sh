#!/usr/bin/env bash
# Install OrcaSlicer 2.4.2 (stable) for headless A1 mini slicing.
# The GitHub release has no separate .sha256 file. The checksum below is the
# release asset digest (sha256) published by GitHub for
# OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage.
# Do not run this as root. Linux x86_64 only.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This installer only fetches the Ubuntu 24.04 x86_64 AppImage." >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]]; then
  echo "Refusing to install OrcaSlicer as root." >&2
  exit 1
fi

URL="https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage"
SHA="d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd"
NAME="OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage"
DEST="${HOME}/.local/share/bambu-harness"
mkdir -p "$DEST"
FILE="$DEST/$NAME"

if [[ ! -f "$FILE" ]]; then
  echo "downloading $URL"
  curl -fL --retry 3 -o "$FILE.partial" "$URL"
  mv "$FILE.partial" "$FILE"
fi
echo "$SHA  $FILE" | sha256sum -c -
chmod 0755 "$FILE"

if [[ ! -x "$DEST/squashfs-root/AppRun" ]]; then
  rm -rf "$DEST/squashfs-root"
  (cd "$DEST" && "$FILE" --appimage-extract)
fi
test -x "$DEST/squashfs-root/AppRun"
echo "ready $DEST/squashfs-root/AppRun"
echo "headless packages used on this image: libopengl0 libglu1-mesa libegl1 libwebkit2gtk-4.1-0 xvfb"
echo "run with APPIMAGE_EXTRACT_AND_RUN=1 and QT_QPA_PLATFORM=offscreen (the bambu slice command sets both)"
