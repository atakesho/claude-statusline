#!/usr/bin/env bash
# Claude Code Statusline
# Lines: session info / 5h usage / 7d usage / 7d per-model usage (e.g. Fable)
# Requires: jq, curl. macOS (Keychain) or Linux (~/.claude/.credentials.json).

set -euo pipefail

input=$(cat)

# ── Colors ──
GREEN="\033[38;2;151;201;195m"
YELLOW="\033[38;2;229;192;123m"
RED="\033[38;2;224;108;117m"
GRAY="\033[38;2;74;88;92m"
RESET="\033[0m"

color_for_pct() {
  local pct=$1
  if (( pct >= 80 )); then
    printf '%s' "$RED"
  elif (( pct >= 50 )); then
    printf '%s' "$YELLOW"
  else
    printf '%s' "$GREEN"
  fi
}

# ── Progress bar (10 segments) ──
progress_bar() {
  local pct=$1
  local filled=$(( pct / 10 ))
  (( filled > 10 )) && filled=10
  local empty=$(( 10 - filled ))
  local color
  color=$(color_for_pct "$pct")
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="▰"; done
  for ((i=0; i<empty; i++)); do bar+="▱"; done
  printf '%b%s%b' "$color" "$bar" "$RESET"
}

# ── Line 1: Session info ──
model=$(echo "$input" | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
lines_added=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
lines_removed=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // ""')

ctx_int=0
if [ -n "$used_pct" ]; then
  printf -v ctx_int "%.0f" "$used_pct" 2>/dev/null || ctx_int="${used_pct%%.*}"
fi
ctx_color=$(color_for_pct "$ctx_int")

git_branch=""
if [ -n "$cwd" ] && git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
fi

sep="${GRAY} | ${RESET}"

line1="🤖 ${model}${sep}${ctx_color}📊 ${ctx_int}%${RESET}${sep}✏️ +${lines_added}/-${lines_removed}"
if [ -n "$git_branch" ]; then
  line1+="${sep}🔀 ${git_branch}"
fi

# ── Usage API (OAuth, cached 360s) ──
CACHE_FILE="${TMPDIR:-/tmp}/claude-usage-cache.json"
CACHE_TTL=360

read_access_token() {
  local raw=""
  if command -v security >/dev/null 2>&1; then
    raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  fi
  if [ -z "$raw" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
    raw=$(cat "$HOME/.claude/.credentials.json")
  fi
  [ -z "$raw" ] && return 1
  echo "$raw" | jq -r '.claudeAiOauth.accessToken // .accessToken // .access_token // empty' 2>/dev/null
}

fetch_usage() {
  local access_token
  access_token=$(read_access_token) || return 1
  [ -z "$access_token" ] && return 1

  local response
  response=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer ${access_token}" \
    -H "anthropic-beta: oauth-2025-04-20" \
    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null) || return 1

  local now
  now=$(date +%s)
  # Cache holds usage numbers only (never the token); still keep it owner-readable.
  ( umask 077; echo "$response" | jq --arg ts "$now" '. + {cached_at: ($ts | tonumber)}' > "$CACHE_FILE" 2>/dev/null )
  echo "$response"
}

get_usage() {
  local now
  now=$(date +%s)
  if [ -f "$CACHE_FILE" ]; then
    local cached_at
    cached_at=$(jq -r '.cached_at // 0' "$CACHE_FILE" 2>/dev/null || echo "0")
    local age=$(( now - cached_at ))
    if (( age < CACHE_TTL )); then
      jq -r 'del(.cached_at)' "$CACHE_FILE" 2>/dev/null
      return 0
    fi
  fi
  fetch_usage
}

# ISO 8601 (UTC) -> epoch. macOS (date -j) and GNU date (date -d).
iso_to_epoch() {
  local stripped="${1%%.*}"
  stripped="${stripped%%+*}"
  TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$stripped" +%s 2>/dev/null \
    || TZ=UTC date -d "$stripped" +%s 2>/dev/null \
    || echo ""
}

epoch_to_local() {
  local epoch=$1 fmt=$2
  LC_ALL=en_US.UTF-8 date -r "$epoch" +"$fmt" 2>/dev/null \
    || LC_ALL=en_US.UTF-8 date -d "@$epoch" +"$fmt" 2>/dev/null
}

TZ_LABEL=$(date +%Z)

# "Resets 5pm (JST)"
format_5h_reset() {
  local epoch
  epoch=$(iso_to_epoch "$1")
  [ -z "$epoch" ] && return
  epoch_to_local "$epoch" "Resets %-l%p (${TZ_LABEL})" | sed 's/AM/am/;s/PM/pm/'
}

# "Resets Mar 6 at 12pm (JST)"
format_7d_reset() {
  local epoch
  epoch=$(iso_to_epoch "$1")
  [ -z "$epoch" ] && return
  epoch_to_local "$epoch" "Resets %b %-d at %-l%p (${TZ_LABEL})" | sed 's/AM/am/;s/PM/pm/'
}

# usage_line ICON LABEL PCT RESET_STR
usage_line() {
  local icon=$1 label=$2 pct=$3 reset_str=$4
  local pct_int color bar line
  printf -v pct_int "%.0f" "$pct" 2>/dev/null || pct_int="${pct%%.*}"
  color=$(color_for_pct "$pct_int")
  bar=$(progress_bar "$pct_int")
  line="${color}${icon} ${label}${RESET}  ${bar}  ${color}${pct_int}%${RESET}"
  if [ -n "$reset_str" ]; then
    line+="  ${GRAY}${reset_str}${RESET}"
  fi
  printf '%b' "$line"
}

extra_lines=()

usage_json=$(get_usage 2>/dev/null || true)

if [ -n "$usage_json" ]; then
  five_util=$(echo "$usage_json" | jq -r '.five_hour.utilization // empty' 2>/dev/null)
  five_reset=$(echo "$usage_json" | jq -r '.five_hour.resets_at // empty' 2>/dev/null)
  seven_util=$(echo "$usage_json" | jq -r '.seven_day.utilization // empty' 2>/dev/null)
  seven_reset=$(echo "$usage_json" | jq -r '.seven_day.resets_at // empty' 2>/dev/null)

  if [ -n "$five_util" ]; then
    reset_str=""
    [ -n "$five_reset" ] && reset_str=$(format_5h_reset "$five_reset")
    extra_lines+=("$(usage_line "⏱" "5h" "$five_util" "$reset_str")")
  fi

  if [ -n "$seven_util" ]; then
    reset_str=""
    [ -n "$seven_reset" ] && reset_str=$(format_7d_reset "$seven_reset")
    extra_lines+=("$(usage_line "📅" "7d" "$seven_util" "$reset_str")")
  fi

  # Per-model weekly limits (e.g. Fable). One line per scoped limit.
  while IFS=$'\t' read -r name pct reset_at; do
    [ -z "$name" ] && continue
    reset_str=""
    [ -n "$reset_at" ] && reset_str=$(format_7d_reset "$reset_at")
    extra_lines+=("$(usage_line "🧠" "7d ${name}" "$pct" "$reset_str")")
  done < <(echo "$usage_json" | jq -r '
    (.limits // [])[]
    | select(.kind == "weekly_scoped" and .scope.model.display_name != null)
    | [.scope.model.display_name, (.percent // 0), (.resets_at // "")]
    | @tsv' 2>/dev/null)
fi

# ── Output ──
printf '%b' "$line1"
for l in "${extra_lines[@]+"${extra_lines[@]}"}"; do
  printf '\n%b' "$l"
done
