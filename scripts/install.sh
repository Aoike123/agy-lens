#!/usr/bin/env bash
set -euo pipefail

REPO="Aoike123/agy-lens"
PLUGIN_NAME="agy-lens"
PLUGINS_ROOT="${HOME}/.gemini/config/plugins"
TARGET_DIR="${PLUGINS_ROOT}/${PLUGIN_NAME}"
LEGACY_PULSE_DIR="${PLUGINS_ROOT}/antigravity-pulse"
LEGACY_DESKTOP_DIR="${PLUGINS_ROOT}/desktop-context"

VERSION=""
DRY_RUN=0
SHOW_HELP=0

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n)
      DRY_RUN=1
      ;;
    --help|-h)
      SHOW_HELP=1
      ;;
    -*)
      echo "Error: unknown option '$arg'" >&2
      echo "Usage: $0 [--dry-run] [version]" >&2
      exit 2
      ;;
    *)
      if [ -z "$VERSION" ]; then
        VERSION="$arg"
      else
        echo "Error: unexpected argument '$arg'" >&2
        echo "Usage: $0 [--dry-run] [version]" >&2
        exit 2
      fi
      ;;
  esac
done

if [ "$SHOW_HELP" -eq 1 ]; then
  cat <<EOF
Agy Lens (${PLUGIN_NAME}) Installer

Usage:
  $0 [--dry-run] [version]

Options:
  --dry-run, -n   Print planned download URL and target paths without modifying files
  --help, -h      Show this help message and exit

Arguments:
  version         Optional release tag or SemVer (e.g. 2.2.0 or v2.2.0). Defaults to latest.
EOF
  exit 0
fi

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v${VERSION}" ;;
  esac
  URL="https://github.com/${REPO}/releases/download/${TAG}/${PLUGIN_NAME}-${TAG}.zip"
else
  URL="https://github.com/${REPO}/releases/latest/download/${PLUGIN_NAME}.zip"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] Agy Lens installer"
  echo "[dry-run] Repository:   ${REPO}"
  echo "[dry-run] Download URL: ${URL}"
  echo "[dry-run] Target dir:   ${TARGET_DIR}"
  if [ -e "$LEGACY_PULSE_DIR" ] && [ "$LEGACY_PULSE_DIR" != "$TARGET_DIR" ]; then
    echo "[dry-run] Would remove legacy install: ${LEGACY_PULSE_DIR}"
  fi
  if [ -e "$LEGACY_DESKTOP_DIR" ]; then
    echo "[dry-run] Note: Legacy folder exists at ${LEGACY_DESKTOP_DIR}"
  fi
  exit 0
fi

for cmd in curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required. Please install $cmd and re-run. (缺少命令: $cmd)" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ZIP_PATH="${TMP_DIR}/${PLUGIN_NAME}.zip"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR" "$PLUGINS_ROOT"

echo "Downloading Agy Lens (${URL})..."
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

if [ -e "$LEGACY_PULSE_DIR" ] && [ "$LEGACY_PULSE_DIR" != "$TARGET_DIR" ]; then
  rm -rf "$LEGACY_PULSE_DIR"
  echo "Removed legacy plugin folder: ${LEGACY_PULSE_DIR}"
fi

echo ""
echo "Agy Lens installed to: ${TARGET_DIR}"
echo ""
echo "Next steps / 接下来只需 3 步:"
echo "  1. Restart Antigravity 2.0 / 重启 Antigravity"
echo "  2. Open Customizations -> Installed, and enable 'Agy Lens' / 在设置 Customizations -> Installed 中启用 Agy Lens"
echo "  3. Open any conversation and open 'Agy Lens' in the right-side pane / 打开任意对话，在右侧边栏打开 Agy Lens"

if [ -e "$LEGACY_DESKTOP_DIR" ]; then
  echo ""
  echo "Note: Legacy folder found at ${LEGACY_DESKTOP_DIR}. Remove or disable it to avoid duplicate panels."
fi
