#!/usr/bin/env bash
# Claude Code statusline - Node-free fallback for macOS / Linux.
#
# Lines: session info / 5h usage / 7d usage / 7d per-model usage (e.g. Fable).
# Requires: jq, curl, bash 4+ (arrays). On Windows use statusline-command.js instead.
#
# Output is kept identical to statusline-command.js. When you change one,
# change the other (see README.md#parity).

set -uo pipefail

input=$(cat)

# ── Options (all optional) ──
CACHE_TTL=${CLAUDE_STATUSLINE_CACHE_TTL:-360}
STALE_MAX=${CLAUDE_STATUSLINE_STALE_MAX:-3600}
NET_TIMEOUT=${CLAUDE_STATUSLINE_TIMEOUT_SEC:-5}
SKIP_USAGE=${CLAUDE_STATUSLINE_NO_USAGE:-}
ASCII_ONLY=${CLAUDE_STATUSLINE_ASCII:-}
CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}

# ── Colors ──
if [ -n "${NO_COLOR:-}" ]; then
  GREEN=""; YELLOW=""; RED=""; GRAY=""; RESET=""
else
  GREEN="\033[38;2;151;201;195m"
  YELLOW="\033[38;2;229;192;123m"
  RED="\033[38;2;224;108;117m"
  GRAY="\033[38;2;74;88;92m"
  RESET="\033[0m"
fi

if [ -n "$ASCII_ONLY" ]; then
  BAR_FULL="#"; BAR_EMPTY="-"
  I_MODEL=""; I_CTX="ctx"; I_EDIT=""; I_BRANCH="git"
  I_5H=""; I_7D=""; I_SCOPED=""; I_HOT="!"; I_WARN="!"
else
  BAR_FULL="▰"; BAR_EMPTY="▱"
  I_MODEL="🤖"; I_CTX="📊"; I_EDIT="✏️"; I_BRANCH="🔀"
  I_5H="⏱️"; I_7D="📅"; I_SCOPED="🧠"; I_HOT="🔥"; I_WARN="⚠️"
fi

# with_icon ICON TEXT -> "ICON TEXT" (or just TEXT when the icon is empty)
with_icon() {
  if [ -n "$1" ]; then printf '%s %s' "$1" "$2"; else printf '%s' "$2"; fi
}

# Strip control characters from anything we did not author (terminal escape injection).
sanitize() {
  # C0 and DEL by byte, then the UTF-8 encoding of C1 (U+0080-U+009F is
  # 0xC2 0x80-0x9F), to match the JS version's [\u0000-\u001F\u007F-\u009F].
  printf '%s' "$1" \
    | LC_ALL=C tr -d '\000-\037\177' \
    | LC_ALL=C sed $'s/\xc2[\x80-\x9f]//g' \
    | cut -c1-80
}

color_for_pct() {
  local pct=$1
  if [ "$pct" -ge 80 ]; then printf '%s' "$RED"
  elif [ "$pct" -ge 50 ]; then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"; fi
}

progress_bar() {
  local pct=$1 filled empty bar="" i
  filled=$(( pct / 10 ))
  [ "$filled" -gt 10 ] && filled=10
  [ "$filled" -lt 0 ] && filled=0
  empty=$(( 10 - filled ))
  for ((i=0; i<filled; i++)); do bar+="$BAR_FULL"; done
  for ((i=0; i<empty; i++)); do bar+="$BAR_EMPTY"; done
  printf '%b%s%b' "$(color_for_pct "$pct")" "$bar" "$RESET"
}

# ── Line 1: session info ──
model=$(sanitize "$(echo "$input" | jq -r '.model.display_name // ""')")
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
lines_added=$(echo "$input" | jq -r '(.cost.total_lines_added // 0) | floor')
lines_removed=$(echo "$input" | jq -r '(.cost.total_lines_removed // 0) | floor')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // ""')

ctx_int=0
if [ -n "$used_pct" ]; then
  printf -v ctx_int "%.0f" "$used_pct" 2>/dev/null || ctx_int="${used_pct%%.*}"
fi
case "$ctx_int" in (*[!0-9]*|"") ctx_int=0 ;; esac
case "$lines_added" in (*[!0-9]*|"") lines_added=0 ;; esac
case "$lines_removed" in (*[!0-9]*|"") lines_removed=0 ;; esac

