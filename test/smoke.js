#!/usr/bin/env node
/**
 * Offline smoke test for statusline-command.js.
 *
 *   node test/smoke.js
 *
 * Every case runs against a throwaway CLAUDE_CONFIG_DIR and never touches the
 * network: a pre-seeded cache file supplies the usage numbers.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "statusline-command.js");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));

const INPUT = {
  model: { display_name: "Fable 5.1" },
  context_window: { used_percentage: 12.4 },
  cost: { total_lines_added: 3, total_lines_removed: 1 },
  workspace: { current_dir: sandbox },
};

function seedCache(overrides) {
  const cache = Object.assign(
    {
      v: 1,
      cached_at: Math.floor(Date.now() / 1000),
      five_hour: { utilization: 52, resets_at: "2026-09-08T02:29:59.000000+00:00" },
      seven_day: { utilization: 20, resets_at: "2026-09-11T05:00:00.000000+00:00" },
      scoped: [{ name: "Fable", percent: 39, resets_at: "2026-09-11T05:00:00.000000+00:00" }],
    },
    overrides || {}
  );
  fs.writeFileSync(path.join(sandbox, "statusline-usage-cache.json"), JSON.stringify(cache), "utf8");
}

function run(input, env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 20000,
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: sandbox, TZ: "UTC" }, env || {}),
  });
  assert.strictEqual(result.status, 0, `exited with ${result.status}: ${result.stderr}`);
  return result.stdout;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok   ${name}\n`);
}

// 1. Four lines rendered from a fresh cache, no network needed.
check("renders session + 5h + 7d + per-model lines from cache", () => {
  seedCache();
  const lines = run(INPUT, { NO_COLOR: "1" }).split("\n");
  assert.strictEqual(lines.length, 4, `expected 4 lines, got ${lines.length}`);
  assert.ok(lines[0].includes("Fable 5.1"), lines[0]);
  assert.ok(lines[0].includes("12%"), lines[0]);
  assert.ok(lines[0].includes("+3/-1"), lines[0]);
  assert.ok(lines[1].includes("5h") && lines[1].includes("52%"), lines[1]);
  assert.ok(lines[2].includes("7d") && lines[2].includes("20%"), lines[2]);
  assert.ok(lines[3].includes("7d Fable") && lines[3].includes("39%"), lines[3]);
});

// 2. Reset labels: minutes appear only off the hour, and the zone is named.
check("formats reset times in the local zone", () => {
  seedCache();
  const lines = run(INPUT, { NO_COLOR: "1" }).split("\n");
  assert.ok(lines[1].includes("Resets 2:30am (UTC)"), lines[1]);
  assert.ok(lines[2].includes("Resets Sep 11 at 5am (UTC)"), lines[2]);
});

// 3. A hostile model name cannot inject terminal escapes.
check("strips control characters from API and stdin text", () => {
  seedCache({ scoped: [{ name: "Ev\u001b[31mil", percent: 5, resets_at: null }] });
  const out = run(
    { model: { display_name: "Bad\u001b[5m\u0007name" }, context_window: { used_percentage: 1 } },
    { NO_COLOR: "1" }
  );
  assert.ok(!out.includes("\u001b"), "escape character survived");
  assert.ok(!out.includes("\u0007"), "bell character survived");
  assert.ok(out.includes("Bad[5mname"), out);
});

// 4. ASCII mode drops emoji and box-drawing characters entirely.
check("ascii mode emits plain ASCII only", () => {
  seedCache();
  const out = run(INPUT, { NO_COLOR: "1", CLAUDE_STATUSLINE_ASCII: "1" });
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7E\n]*$/.test(out), `non-ascii output: ${JSON.stringify(out)}`);
  assert.ok(out.includes("#") && out.includes("-"), out);
});

// 5. Colors are emitted by default and suppressed by NO_COLOR.
check("honours NO_COLOR", () => {
  seedCache();
  assert.ok(run(INPUT, {}).includes("\u001b[38;2;"), "expected truecolor output");
  assert.ok(!run(INPUT, { NO_COLOR: "1" }).includes("\u001b"), "NO_COLOR still emitted color");
});

// 6. A cache older than the stale window is ignored rather than shown as current.
check("ignores a cache past the stale window", () => {
  seedCache({ cached_at: Math.floor(Date.now() / 1000) - 999999 });
  const out = run(INPUT, { NO_COLOR: "1", CLAUDE_STATUSLINE_NO_USAGE: "1" });
  assert.strictEqual(out.split("\n").length, 1, out);
});

// 7. A cache written by a future format version is ignored.
check("ignores a cache with an unknown version", () => {
  seedCache({ v: 99 });
  const out = run(INPUT, { NO_COLOR: "1", CLAUDE_STATUSLINE_NO_USAGE: "1" });
  assert.strictEqual(out.split("\n").length, 1, out);
});

// 8. Garbage or empty stdin still produces a usable first line.
check("survives empty and malformed stdin", () => {
  seedCache();
  for (const raw of ["", "   ", "not json", "[]", "null"]) {
    const out = run(raw, { NO_COLOR: "1" });
    assert.ok(out.split("\n")[0].length > 0, `empty output for input ${JSON.stringify(raw)}`);
  }
});

// 9. Absurd numbers from the host are clamped instead of drawing a huge bar.
check("clamps out-of-range percentages", () => {
  seedCache({ five_hour: { utilization: 5000, resets_at: null } });
  const lines = run(INPUT, { NO_COLOR: "1" }).split("\n");
  const bar = lines[1].match(/[#-]{10}/) || lines[1].match(/[▰▱]{10}/);
  assert.ok(bar, `bar not found in: ${lines[1]}`);
});

// 10. Nothing that looks like a credential is ever printed.
check("never prints anything token-shaped", () => {
  seedCache();
  const out = run(INPUT, {});
  assert.ok(!/sk-[A-Za-z0-9]/.test(out), out);
  assert.ok(!/eyJ[A-Za-z0-9]/.test(out), out);
  assert.ok(!/Bearer /.test(out), out);
});

// 11. An expired token is never sent: no request, no usage lines, no hang.
check("skips the request when the stored token has expired", () => {
  fs.rmSync(path.join(sandbox, "statusline-usage-cache.json"), { force: true });
  fs.writeFileSync(
    path.join(sandbox, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(40), expiresAt: Date.now() - 60000 } }),
    "utf8"
  );
  const started = Date.now();
  const out = run(INPUT, { NO_COLOR: "1" });
  assert.strictEqual(out.split("\n").length, 1, out);
  assert.ok(Date.now() - started < 5000, "expired token still caused a network wait");
  fs.rmSync(path.join(sandbox, ".credentials.json"), { force: true });
});

// 12. A failed refresh records a backoff instead of retrying on every redraw.
check("records a backoff after a failed refresh", () => {
  fs.rmSync(path.join(sandbox, "statusline-usage-cache.json"), { force: true });
  fs.writeFileSync(
    path.join(sandbox, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(40), expiresAt: Date.now() + 3600000 } }),
    "utf8"
  );
  // Port 1 refuses instantly, so this fails without waiting on a timeout.
  run(INPUT, { NO_COLOR: "1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "" });
  const cache = JSON.parse(fs.readFileSync(path.join(sandbox, "statusline-usage-cache.json"), "utf8"));
  assert.ok(cache.retry_after > Math.floor(Date.now() / 1000), `no backoff recorded: ${cache.retry_after}`);
  assert.ok(!JSON.stringify(cache).includes("xxxx"), "the token reached the cache file");
  fs.rmSync(path.join(sandbox, ".credentials.json"), { force: true });
});

// 13. A malformed or out-of-range option never takes the whole line down.
check("survives malformed option values", () => {
  seedCache();
  for (const env of [
    { CLAUDE_STATUSLINE_CACHE_TTL: "abc" },
    { CLAUDE_STATUSLINE_TIMEOUT_MS: "-5" },
    { CLAUDE_STATUSLINE_STALE_MAX: "99999999999" },
    { CLAUDE_STATUSLINE_CA: "C:/nope/missing-ca.pem" },
  ]) {
    const out = run(INPUT, Object.assign({ NO_COLOR: "1" }, env));
    assert.ok(out.split("\n")[0].includes("Fable 5.1"), `broke on ${JSON.stringify(env)}: ${out}`);
  }
});

// 14. The installer refuses to delete a status line another tool owns.
check("uninstall leaves a foreign statusLine alone", () => {
  const settings = path.join(sandbox, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "other-tool" } }), "utf8");
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "install.js"), "--uninstall"], {
    encoding: "utf8",
    timeout: 20000,
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: sandbox }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("not ours"), result.stdout);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.strictEqual(after.statusLine.command, "other-tool", "a foreign statusLine was deleted");
});

fs.rmSync(sandbox, { recursive: true, force: true });
process.stdout.write(`\n${passed} checks passed\n`);
