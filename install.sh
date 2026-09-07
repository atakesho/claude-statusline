#!/usr/bin/env bash
# Installs the Claude Code statusline (usage bars incl. per-model weekly limits).
# Usage: bash install.sh   (run from the directory containing statusline-command.sh)
set -euo pipefail
for dep in jq curl; do
  command -v "$dep" >/dev/null || { echo "missing: $dep (brew install $dep)"; exit 1; }
done
src="$(cd "$(dirname "$0")" && pwd)/statusline-command.sh"
mkdir -p ~/.claude
cp "$src" ~/.claude/statusline-command.sh
chmod +x ~/.claude/statusline-command.sh
settings=~/.claude/settings.json
[ -f "$settings" ] || echo '{}' > "$settings"
tmp=$(mktemp)
jq '.statusLine = {"type":"command","command":"bash ~/.claude/statusline-command.sh"}' "$settings" > "$tmp" && mv "$tmp" "$settings"
echo "installed. Restart Claude Code (or start a new session) to see it."
