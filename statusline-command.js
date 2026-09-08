#!/usr/bin/env node
/**
 * Claude Code statusline (cross-platform: Windows / macOS / Linux).
 *
 * Lines: session info / 5h usage / 7d usage / 7d per-model usage (e.g. Fable).
 * Requires: Node.js 18+. No jq, no curl, no bash.
 *
 * Security notes (see README.md#security):
 *   - The OAuth token is read locally and sent only to https://api.anthropic.com.
 *   - TLS verification is always enforced, even when NODE_TLS_REJECT_UNAUTHORIZED=0
 *     is set in the environment.
 *   - Child processes are spawned without a shell (no command injection via paths).
 *   - The cache lives in the user's Claude config dir, holds usage numbers only,
 *     and is written 0600 through a temp file + rename.
 *   - Anything coming from stdin, git or the API is stripped of control
 *     characters so it cannot inject terminal escape sequences.
 */

"use strict";

// This statusline sends an OAuth token, so it never inherits a globally disabled
// TLS check. Every connection below also passes rejectUnauthorized: true explicitly.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { execFileSync } = require("child_process");

// -- Configuration (all optional, via environment) ---------------------------
const API_HOST = "api.anthropic.com";
const API_PORT = 443;
const API_PATH = "/api/oauth/usage";

// Declared before the intEnv() calls below, which may report through debug().
const DEBUG = truthy(process.env.CLAUDE_STATUSLINE_DEBUG);

/** Diagnostics go to stderr only: stdout is the status line itself. */
function debug(message) {
  if (DEBUG) process.stderr.write(`[statusline] ${message}\n`);
}

const CACHE_TTL_SEC = intEnv("CLAUDE_STATUSLINE_CACHE_TTL", 360, 30, 86400);
const STALE_MAX_SEC = intEnv("CLAUDE_STATUSLINE_STALE_MAX", 3600, 60, 604800);
// Kept short on purpose: Claude Code redraws often and gives the command a
// limited budget, so a slow API must not delay the line people actually read.
const NET_TIMEOUT_MS = intEnv("CLAUDE_STATUSLINE_TIMEOUT_MS", 3000, 500, 15000);
const SKIP_USAGE = truthy(process.env.CLAUDE_STATUSLINE_NO_USAGE);
const ASCII_ONLY = truthy(process.env.CLAUDE_STATUSLINE_ASCII);
const USE_COLOR = !truthy(process.env.NO_COLOR);
const EXTRA_CA_FILE = process.env.CLAUDE_STATUSLINE_CA || "";
const MAX_BODY_BYTES = 256 * 1024;

// Backoff after a failed refresh, so a revoked token or a dead proxy is not
// retried on every single redraw.
const BACKOFF_AUTH_SEC = 3600;
const BACKOFF_NET_SEC = 60;

function intEnv(name, dflt, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    debug(`${name}=${raw} is not a number, using ${dflt}`);
    return dflt;
  }
  const clamped = Math.max(min, Math.min(max, n));
  if (clamped !== n) debug(`${name}=${n} is out of range [${min}, ${max}], using ${clamped}`);
  return clamped;
}

function truthy(v) {
  return v != null && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";
}

// -- Colors ------------------------------------------------------------------
const GREEN = USE_COLOR ? "\x1b[38;2;151;201;195m" : "";
const YELLOW = USE_COLOR ? "\x1b[38;2;229;192;123m" : "";
const RED = USE_COLOR ? "\x1b[38;2;224;108;117m" : "";
const GRAY = USE_COLOR ? "\x1b[38;2;74;88;92m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";

const BAR_FULL = ASCII_ONLY ? "#" : "▰";
const BAR_EMPTY = ASCII_ONLY ? "-" : "▱";
const ICON = ASCII_ONLY
  ? { model: "", ctx: "ctx", edit: "", branch: "git", h5: "", d7: "", scoped: "", hot: "!", warn: "!" }
  : {
      model: "🤖",
      ctx: "📊",
      edit: "✏️",
      branch: "🔀",
      // U+23F1 and U+26A0 are East-Asian-ambiguous width, so force the emoji
      // presentation with U+FE0F: without it CJK terminals render them wide and
      // Western ones narrow, and the bars stop lining up.
      h5: "⏱️",
      d7: "📅",
      scoped: "🧠",
      hot: "🔥",
      warn: "⚠️",
    };