# Read the branch straight out of .git/HEAD. Claude Code redraws the status
# line constantly, so this spawns no git process (matches statusline-command.js).
find_git_dir() {
  local dir=$1 candidate pointer parent depth=0
  while [ -n "$dir" ] && [ "$depth" -lt 64 ]; do
    candidate="$dir/.git"
    if [ -d "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    if [ -f "$candidate" ]; then
      # Worktree or submodule: ".git" is a file pointing at the real git dir.
      pointer=$(sed -n 's/^gitdir:[[:space:]]*//p' "$candidate" 2>/dev/null | head -n1)
      [ -z "$pointer" ] && return 1
      case "$pointer" in
        /*|?:[\\/]*) printf '%s' "$pointer" ;;
        *) printf '%s' "$dir/$pointer" ;;
      esac
      return 0
    fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && return 1
    dir=$parent
    depth=$((depth + 1))
  done
  return 1
}

git_branch=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  git_dir=$(find_git_dir "$cwd" || true)
  if [ -n "$git_dir" ] && [ -r "$git_dir/HEAD" ]; then
    head=$(head -n1 "$git_dir/HEAD" 2>/dev/null | tr -d '\r')
    case "$head" in
      ref:*refs/heads/*) git_branch=${head#*refs/heads/} ;;
      *) case "$head" in
           [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*)
             git_branch=$(printf '%.7s' "$head") ;;  # detached HEAD
         esac ;;
    esac
  fi
  git_branch=$(sanitize "$git_branch")
fi

sep="${GRAY} | ${RESET}"
line1="$(with_icon "$I_MODEL" "${model:-claude}")"
line1+="${sep}$(color_for_pct "$ctx_int")$(with_icon "$I_CTX" "${ctx_int}%")${RESET}"
line1+="${sep}$(with_icon "$I_EDIT" "+${lines_added}/-${lines_removed}")"
[ -n "$git_branch" ] && line1+="${sep}$(with_icon "$I_BRANCH" "$git_branch")"
if [ "$ctx_int" -ge 85 ]; then
  line1+="${sep}${RED}${I_HOT} COMPACT IMMINENT${RESET}"
elif [ "$ctx_int" -ge 70 ]; then
  line1+="${sep}${YELLOW}${I_WARN} CONTEXT HIGH${RESET}"
fi

# ── Usage API (OAuth) ──
# Cache lives in the user-owned config dir, never in a world-writable /tmp.
CACHE_FILE="${CONFIG_DIR}/statusline-usage-cache.json"

read_access_token() {
  local raw="" file
  for file in "${CONFIG_DIR}/.credentials.json" "${CONFIG_DIR}/credentials.json"; do
    [ -r "$file" ] && { raw=$(cat "$file"); break; }
  done
  if [ -z "$raw" ] && [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v security >/dev/null 2>&1; then
    raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  fi
  [ -z "$raw" ] && return 1
  # Skip an expired token instead of sending it.
  printf '%s' "$raw" | jq -r --argjson now "$(date +%s)000" '
    (.claudeAiOauth // .) as $o
    | ($o.expiresAt // $o.expires_at // 0) as $exp
    | if ($exp | tonumber? // 0) > 0 and ($exp | tonumber) < $now then empty
      else ($o.accessToken // $o.access_token // empty) end' 2>/dev/null
}

# Keep only the numbers we render; the token never reaches the cache.
project_usage() {
  jq -c '{
    v: 1,
    five_hour: (if (.five_hour.utilization // null) != null
                then {utilization: (.five_hour.utilization | round), resets_at: (.five_hour.resets_at // null)}
                else null end),
    seven_day: (if (.seven_day.utilization // null) != null
                then {utilization: (.seven_day.utilization | round), resets_at: (.seven_day.resets_at // null)}
                else null end),
    scoped: [ (.limits // [])[]
              | select(.kind == "weekly_scoped" and .scope.model.display_name != null)
              | {name: .scope.model.display_name, percent: ((.percent // 0) | round), resets_at: (.resets_at // null)} ][0:8]
  }' 2>/dev/null
}

fetch_usage() {
  local token response projected
  token=$(read_access_token) || return 1
  [ -z "$token" ] && return 1

  # curl verifies TLS by default; --proto '=https' refuses a downgrade, and
  # HTTPS_PROXY/NO_PROXY from the environment are honoured automatically.
  response=$(curl -sf --proto '=https' --tlsv1.2 --max-time "$NET_TIMEOUT" \
    -H "Authorization: Bearer ${token}" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Accept: application/json" \
    -A "claude-statusline" \
    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null) || return 1

  projected=$(printf '%s' "$response" | project_usage)
  [ -z "$projected" ] && return 1
  projected=$(printf '%s' "$projected" | jq -c --argjson ts "$(date +%s)" '. + {cached_at: $ts}')

  mkdir -p "$CONFIG_DIR" 2>/dev/null
  ( umask 077; printf '%s' "$projected" > "${CACHE_FILE}.$$.tmp" ) 2>/dev/null \
    && mv -f "${CACHE_FILE}.$$.tmp" "$CACHE_FILE" 2>/dev/null \
    || rm -f "${CACHE_FILE}.$$.tmp" 2>/dev/null
  printf '%s' "$projected"
}

read_cache() {
  local age cached_at
  [ -f "$CACHE_FILE" ] || return 1
  cached_at=$(jq -r 'select(.v == 1) | (.cached_at | numbers) // empty' "$CACHE_FILE" 2>/dev/null || echo "")
  # A corrupted or hand-edited cache must not reach the arithmetic below.
  case "$cached_at" in (*[!0-9]*|"") return 1 ;; esac
  age=$(( $(date +%s) - cached_at ))
  [ "$age" -lt 0 ] && return 1
  [ "$age" -gt "$STALE_MAX" ] && return 1
  printf '%s\t%s' "$age" "$(cat "$CACHE_FILE")"
}

get_usage() {
  [ -n "$SKIP_USAGE" ] && return 1
  local cached age payload
  if cached=$(read_cache); then
    age=${cached%%$'\t'*}
    payload=${cached#*$'\t'}
    if [ "$age" -lt "$CACHE_TTL" ]; then printf '%s' "$payload"; return 0; fi
  fi
  # Refresh; on failure keep the last known numbers rather than dropping the lines.
  fetch_usage || { [ -n "${payload:-}" ] && printf '%s' "$payload"; }
}

# ── Reset-time formatting (local timezone) ──
iso_to_epoch() {
  local stripped="${1%%.*}"
  stripped="${stripped%%+*}"
  stripped="${stripped%Z}"
  TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$stripped" +%s 2>/dev/null \
    || TZ=UTC date -d "$stripped" +%s 2>/dev/null \
    || echo ""
}

epoch_fmt() {
  local epoch=$1 fmt=$2
  LC_ALL=C date -r "$epoch" +"$fmt" 2>/dev/null || LC_ALL=C date -d "@$epoch" +"$fmt" 2>/dev/null
}

# Prefer the IANA zone name (matches statusline-command.js); fall back to the abbreviation.
tz_label() {
  local link zone
  if [ -n "${TZ:-}" ]; then printf %s "$TZ"; return; fi
  link=$(readlink /etc/localtime 2>/dev/null || true)
  case "$link" in
    *zoneinfo/*) printf %s "${link#*zoneinfo/}"; return ;;
  esac
  zone=$(LC_ALL=C date +%Z 2>/dev/null | LC_ALL=C tr -cd "[:alnum:]+-")
  printf %s "${zone:-local}"
}
TZ_LABEL=$(tz_label)

# "Resets 11:30am" / "Resets 2pm" - minutes only when the reset is not on the hour.
clock_label() {
  local epoch=$1 minute
  epoch=$(( (epoch + 30) / 60 * 60 ))
  minute=$(epoch_fmt "$epoch" "%M")
  if [ "$minute" = "00" ]; then
    epoch_fmt "$epoch" "%-l%p" | tr 'AP' 'ap' | sed 's/M/m/'
  else
    epoch_fmt "$epoch" "%-l:%M%p" | tr 'AP' 'ap' | sed 's/M/m/'
  fi
}

format_reset() {
  local iso=$1 with_date=$2 epoch
  [ -z "$iso" ] || [ "$iso" = "null" ] && return
  epoch=$(iso_to_epoch "$iso")
  [ -z "$epoch" ] && return
  if [ "$with_date" = "1" ]; then
    printf 'Resets %s at %s (%s)' "$(epoch_fmt "$epoch" '%b %-d')" "$(clock_label "$epoch")" "$TZ_LABEL"
  else
    printf 'Resets %s (%s)' "$(clock_label "$epoch")" "$TZ_LABEL"
  fi
}

# usage_line ICON LABEL PCT RESET_STR
usage_line() {
  local icon=$1 label=$2 pct=$3 reset_str=$4 color line
  case "$pct" in (*[!0-9]*|"") pct=0 ;; esac
  [ "$pct" -gt 9999 ] && pct=9999
  color=$(color_for_pct "$pct")
  line="${color}$(with_icon "$icon" "$label")${RESET}  $(progress_bar "$pct")  ${color}${pct}%${RESET}"
  [ -n "$reset_str" ] && line+="  ${GRAY}${reset_str}${RESET}"
  printf '%b' "$line"
}

extra_lines=()
usage_json=$(get_usage 2>/dev/null || true)

if [ -n "$usage_json" ]; then
  five_util=$(printf '%s' "$usage_json" | jq -r '.five_hour.utilization // empty' 2>/dev/null)
  five_reset=$(printf '%s' "$usage_json" | jq -r '.five_hour.resets_at // empty' 2>/dev/null)
  seven_util=$(printf '%s' "$usage_json" | jq -r '.seven_day.utilization // empty' 2>/dev/null)
  seven_reset=$(printf '%s' "$usage_json" | jq -r '.seven_day.resets_at // empty' 2>/dev/null)

  [ -n "$five_util" ] && extra_lines+=("$(usage_line "$I_5H" "5h" "$five_util" "$(format_reset "$five_reset" 0)")")
  [ -n "$seven_util" ] && extra_lines+=("$(usage_line "$I_7D" "7d" "$seven_util" "$(format_reset "$seven_reset" 1)")")

  while IFS=$'\t' read -r name pct reset_at; do
    [ -z "$name" ] && continue
    extra_lines+=("$(usage_line "$I_SCOPED" "7d $(sanitize "$name")" "$pct" "$(format_reset "$reset_at" 1)")")
  done < <(printf '%s' "$usage_json" | jq -r '(.scoped // [])[] | [.name, .percent, (.resets_at // "")] | @tsv' 2>/dev/null)
fi

# ── Output ──
printf '%b' "$line1"
for l in "${extra_lines[@]+"${extra_lines[@]}"}"; do
  printf '\n%b' "$l"
done
