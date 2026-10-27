#!/usr/bin/env bash
# User-local install of hydration.sys (no sudo): binary, launcher, icons.
#
#   scripts/install-linux.sh            build if needed, then install
#   scripts/install-linux.sh --build    force a fresh release build first
#   scripts/install-linux.sh --uninstall [--purge]
#                                       remove app, launcher, icons and the
#                                       login autostart entry; --purge also
#                                       deletes your drink history
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS="$DATA_HOME/applications"
ICONS="$DATA_HOME/icons/hicolor"
APP_ID="io.github.malekabokhatwa.hydrationsys"
EXE="$BIN_DIR/hydration-sys"

uninstall() {
  pkill -x hydration-sys 2>/dev/null || true
  rm -f "$EXE" "$APPS/hydration-sys.desktop"
  for s in 32 64 128 256 512; do rm -f "$ICONS/${s}x${s}/apps/hydration-sys.png"; done
  # Autostart entry written by the in-app "launch on sign-in" switch.
  rm -f "$CONFIG_HOME/autostart/hydration.sys.desktop" "$CONFIG_HOME/autostart/hydration-sys.desktop"
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
  echo "removed hydration.sys app, launcher, icons and autostart entry."
  if [[ "${1:-}" == "--purge" ]]; then
    rm -rf "$DATA_HOME/$APP_ID" "$CONFIG_HOME/$APP_ID"
    echo "deleted data in $DATA_HOME/$APP_ID"
  else
    echo "your data is kept in $DATA_HOME/$APP_ID (use --purge to delete it)."
  fi
  if grep -qs hydration-sys "$CONFIG_HOME/hypr/autostart.lua" "$CONFIG_HOME/hypr/hyprland.conf" 2>/dev/null; then
    echo "note: a manual Hyprland startup line mentioning hydration-sys is still in your hypr config; remove it by hand."
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall "${2:-}"
  exit 0
fi

BUILT="$HERE/src-tauri/target/release/hydration-sys"
if [[ "${1:-}" == "--build" || ! -x "$BUILT" ]]; then
  (cd "$HERE" && npm ci --no-audit --no-fund && npx tauri build --no-bundle)
fi

# Replace a running copy cleanly so the new binary is what runs next.
was_running=0
if pgrep -x hydration-sys >/dev/null; then was_running=1; pkill -x hydration-sys; sleep 0.5; fi

install -Dm755 "$BUILT" "$EXE"
for s in 32 64 128 256 512; do
  src="$HERE/src-tauri/icons/${s}x${s}.png"
  [[ $s == 256 ]] && src="$HERE/src-tauri/icons/128x128@2x.png"
  [[ $s == 512 ]] && src="$HERE/src-tauri/icons/icon.png"
  install -Dm644 "$src" "$ICONS/${s}x${s}/apps/hydration-sys.png"
done
mkdir -p "$APPS"
cat >"$APPS/hydration-sys.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=hydration.sys
GenericName=Water reminder
Comment=A tiny terminal pixel pet that reminds you to drink water
Exec=$EXE
Icon=hydration-sys
Terminal=false
Categories=Utility;
Keywords=water;hydration;reminder;pet;drink;
StartupWMClass=hydration-sys
StartupNotify=true
EOF
command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" 2>/dev/null || true

echo "installed $EXE and the hydration.sys launcher."
if [[ $was_running == 1 ]]; then
  setsid -f "$EXE" --autostarted >/dev/null 2>&1 || true
  echo "restarted the running copy quietly."
fi