function withIcon(icon, text) {
  return icon ? icon + " " + text : text;
}

function colorForPct(pct) {
  if (pct >= 80) return RED;
  if (pct >= 50) return YELLOW;
  return GREEN;
}

function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.floor(pct / 10)));
  return colorForPct(pct) + BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(10 - filled) + RESET;
}

/** Strip control characters (including ESC) from anything we did not author. */
function safeText(value, maxLen) {
  if (typeof value !== "string") return "";
  const limit = maxLen || 80;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  return cleaned.length > limit ? cleaned.slice(0, limit - 1) + "…" : cleaned;
}

function toCount(value) {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(99999999, Math.round(n));
}

function toPct(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(9999, Math.round(n)));
}

// -- Paths -------------------------------------------------------------------
function homeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || ".";
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), ".claude");
}

function cacheFilePath() {
  return path.join(claudeConfigDir(), "statusline-usage-cache.json");
}

/**
 * Used only when the config dir cannot be written (a cloud-synced home
 * directory can hold a lock on it). The file holds no secrets, and rename()
 * replaces a symlink instead of writing through it, so a shared temp dir is
 * acceptable here; the contents are re-validated on read either way.
 */
function fallbackCacheFilePath() {
  const key = Buffer.from(claudeConfigDir()).toString("base64url").slice(-16);
  return path.join(os.tmpdir(), `claude-statusline-cache-${key}.json`);
}

// -- Line 1: session info ----------------------------------------------------
function buildSessionLine(input) {
  const sep = GRAY + " | " + RESET;
  const model = safeText(input && input.model && input.model.display_name, 40);
  const ctx = toPct(input && input.context_window && input.context_window.used_percentage) || 0;
  const added = toCount(input && input.cost && input.cost.total_lines_added);
  const removed = toCount(input && input.cost && input.cost.total_lines_removed);
  const cwd =
    input && input.workspace && typeof input.workspace.current_dir === "string" ? input.workspace.current_dir : "";

  const parts = [];
  parts.push(withIcon(ICON.model, model || "claude"));
  parts.push(colorForPct(ctx) + withIcon(ICON.ctx, ctx + "%") + RESET);
  parts.push(withIcon(ICON.edit, "+" + added + "/-" + removed));

  const branch = gitBranch(cwd);
  if (branch) parts.push(withIcon(ICON.branch, branch));

  let line = parts.join(sep);
  if (ctx >= 85) line += sep + RED + ICON.hot + " COMPACT IMMINENT" + RESET;
  else if (ctx >= 70) line += sep + YELLOW + ICON.warn + " CONTEXT HIGH" + RESET;
  return line;
}

/**
 * Read the branch straight out of .git/HEAD.
 *
 * Claude Code redraws the status line constantly, so this deliberately spawns
 * no child process: one small file read beats `git rev-parse` on a large repo,
 * a network share, or a machine where an endpoint agent hooks process creation.
 */
function gitBranch(cwd) {
  if (!cwd) return "";
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch (err) {
    return "";
  }

  let gitDir = "";
  for (let depth = 0; depth < 64 && dir; depth += 1) {
    const candidate = path.join(dir, ".git");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        gitDir = candidate;
        break;
      }
      if (stat.isFile()) {
        // Worktree or submodule: ".git" is a file pointing at the real git dir.
        const pointer = fs.readFileSync(candidate, "utf8").match(/^gitdir:\s*(.+)$/m);
        if (!pointer) return "";
        gitDir = path.resolve(dir, pointer[1].trim());
        break;
      }
    } catch (err) {
      /* no .git here: walk up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
  if (!gitDir) return "";

  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch (err) {
    return "";
  }
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return safeText(ref[1], 40);
  if (/^[0-9a-f]{7,40}$/i.test(head)) return safeText(head.slice(0, 7), 12); // detached HEAD
  return "";
}

// -- Credentials -------------------------------------------------------------
function extractToken(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = parsed.claudeAiOauth || parsed;
  const token = oauth.accessToken || oauth.access_token;
  if (typeof token !== "string" || token.length < 20) return null;
  const expiresAt = Number(oauth.expiresAt || oauth.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) return null;
  return token;
}

function readAccessToken() {
  const candidates = [
    path.join(claudeConfigDir(), ".credentials.json"),
    path.join(claudeConfigDir(), "credentials.json"),
  ];
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "Claude", "credentials.json"));
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      const token = extractToken(fs.readFileSync(candidates[i], "utf8"));
      if (token) return token;
    } catch (err) {
      /* absent or unreadable: try the next source */
    }
  }

  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024,
      });
      const token = extractToken(raw);
      if (token) return token;
    } catch (err) {
      /* Keychain locked or entry missing */
    }
  }
  return null;
}

