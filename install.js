#!/usr/bin/env node
/**
 * Cross-platform installer for the Claude Code statusline.
 *
 *   node install.js              install statusline-command.js (Windows/macOS/Linux)
 *   node install.js --shell      install statusline-command.sh (macOS/Linux, needs jq+curl)
 *   node install.js --uninstall  remove the statusLine entry and the installed script
 *   node install.js --dry-run    show what would change, write nothing
 *
 * settings.json is backed up before it is rewritten, and only the "statusLine"
 * key is touched.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const USE_SHELL = args.includes("--shell");
const UNINSTALL = args.includes("--uninstall");
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
// Claude Code may launch the status line with a different PATH than this shell
// (GUI launch, nvm, a login shell that never ran). --node-path pins the exact
// interpreter instead of relying on "node" resolving at redraw time.
const PIN_NODE = args.includes("--node-path");

const HOME = os.homedir() || process.env.USERPROFILE || process.env.HOME;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const SETTINGS = path.join(CONFIG_DIR, "settings.json");
const REPO_DIR = __dirname;

const SCRIPT_NAME = USE_SHELL ? "statusline-command.sh" : "statusline-command.js";
const SOURCE = path.join(REPO_DIR, SCRIPT_NAME);
const TARGET = path.join(CONFIG_DIR, SCRIPT_NAME);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

/** Claude Code runs this through a shell, so forward slashes are safest on Windows. */
function posix(p) {
  return p.split(path.sep).join("/");
}

function commandFor(target) {
  // Claude Code runs this string through a shell, so a quote or a backtick in
  // the path would break out of our quoting. Refuse rather than emit it.
  const unsafe = /["`$\\\n]/;
  const check = function (p) {
    // Check after separator conversion, so ordinary Windows backslashes are gone.
    const converted = posix(p);
    if (unsafe.test(converted)) {
      fail(`refusing to build a shell command for a path with quotes or shell metacharacters: ${p}`);
    }
    return converted;
  };
  const quoted = `"${check(target)}"`;
  if (USE_SHELL) return `bash ${quoted}`;
  const node = PIN_NODE ? `"${check(process.execPath)}"` : "node";
  return `${node} ${quoted}`;
}

/** True when the configured command points at a script this installer placed. */
function looksLikeOurs(command) {
  if (typeof command !== "string") return false;
  return ["statusline-command.js", "statusline-command.sh"].some(function (name) {
    return command.includes(posix(path.join(CONFIG_DIR, name))) || command.includes(name);
  });
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^\uFEFF/, ""); // PowerShell writes a BOM
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${SETTINGS} is not a JSON object. Fix it first, nothing was changed.`);
    }
    return parsed;
  } catch (err) {
    fail(`${SETTINGS} is not valid JSON (${err.message}). Fix it first, nothing was changed.`);
  }
  return {};
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${SETTINGS}.bak-${stamp}`;
  fs.copyFileSync(SETTINGS, backup);
  return backup;
}

/**
 * Apply one change to settings.json against the newest copy on disk.
 *
 * Claude Code may write the file while the installer runs, so the snapshot read
 * for the preview above is not safe to write back wholesale: re-read here and
 * touch only the statusLine key.
 */
function updateSettings(mutate) {
  const fresh = readSettings();
  mutate(fresh);
  writeSettings(fresh);
}

function writeSettings(settings) {
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  // Keep whatever permissions the file already had; 0600 only for a brand new one.
  let mode = 0o600;
  try {
    mode = fs.statSync(SETTINGS).mode & 0o777;
  } catch (err) {
    /* the file does not exist yet */
  }
  fs.writeFileSync(tmp, payload, { encoding: "utf8", mode });
  fs.renameSync(tmp, SETTINGS);
}

function install() {
  if (!fs.existsSync(SOURCE)) fail(`${SCRIPT_NAME} not found next to install.js (looked in ${REPO_DIR}).`);
  if (USE_SHELL && process.platform === "win32") {
    fail("--shell is POSIX-only. On Windows run: node install.js");
  }

  const settings = readSettings();
  const previous = settings.statusLine && settings.statusLine.command;
  const command = commandFor(TARGET);

  info(`script:   ${SOURCE}`);
  info(`       -> ${TARGET}`);
  info(`settings: ${SETTINGS}`);
  if (previous && previous !== command) info(`replacing statusLine command: ${previous}`);
  info(`new statusLine command: ${command}`);

  if (DRY_RUN) {
    info("dry run: nothing written.");
    return;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.copyFileSync(SOURCE, TARGET);
  if (process.platform !== "win32") fs.chmodSync(TARGET, 0o755);

  const backup = backupSettings();
  updateSettings(function (fresh) {
    fresh.statusLine = { type: "command", command };
  });

  if (backup) info(`backup:   ${backup}`);
  info("installed. Restart Claude Code (or start a new session) to see it.");
}

function uninstall() {
  const settings = readSettings();
  const existing = settings.statusLine && settings.statusLine.command;
  const hadEntry = Boolean(settings.statusLine);

  // Never silently delete another tool's status line.
  if (hadEntry && !looksLikeOurs(existing) && !FORCE) {
    info(`settings: ${SETTINGS}`);
    info(`the configured statusLine is not ours: ${existing}`);
    info("left it alone. Re-run with --force to remove it anyway.");
    return;
  }

  info(`settings: ${SETTINGS}`);
  info(hadEntry ? "removing the statusLine entry" : "no statusLine entry to remove");
  for (const name of ["statusline-command.js", "statusline-command.sh", "statusline-usage-cache.json"]) {
    const file = path.join(CONFIG_DIR, name);
    if (fs.existsSync(file)) info(`removing ${file}`);
  }

  if (DRY_RUN) {
    info("dry run: nothing written.");
    return;
  }

  if (hadEntry) {
    const backup = backupSettings();
    updateSettings(function (fresh) {
      delete fresh.statusLine;
    });
    if (backup) info(`backup:   ${backup}`);
  }
  for (const name of ["statusline-command.js", "statusline-command.sh", "statusline-usage-cache.json"]) {
    try {
      fs.unlinkSync(path.join(CONFIG_DIR, name));
    } catch (err) {
      /* already gone */
    }
  }
  info("uninstalled. Restart Claude Code to drop the status line.");
}

if (!HOME) fail("cannot resolve the home directory.");
if (UNINSTALL) uninstall();
else install();
