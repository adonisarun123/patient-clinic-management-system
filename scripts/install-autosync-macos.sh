#!/usr/bin/env bash
# Installs a macOS LaunchAgent that runs scripts/git-sync.sh every N minutes (default 5) for this folder.
#   bash scripts/install-autosync-macos.sh            # pull + push committed work every 5 min
#   AUTO_COMMIT=1 bash scripts/install-autosync-macos.sh   # also auto-commit local edits
#   bash scripts/install-autosync-macos.sh --uninstall
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.monkmantra.clinic-core.gitsync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/clinic-core-gitsync.log"
INTERVAL=$(( ${SYNC_MINUTES:-5} * 60 ))

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "Auto-sync removed."; exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/git-sync.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>AUTO_COMMIT</key><string>${AUTO_COMMIT:-0}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Auto-sync installed: every $((INTERVAL/60)) min for $REPO (AUTO_COMMIT=${AUTO_COMMIT:-0}). Log: $LOG"