// -- Proxy handling ----------------------------------------------------------
function noProxyMatches(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || "";
  return raw
    .split(",")
    .map(function (s) {
      return s.trim().toLowerCase();
    })
    .filter(Boolean)
    .some(function (entry) {
      if (entry === "*") return true;
      const bare = entry.replace(/^\./, "").replace(/:\d+$/, "");
      return host === bare || host.endsWith("." + bare);
    });
}

function proxyConfig() {
  if (noProxyMatches(API_HOST)) return null;
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.indexOf("://") >= 0 ? raw : "http://" + raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const cfg = {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    headers: {},
  };
  if (url.username) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password || "");
    cfg.headers["Proxy-Authorization"] = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
  }
  return cfg;
}

function tlsOptions() {
  const opts = { servername: API_HOST, rejectUnauthorized: true, minVersion: "TLSv1.2" };
  if (EXTRA_CA_FILE) {
    try {
      opts.ca = tls.rootCertificates.concat([fs.readFileSync(EXTRA_CA_FILE, "utf8")]);
    } catch (err) {
      /* unreadable CA bundle: keep the built-in roots */
    }
  }
  return opts;
}

/** Resolve to a proxy tunnel socket, or to null when a direct connection applies. */
function connectSocket(timeoutMs) {
  return new Promise(function (resolve, reject) {
    const proxy = proxyConfig();
    if (!proxy) {
      resolve(null);
      return;
    }
    const transport = proxy.protocol === "https:" ? https : http;
    const req = transport.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: API_HOST + ":" + API_PORT,
      headers: Object.assign({ Host: API_HOST + ":" + API_PORT }, proxy.headers),
      timeout: timeoutMs,
      agent: false,
      rejectUnauthorized: true,
    });
    const fail = function (err) {
      req.destroy();
      reject(err);
    };
    req.on("connect", function (res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error("proxy CONNECT failed (" + res.statusCode + ")"));
        return;
      }
      resolve(socket);
    });
    req.on("error", fail);
    req.on("timeout", function () {
      fail(new Error("proxy timeout"));
    });
    req.end();
  });
}

function fetchUsage(token, timeoutMs) {
  return new Promise(function (resolve, reject) {
    connectSocket(timeoutMs).then(function (socket) {
      const options = Object.assign(
        {
          host: API_HOST,
          port: API_PORT,
          method: "GET",
          path: API_PATH,
          headers: {
            Authorization: "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
            "User-Agent": "claude-statusline",
          },
          timeout: timeoutMs,
          agent: false,
        },
        tlsOptions()
      );
      if (socket) options.socket = socket;

      const req = https.request(options, function (res) {
        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error("usage API returned " + res.statusCode);
          // 401/403 means the token is gone, not that the network blipped:
          // back off for an hour rather than retrying every few minutes.
          err.authFailure = res.statusCode === 401 || res.statusCode === 403;
          reject(err);
          return;
        }
        let body = "";
        let bytes = 0;
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error("usage API response too large"));
            return;
          }
          body += chunk;
        });
        res.on("end", function () {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error("usage API returned invalid JSON"));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", function () {
        req.destroy();
        reject(new Error("usage API timeout"));
      });
      req.end();
    }, reject);
  });
}

