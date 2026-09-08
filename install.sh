#!/usr/bin/env bash
# Installs the Claude Code statusline (usage bars incl. per-model weekly limits).
#
#   bash install.sh              pick the best variant for this machine
#   bash install.sh --shell      force the bash variant (needs jq + curl)
#   bash install.sh --node       force the Node variant
#   bash install.sh --uninstall  remove it again
#   bash install.sh --dry-run    show what would change, write nothing
#   bash install.sh --node-path  pin the absolute node path in settings.json
#   bash install.sh --force      with --uninstall, remove another tool's statusLine too
#
# On Windows use install.ps1 instead.
set -uo pipefail

mode="auto"
passthru=()
for arg in "$@"; do
  case "$arg" in
    --shell) mode="shell" ;;
    --node) mode="node" ;;
    --uninstall|--dry-run|--node-path|--force) passthru+=("$arg") ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

repo_dir="$(cd "$(dirname "$0")" && pwd)"
config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$mode" = "auto" ]; then
  if have node; then mode="node"
  elif have jq && have curl; then mode="shell"
  else
    echo "need either node (preferred) or jq + curl." >&2
    echo "  macOS: brew install node   # or: brew install jq curl" >&2
    exit 1
  fi
fi

if [ "$mode" = "node" ]; then
  have node || { echo "missing: node" >&2; exit 1; }
  exec node "$repo_dir/install.js" "${passthru[@]+"${passthru[@]}"}"
fi

# ── bash variant ──
for dep in jq curl; do
  have "$dep" || { echo "missing: $dep (brew install $dep)" >&2; exit 1; }
done

settings="$config_dir/settings.json"
target="$config_dir/statusline-command.sh"
dry_run=""
uninstall=""
for arg in "${passthru[@]+"${passthru[@]}"}"; do
  [ "$arg" = "--dry-run" ] && dry_run="1"
  [ "$arg" = "--uninstall" ] && uninstall="1"
done

mkdir -p "$config_dir"
[ -f "$settings" ] || echo '{}' > "$settings"
jq empty "$settings" 2>/dev/null || { echo "$settings is not valid JSON. Fix it first, nothing was changed." >&2; exit 1; }

if [ -n "$uninstall" ]; then
  echo "settings: $settings"
  echo "removing the statusLine entry and $target"
  [ -n "$dry_run" ] && { echo "dry run: nothing written."; exit 0; }
  cp "$settings" "$settings.bak-$(date +%Y%m%dT%H%M%S)"
  tmp=$(mktemp "$config_dir/settings.json.XXXXXX") && jq 'del(.statusLine)' "$settings" > "$tmp" && mv "$tmp" "$settings"
  rm -f "$target" "$config_dir/statusline-usage-cache.json"
  echo "uninstalled. Restart Claude Code to drop the status line."
  exit 0
fi

command="bash \"$target\""
echo "script:   $repo_dir/statusline-command.sh"
echo "       -> $target"
echo "settings: $settings"
echo "new statusLine command: $command"
[ -n "$dry_run" ] && { echo "dry run: nothing written."; exit 0; }

cp "$repo_dir/statusline-command.sh" "$target"
chmod +x "$target"
cp "$settings" "$settings.bak-$(date +%Y%m%dT%H%M%S)"
tmp=$(mktemp "$config_dir/settings.json.XXXXXX") && jq --arg cmd "$command" '.statusLine = {"type":"command","command":$cmd}' "$settings" > "$tmp" && mv "$tmp" "$settings"
echo "installed. Restart Claude Code (or start a new session) to see it."
