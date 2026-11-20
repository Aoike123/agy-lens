#!/usr/bin/env bash
set -euo pipefail

REPO="Aoike123/antigravity-pulse"
PLUGIN_NAME="antigravity-pulse"
PLUGINS_ROOT="${HOME}/.gemini/config/plugins"
TARGET_DIR="${PLUGINS_ROOT}/${PLUGIN_NAME}"
VERSION="${1:-}"

for cmd in curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required. Please install $cmd and re-run. (缺少命令: $cmd)" >&2
    exit 1
  fi
done

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v${VERSION}" ;;
  esac
  URL="https://github.com/${REPO}/releases/download/${TAG}/${PLUGIN_NAME}-${TAG}.zip"
else
  URL="https://github.com/${REPO}/releases/latest/download/${PLUGIN_NAME}.zip"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ZIP_PATH="${TMP_DIR}/${PLUGIN_NAME}.zip"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR" "$PLUGINS_ROOT"

echo "Downloading Pulse (${URL})..."
curl -fsSL "$URL" -o "$ZIP_PATH"

echo "Extracting package..."
unzip -q "$ZIP_PATH" -d "$EXTRACT_DIR"

SRC_DIR="${EXTRACT_DIR}/${PLUGIN_NAME}"
if [ ! -f "${SRC_DIR}/plugin.json" ]; then
  echo "Error: invalid package (missing ${PLUGIN_NAME}/plugin.json)" >&2
  exit 1
fi

BACKUP_DIR="${TARGET_DIR}.bak.$$"
HAD_OLD=0
if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
  HAD_OLD=1
fi
if mv "$SRC_DIR" "$TARGET_DIR"; then
  if [ "$HAD_OLD" -eq 1 ]; then
    rm -rf "$BACKUP_DIR"
  fi
else
  if [ "$HAD_OLD" -eq 1 ] && [ ! -e "$TARGET_DIR" ] && [ -e "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$TARGET_DIR" || true
  fi
  exit 1
fi

echo ""
echo "Pulse installed to: ${TARGET_DIR}"
echo ""
echo "Next steps / 接下来只需 3 步:"
echo "  1. Restart Antigravity 2.0 / 重启 Antigravity"
echo "  2. Open Customizations -> Installed, and enable 'Pulse' / 在设置 Customizations -> Installed 中启用 Pulse"
echo "  3. Open any conversation and open 'Pulse' in the right-side pane / 打开任意对话，在右侧边栏打开 Pulse"

if [ -e "${PLUGINS_ROOT}/desktop-context" ]; then
  echo ""
  echo "Note: Legacy folder found at ${PLUGINS_ROOT}/desktop-context. Remove or disable it to avoid duplicate panels."
fi