// -- Cache (usage numbers only, never the token) -----------------------------
function projectUsage(raw) {
  return projectUsageShape(raw);
}

/** Keep only the fields we render, clamped and stripped of control characters. */
function projectUsageShape(raw) {
  const pick = function (node) {
    if (!node) return null;
    const pct = toPct(node.utilization);
    if (pct === null) return null;
    return { utilization: pct, resets_at: safeText(node.resets_at, 40) || null };
  };

  // The API sends limits[]; our own cache already stores the flattened scoped[].
  let source = [];
  if (raw && Array.isArray(raw.limits)) {
    source = raw.limits
      .filter(function (l) {
        return l && l.kind === "weekly_scoped" && l.scope && l.scope.model && l.scope.model.display_name;
      })
      .map(function (l) {
        return { name: l.scope.model.display_name, percent: l.percent, resets_at: l.resets_at };
      });
  } else if (raw && Array.isArray(raw.scoped)) {
    source = raw.scoped.filter(Boolean);
  }

  const scoped = source
    .slice(0, 8)
    .map(function (l) {
      return {
        name: safeText(l.name, 24),
        percent: toPct(l.percent) || 0,
        resets_at: safeText(l.resets_at, 40) || null,
      };
    })
    .filter(function (l) {
      return l.name;
    });

  return {
    v: 1,
    five_hour: pick(raw && raw.five_hour),
    seven_day: pick(raw && raw.seven_day),
    scoped: scoped,
  };
}

function parseCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.v !== 1 || typeof parsed.cached_at !== "number") return null;
    // Re-project: anything on disk is treated as untrusted input, not as our own output.
    const clean = projectUsageShape(parsed);
    clean.cached_at = parsed.cached_at;
    clean.retry_after = typeof parsed.retry_after === "number" ? parsed.retry_after : 0;
    const age = Math.floor(Date.now() / 1000) - parsed.cached_at;
    if (age < 0 || age > STALE_MAX_SEC) return null;
    return { data: clean, age: age, file: file };
  } catch (err) {
    return null;
  }
}

function readCache() {
  return parseCache(cacheFilePath()) || parseCache(fallbackCacheFilePath());
}

function writeCacheTo(file, payload) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600, flag: "w" });
    // rename() replaces a symlink rather than writing through it.
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      /* nothing else to clean up */
    }
    debug(`cache write failed at ${file}: ${err.code || err.message}`);
    return false;
  }
}

/**
 * Persist the cache, falling back to the temp directory when the config dir is
 * not writable (a home directory synced by OneDrive can hold a lock on it).
 * Without a usable cache every redraw would trigger a fresh API round trip.
 */
function writeCache(usage, options) {
  const opts = options || {};
  const payload = JSON.stringify(
    Object.assign({}, usage, {
      // A failure marker keeps the original timestamp, so stale numbers still
      // age out of the stale window instead of looking fresh forever.
      cached_at: opts.cachedAt || Math.floor(Date.now() / 1000),
      retry_after: opts.retryAfter || 0,
    })
  );
  if (writeCacheTo(cacheFilePath(), payload)) return;
  writeCacheTo(fallbackCacheFilePath(), payload);
}

function hasUsageData(usage) {
  return Boolean(usage && (usage.five_hour || usage.seven_day || (usage.scoped && usage.scoped.length)));
}

function getUsage() {
  if (SKIP_USAGE) return Promise.resolve(null);
  const cached = readCache();
  const now = Math.floor(Date.now() / 1000);
  if (cached && hasUsageData(cached.data) && cached.age < CACHE_TTL_SEC) return Promise.resolve(cached.data);
  if (cached && cached.data.retry_after > now) {
    debug(`in backoff for ${cached.data.retry_after - now}s, showing the last known numbers`);
    return Promise.resolve(cached.data);
  }

  const token = readAccessToken();
  if (!token) {
    debug("no usable OAuth token found (missing, unreadable or expired)");
    return Promise.resolve(cached ? cached.data : null);
  }

  return fetchUsage(token, NET_TIMEOUT_MS).then(
    function (raw) {
      const usage = projectUsage(raw);
      writeCache(usage, {});
      return usage;
    },
    function (err) {
      // Offline, proxy down or token rejected: keep the last known numbers and
      // back off, so a revoked token is not retried on every redraw.
      debug(`usage refresh failed: ${err && err.message ? err.message : err}`);
      const backoff = now + (err && err.authFailure ? BACKOFF_AUTH_SEC : BACKOFF_NET_SEC);
      writeCache(cached ? cached.data : projectUsageShape(null), {
        retryAfter: backoff,
        cachedAt: cached ? cached.data.cached_at : now,
      });
      return cached ? cached.data : null;
    }
  );
}

// -- Reset-time formatting (local timezone) ----------------------------------
const LOCAL_TZ = (function () {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch (err) {
    return "local";
  }
})();

function clockLabel(date) {
  const rounded = new Date(Math.round(date.getTime() / 60000) * 60000);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).formatToParts(rounded);
  const get = function (type) {
    const found = parts.find(function (p) {
      return p.type === type;
    });
    return found ? found.value : "";
  };
  const minute = get("minute");
  const suffix = get("dayPeriod").toLowerCase().replace(/[\s.\u00A0\u202F]/g, "");
  return minute === "00" ? get("hour") + suffix : get("hour") + ":" + minute + suffix;
}

function formatReset(iso, withDate) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = clockLabel(date);
  if (!withDate) return "Resets " + time + " (" + LOCAL_TZ + ")";
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return "Resets " + day + " at " + time + " (" + LOCAL_TZ + ")";
}

function usageLine(icon, label, pct, resetStr) {
  const color = colorForPct(pct);
  let line = color + withIcon(icon, label) + RESET + "  " + progressBar(pct) + "  " + color + pct + "%" + RESET;
  if (resetStr) line += "  " + GRAY + resetStr + RESET;
  return line;
}

function buildUsageLines(usage) {
  if (!usage) return [];
  const lines = [];
  if (usage.five_hour) {
    lines.push(usageLine(ICON.h5, "5h", usage.five_hour.utilization, formatReset(usage.five_hour.resets_at, false)));
  }
  if (usage.seven_day) {
    lines.push(usageLine(ICON.d7, "7d", usage.seven_day.utilization, formatReset(usage.seven_day.resets_at, true)));
  }
  const scoped = usage.scoped || [];
  for (let i = 0; i < scoped.length; i++) {
    lines.push(
      usageLine(ICON.scoped, "7d " + scoped[i].name, scoped[i].percent, formatReset(scoped[i].resets_at, true))
    );
  }
  return lines;
}

// -- Entry point -------------------------------------------------------------
function readStdin() {
  return new Promise(function (resolve) {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, 1500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (chunk) {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) finish();
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// The first line as soon as it is known, so every exit path can still print it.
let pendingSessionLine = "";
let printed = false;

function emit(text) {
  if (printed) return;
  printed = true;
  if (text) process.stdout.write(text);
}

function main() {
  return readStdin()
    .then(function (raw) {
      let input = {};
      try {
        if (raw && raw.trim()) input = JSON.parse(raw);
      } catch (err) {
        input = {};
      }
      pendingSessionLine = buildSessionLine(input);
      return getUsage().then(function (usage) {
        return [pendingSessionLine].concat(buildUsageLines(usage)).join("\n");
      });
    })
    .then(emit);
}

// Never hang Claude Code, and never leak a stack trace into the status line.
// Whatever goes wrong, still print the session line rather than nothing.
function bail(reason) {
  debug(`giving up: ${reason}`);
  emit(pendingSessionLine);
  process.exit(0);
}

const watchdog = setTimeout(function () {
  bail("watchdog fired");
}, NET_TIMEOUT_MS + 4000);
if (typeof watchdog.unref === "function") watchdog.unref();
process.on("uncaughtException", function (err) {
  bail(`uncaught ${err && err.message ? err.message : err}`);
});
process.on("unhandledRejection", function (err) {
  bail(`unhandled rejection ${err && err.message ? err.message : err}`);
});

main().then(
  function () {
    process.exitCode = 0;
  },
  function () {
    process.exitCode = 0;
  }
);
