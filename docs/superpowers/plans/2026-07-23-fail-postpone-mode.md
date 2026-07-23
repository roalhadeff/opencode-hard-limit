# Fail-Postpone Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in third quota-block mode ("fail-postpone") that lets a user temporarily bypass an otherwise-blocking quota check via a shell-escape CLI command (`!opencode-hard-limit postpone [minutes]`), gated behind a new `allowPostpone` config flag.

**Architecture:** A new small module `lib/postpone.js` manages a single global JSON timer file (`postpone.json`, same dir as `quota-cache.json`). `lib/config.js` gains one new boolean config key (`allowPostpone`, default `false`) using the existing generic coerce/precedence machinery — no new plumbing needed there beyond registering the key. `bin/cli.js` gains a `postpone` subcommand that refuses to run unless `allowPostpone` is enabled. `quota-hard-stop.js` checks `isPostponeActive()` (only when `allowPostpone` is true — defense in depth) right after `evaluate()` and, if active, downgrades an otherwise-blocking result to allowed; the block-error message conditionally advertises the postpone command only when the flag is enabled, explicitly stating the minutes parameter's meaning.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict` (existing test conventions), no new dependencies.

**Reference:** Full design rationale is in `docs/superpowers/specs/2026-07-23-fail-postpone-mode-design.md` — read it if any task below is ambiguous.

---

## File Structure

- **Create:** `lib/postpone.js` — postpone timer state (path/read/write/clear/isActive/clamp).
- **Create:** `test/postpone.test.js` — unit tests for the above.
- **Modify:** `lib/config.js` — add `allowPostpone` to `DEFAULTS`, `ENV_KEYS`, `BOOL_KEYS`, and the header doc comment.
- **Modify:** `test/config.test.js` — add `allowPostpone` default/coercion/env-override tests.
- **Modify:** `bin/cli.js` — add `postpone` subcommand, `--allow-postpone` flag, `usage()` text, `showResolved()` status line.
- **Modify:** `test/config.test.js` (CLI smoke test lives here per existing convention — see the "CLI writes stale-margin to project config" test for the pattern) — add a CLI smoke test for `set --allow-postpone`.
- **Create:** `test/cli-postpone.test.js` — CLI smoke tests for the `postpone` subcommand (refusal-when-disabled, write, `--clear`, invalid minutes).
- **Modify:** `quota-hard-stop.js` — integrate `isPostponeActive()` bypass + conditional block-message hint.
- **Modify:** `test/quota-hard-stop.test.js` — integration tests for the bypass and the gating.
- **Modify:** `package.json` — add `lib/postpone.js` to the `files` allowlist.
- **Modify:** `README.md` — new "Fail-postpone mode" section + Settings table row.

---

### Task 1: `lib/postpone.js` — postpone timer module

**Files:**
- Create: `lib/postpone.js`
- Test: `test/postpone.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/postpone.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  postponePath,
  readPostpone,
  writePostpone,
  clearPostpone,
  isPostponeActive,
  clampMinutes,
  DEFAULT_POSTPONE_MINUTES,
} from "../lib/postpone.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-postpone-"));
  return { xdg: join(root, "xdg") };
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("readPostpone returns null when no file exists", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    assert.equal(readPostpone(), null);
  });
});

test("writePostpone then readPostpone round-trips", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const savedNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const { until, minutes } = writePostpone(60);
      assert.equal(minutes, 60);
      assert.equal(until, 1_000_000 + 60 * 60000);
      assert.equal(existsSync(postponePath()), true);
      assert.deepEqual(readPostpone(), { until });
    } finally {
      Date.now = savedNow;
    }
  });
});

test("writePostpone defaults to DEFAULT_POSTPONE_MINUTES when called with no args", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const { minutes } = writePostpone();
    assert.equal(minutes, DEFAULT_POSTPONE_MINUTES);
  });
});

test("clearPostpone removes the file", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    writePostpone(30);
    assert.equal(existsSync(postponePath()), true);
    clearPostpone();
    assert.equal(existsSync(postponePath()), false);
    assert.equal(readPostpone(), null);
  });
});

test("clearPostpone is a no-op when no file exists", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    assert.doesNotThrow(() => clearPostpone());
  });
});

test("clampMinutes clamps to 1..240 and falls back to default for invalid input", () => {
  assert.equal(clampMinutes(60), 60);
  assert.equal(clampMinutes(0), 1);
  assert.equal(clampMinutes(-5), 1);
  assert.equal(clampMinutes(1), 1);
  assert.equal(clampMinutes(240), 240);
  assert.equal(clampMinutes(241), 240);
  assert.equal(clampMinutes(9999), 240);
  assert.equal(clampMinutes("banana"), DEFAULT_POSTPONE_MINUTES);
  assert.equal(clampMinutes(undefined), DEFAULT_POSTPONE_MINUTES);
  assert.equal(clampMinutes(NaN), DEFAULT_POSTPONE_MINUTES);
  assert.equal(clampMinutes(45.6), 46);
});

test("isPostponeActive: true before expiry, false at/after expiry", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const savedNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      writePostpone(30); // until = 1,000,000 + 1,800,000 = 2,800,000
      assert.equal(isPostponeActive(1_500_000), true);
      assert.equal(isPostponeActive(2_800_000), false); // boundary: until > now required, not >=
      assert.equal(isPostponeActive(2_900_000), false);
    } finally {
      Date.now = savedNow;
    }
  });
});

test("isPostponeActive: false when no postpone file exists", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    assert.equal(isPostponeActive(), false);
  });
});

test("readPostpone returns null for corrupt JSON", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    writePostpone(30);
    writeFileSync(postponePath(), "{not json", "utf8");
    assert.equal(readPostpone(), null);
  });
});

test("readPostpone returns null when 'until' is missing or non-numeric", () => {
  const { xdg } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    writeFileSync(postponePath(), JSON.stringify({ nope: true }), "utf8");
    assert.equal(readPostpone(), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/postpone.test.js`
Expected: FAIL — `Cannot find module '../lib/postpone.js'` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/postpone.js`:

```javascript
// lib/postpone.js
//
// "fail-postpone" mode: an explicit, time-boxed, opt-in bypass of an
// otherwise-blocking quota check. Gated behind the `allowPostpone` config
// flag (see lib/config.js) — this module only manages the on-disk timer
// state; the flag gate itself is enforced by callers (bin/cli.js and
// quota-hard-stop.js), not here.
//
// State is a single JSON file: { until: <epoch ms> }. Global scope only
// (not per-provider/window) — postponing is a deliberate, whole-machine
// risk acceptance, not a per-provider setting.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { configDirGlobal } from "./config.js";

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
export const DEFAULT_POSTPONE_MINUTES = 30;

export function postponePath() {
  return join(configDirGlobal(), "postpone.json");
}

// Clamp to a safe, bounded range. Non-finite/non-positive input falls back
// to DEFAULT_POSTPONE_MINUTES (mirrors lib/config.js's "invalid -> safe
// default" coercion philosophy) rather than silently doing nothing.
export function clampMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return DEFAULT_POSTPONE_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
}

export function readPostpone() {
  const path = postponePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || !Number.isFinite(raw.until)) return null;
    return { until: raw.until };
  } catch {
    return null;
  }
}

export function writePostpone(minutes = DEFAULT_POSTPONE_MINUTES) {
  const clamped = clampMinutes(minutes);
  const until = Date.now() + clamped * 60000;
  const path = postponePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ until }, null, 2) + "\n", "utf8");
  return { until, minutes: clamped };
}

export function clearPostpone() {
  const path = postponePath();
  if (existsSync(path)) rmSync(path, { force: true });
}

export function isPostponeActive(now = Date.now()) {
  const entry = readPostpone();
  return Boolean(entry && entry.until > now);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/postpone.test.js`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/postpone.js test/postpone.test.js
git commit -m "feat: add lib/postpone.js for fail-postpone timer state"
```

---

### Task 2: `lib/config.js` — `allowPostpone` config flag

**Files:**
- Modify: `lib/config.js:11-38` (header doc + DEFAULTS), `lib/config.js:52-67` (ENV_KEYS + BOOL_KEYS)
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.js` (after the existing `blockOnAuthError coercion and env override` test, around line 157):

```javascript
test("allowPostpone default is false", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_ALLOW_POSTPONE: undefined }, () => {
    const { values, sources } = resolveConfig({ projectDir: proj });
    assert.equal(values.allowPostpone, false);
    assert.equal(sources.allowPostpone, "default");
  });
});

test("allowPostpone coercion and env override", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_ALLOW_POSTPONE: "1" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.allowPostpone, true);
  });
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_ALLOW_POSTPONE: "false" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.allowPostpone, false);
  });
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_ALLOW_POSTPONE: "maybe" }, () => {
    // invalid -> falls through to default (false)
    assert.equal(resolveConfig({ projectDir: proj }).values.allowPostpone, false);
  });
});

test("allowPostpone: precedence env > project > global > default", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "config.json"), JSON.stringify({ allowPostpone: true }));
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_ALLOW_POSTPONE: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.allowPostpone, true);
    assert.equal(r.sources.allowPostpone, "global");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `values.allowPostpone` is `undefined`, not `false` (key doesn't exist yet).

- [ ] **Step 3: Implement the config key**

In `lib/config.js`, update the header doc comment (after line 22, `staleBlockMarginPct`):

```javascript
//   staleBlockMarginPct  (OPENCODE_QUOTA_STALE_BLOCK_MARGIN) number
//   allowPostpone        (OPENCODE_QUOTA_ALLOW_POSTPONE)     boolean
```

Update `DEFAULTS` (lib/config.js:28-38):

```javascript
export const DEFAULTS = Object.freeze({
  minRemaining: 30,
  blockOnError: true,
  blockOnAuthError: false,
  cacheTtlMs: 60000,
  timeoutMs: 20000,
  window: "5h",
  minRefreshIntervalMs: 120000,
  rateLimitBackoffMs: 300000,
  staleBlockMarginPct: 10,
  allowPostpone: false,
});
```

Update `ENV_KEYS` (lib/config.js:52-64):

```javascript
const ENV_KEYS = {
  minRemaining: "OPENCODE_QUOTA_MIN_REMAINING",
  blockOnError: "OPENCODE_QUOTA_BLOCK_ON_ERROR",
  blockOnAuthError: "OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR",
  cacheTtlMs: "OPENCODE_QUOTA_CACHE_TTL_MS",
  timeoutMs: "OPENCODE_QUOTA_TIMEOUT_MS",
  window: "OPENCODE_QUOTA_WINDOW",
  windowAnthropic: "OPENCODE_QUOTA_WINDOW_ANTHROPIC",
  windowOpenai: "OPENCODE_QUOTA_WINDOW_OPENAI",
  minRefreshIntervalMs: "OPENCODE_QUOTA_MIN_REFRESH_MS",
  rateLimitBackoffMs: "OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS",
  staleBlockMarginPct: "OPENCODE_QUOTA_STALE_BLOCK_MARGIN",
  allowPostpone: "OPENCODE_QUOTA_ALLOW_POSTPONE",
};
```

Update `BOOL_KEYS` (lib/config.js:67):

```javascript
const BOOL_KEYS = new Set(["blockOnError", "blockOnAuthError", "allowPostpone"]);
```

No other changes needed in `lib/config.js` — `coerce()`, `resolveConfig()`, and `writeScope()` all iterate `ENV_KEYS`/`DEFAULTS` generically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS (all tests green, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat: add allowPostpone config flag"
```

---

### Task 3: `quota-hard-stop.js` — runtime bypass integration

**Depends on:** Task 1, Task 2 (imports `lib/postpone.js` and reads `cfg.allowPostpone`).

**Files:**
- Modify: `quota-hard-stop.js:20-23` (imports), `quota-hard-stop.js:135-167` (chat.params block logic)
- Test: `test/quota-hard-stop.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/quota-hard-stop.test.js` (add these imports near the top, alongside the existing ones):

```javascript
import { writePostpone, clearPostpone } from "../lib/postpone.js";
```

Add these test cases (anywhere after the existing tests in the file):

```javascript
test("active postpone suppresses an otherwise-blocking result when allowPostpone is enabled", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({
      minRemaining: 30,
      allowPostpone: true,
      cacheTtlMs: 100000,
      minRefreshIntervalMs: 100000,
    }),
  );

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5)); // below 30% threshold -> would block
      writePostpone(30);

      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.doesNotReject(() =>
        plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
      );
    });
  } finally {
    clearPostpone();
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("stale postpone file is ignored when allowPostpone is disabled (still blocks)", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({
      minRemaining: 30,
      allowPostpone: false,
      cacheTtlMs: 100000,
      minRefreshIntervalMs: 100000,
    }),
  );

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      writePostpone(30); // orphaned postpone state from when the flag was previously on

      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.rejects(
        () => plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
        /Blocked/,
      );
    });
  } finally {
    clearPostpone();
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("block message mentions the postpone hint only when allowPostpone is enabled", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({ minRemaining: 30, allowPostpone: true, cacheTtlMs: 100000, minRefreshIntervalMs: 100000 }),
  );
  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.rejects(
        () => plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
        /opencode-hard-limit postpone/,
      );
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("block message omits the postpone hint when allowPostpone is disabled (default)", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({ minRemaining: 30, cacheTtlMs: 100000, minRefreshIntervalMs: 100000 }),
  );
  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      const plugin = await QuotaHardStopPlugin({ directory: proj });
      try {
        await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
        assert.fail("expected chat.params to throw");
      } catch (err) {
        assert.doesNotMatch(err.message, /postpone/);
      }
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/quota-hard-stop.test.js`
Expected: FAIL — postpone has no effect yet (block still throws in the first test), and the message assertions fail (no "postpone" hint exists yet).

- [ ] **Step 3: Implement the bypass**

In `quota-hard-stop.js`, add the import (line 20-23 area):

```javascript
import { readWeekly, MONITORED_PROVIDERS, quotaCachePath } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { resolveQuotaProvider, evaluate } from "./lib/evaluate.js";
import { ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";
import { isPostponeActive } from "./lib/postpone.js";
```

Replace the block-handling section (`quota-hard-stop.js:135-167`), changing `const { block, reason }` to `let` and adding the bypass check plus the conditional hint:

```javascript
      let { block, reason } = evaluate(quotaProvider, res, cfg);

      if (block && cfg.allowPostpone && isPostponeActive()) {
        block = false;
        reason = "postponed";
      }

      if (block) {
        let blockMsg;
        if (reason === "below-threshold") {
          blockMsg =
            `quota ${res.remaining}% remaining is below the ${cfg.minRemaining}% threshold. ` +
            `Raise your budget: opencode-hard-limit set --threshold <lower> --global ` +
            `(or OPENCODE_QUOTA_MIN_REMAINING=<lower>).`;
        } else if (reason === "stale-failsafe") {
          const ageMin = Math.round((Date.now() - res.receivedAt) / 60000);
          blockMsg =
            `last known quota ${res.remaining}% is ${ageMin}min old and could not be refreshed` +
            `${res.backoffUntil ? " (usage endpoint rate-limited, retry ~" + new Date(res.backoffUntil).toLocaleTimeString() + ")" : ""}; ` +
            `it is within ${cfg.staleBlockMarginPct}% of your ${cfg.minRemaining}% threshold, so blocking as a precaution. ` +
            `Set OPENCODE_QUOTA_STALE_BLOCK_MARGIN=0 (or --stale-margin 0) to disable the stale fail-safe.`;
        } else if (reason === "unreadable") {
          blockMsg =
            `quota data is unreadable (percentRemaining missing). ` +
            `Set OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR=0 to allow calls when quota cannot be read.`;
        } else {
          const hr = humanReason(reason, reason);
          const isAuth = reason.startsWith("auth-error:");
          blockMsg = isAuth
            ? `quota could not be read (${hr}). ` +
              `Refresh your provider login or set OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR=0 to allow.`
            : `quota check failed (${hr}). ` +
              `Set OPENCODE_QUOTA_BLOCK_ON_ERROR=0 to allow when quota cannot be checked.`;
        }
        if (cfg.allowPostpone) {
          blockMsg +=
            ` To postpone this block for a while, run "!opencode-hard-limit postpone <minutes>" ` +
            `(shell mode, no LLM cost) — the number is how many minutes to postpone for, ` +
            `e.g. "!opencode-hard-limit postpone 60" postpones for 60 minutes (default 30 if omitted).`;
        }
        throw new Error(
          `[quota-hard-stop] Blocked ${providerId} (${quotaProvider}): ${blockMsg}`,
        );
      }
      // Otherwise allow silently — no toast/sound; the sidebar widget is the
      // only surface for quota state (including unreadable/fallback/postponed cases).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/quota-hard-stop.test.js`
Expected: PASS (all tests green, including the 4 new ones). Also re-run the full suite to confirm no regression: `node --test`

- [ ] **Step 5: Commit**

```bash
git add quota-hard-stop.js test/quota-hard-stop.test.js
git commit -m "feat: bypass quota block when fail-postpone is active"
```

---

### Task 4: `bin/cli.js` — `postpone` subcommand

**Depends on:** Task 1, Task 2.

**Files:**
- Modify: `bin/cli.js:14-21` (imports), `bin/cli.js:71-105` (buildPatch + SHARED_OPTIONS), `bin/cli.js:263-313` (showResolved + usage), `bin/cli.js:315-370` (main dispatch)
- Test: `test/cli-postpone.test.js` (new), `test/config.test.js` (one added CLI smoke test)

- [ ] **Step 1: Write the failing tests**

Create `test/cli-postpone.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveConfig } from "../lib/config.js";
import { isPostponeActive, readPostpone } from "../lib/postpone.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-cli-postpone-"));
  const xdg = join(root, "xdg");
  const proj = join(root, "proj");
  mkdirSync(proj, { recursive: true });
  return { root, xdg, proj };
}

function runCli(args, { cwd, xdg }) {
  return spawnSync(process.execPath, [join(process.cwd(), "bin", "cli.js"), ...args], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
    encoding: "utf8",
  });
}

test("postpone refuses to run when allowPostpone is disabled (default)", () => {
  const { xdg, proj } = sandbox();
  const result = runCli(["postpone", "30"], { cwd: proj, xdg });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled/i);
  assert.equal(isPostponeActive(), false);
});

test("postpone writes an active timer once allowPostpone is enabled", () => {
  const { xdg, proj } = sandbox();
  let result = runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(resolveConfig({ projectDir: proj }).values.allowPostpone, true);

  result = runCli(["postpone", "45"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /45 minute/);
  assert.equal(isPostponeActive(), true);
});

test("postpone defaults to 30 minutes when no argument is given", () => {
  const { xdg, proj } = sandbox();
  runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  const result = runCli(["postpone"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /30 minute/);
});

test("postpone --clear cancels an active postpone", () => {
  const { xdg, proj } = sandbox();
  runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  runCli(["postpone", "30"], { cwd: proj, xdg });
  assert.equal(isPostponeActive(), true);

  const result = runCli(["postpone", "--clear"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(isPostponeActive(), false);
  assert.equal(readPostpone(), null);
});

test("postpone rejects a non-numeric minutes argument", () => {
  const { xdg, proj } = sandbox();
  runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  const result = runCli(["postpone", "banana"], { cwd: proj, xdg });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid minutes/i);
});

test("get shows allowPostpone and postpone status", () => {
  const { xdg, proj } = sandbox();
  runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  runCli(["postpone", "30"], { cwd: proj, xdg });
  const result = runCli(["get"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /allowPostpone\s+= true/);
  assert.match(result.stdout, /Postpone: ACTIVE/);
});
```

Add one CLI smoke test to `test/config.test.js` (after the existing "CLI writes stale-margin to project config" test, matching its exact pattern):

```javascript
test("CLI writes allow-postpone to project config", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "cli.js"), "set", "--allow-postpone", "true", "--project"],
      {
        cwd: proj,
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.allowPostpone, true);
    assert.equal(r.sources.allowPostpone, "project");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli-postpone.test.js test/config.test.js`
Expected: FAIL — `postpone` is an unrecognized command (`fail("unknown command: postpone...")`), `--allow-postpone` flag doesn't exist yet.

- [ ] **Step 3: Implement the CLI subcommand**

In `bin/cli.js`, add the import (after the `lib/deploy.js` import block, line ~30):

```javascript
import {
  writePostpone,
  readPostpone,
  clearPostpone,
  isPostponeActive,
  DEFAULT_POSTPONE_MINUTES,
} from "../lib/postpone.js";
```

Add `--allow-postpone` to `SHARED_OPTIONS` (bin/cli.js:88-105), alongside the other string-valued boolean flags, plus a `clear` boolean flag for `postpone --clear`:

```javascript
const SHARED_OPTIONS = {
  global: { type: "boolean" },
  project: { type: "boolean" },
  threshold: { type: "string" },
  "min-remaining": { type: "string" },
  "block-on-error": { type: "string" },
  "block-on-auth-error": { type: "string" },
  "cache-ttl": { type: "string" },
  timeout: { type: "string" },
  "min-refresh": { type: "string" },
  "rate-limit-backoff": { type: "string" },
  "stale-margin": { type: "string" },
  window: { type: "string" },
  "window-anthropic": { type: "string" },
  "window-openai": { type: "string" },
  "allow-postpone": { type: "string" },
  clear: { type: "boolean" },
  install: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
```

Add to `buildPatch()` (bin/cli.js:71-86), after the `window-openai` line:

```javascript
  if (values["window-openai"] !== undefined) patch.windowOpenai = values["window-openai"];
  if (values["allow-postpone"] !== undefined) patch.allowPostpone = values["allow-postpone"];
  return patch;
```

Add a new `postponeCommand()` function, placed after `showResolved()` (before `usage()`, around bin/cli.js:281):

```javascript
function postponeCommand(values, positionals) {
  const cfg = resolveConfig({ projectDir: process.cwd() }).values;
  if (!cfg.allowPostpone) {
    fail(
      "postpone is disabled. Enable it first with: opencode-hard-limit set --allow-postpone true",
    );
  }

  if (values.clear) {
    clearPostpone();
    print("Postpone cleared. Quota blocks will apply immediately again.");
    return;
  }

  const rawMinutes = positionals[1];
  const minutes = rawMinutes === undefined ? DEFAULT_POSTPONE_MINUTES : Number(rawMinutes);
  if (rawMinutes !== undefined && !Number.isFinite(minutes)) {
    fail(`invalid minutes: "${rawMinutes}". Pass a number, e.g. "opencode-hard-limit postpone 60".`);
  }

  const { until, minutes: clamped } = writePostpone(minutes);
  print(
    `Quota block postponed for ${clamped} minute(s) (the number after "postpone" is minutes). ` +
      `Active until ${new Date(until).toLocaleTimeString()}.`,
  );
  print(`Cancel early with: opencode-hard-limit postpone --clear`);
}
```

Update `showResolved()` (bin/cli.js:263-280) to append postpone status after the precedence line:

```javascript
function showResolved() {
  const { values, sources, paths } = resolveConfig({ projectDir: process.cwd() });
  print("Effective configuration (highest-precedence source wins):");
  const allKeys = [...Object.keys(DEFAULTS), ...Object.values(PROVIDER_WINDOW_KEYS)];
  for (const key of allKeys) {
    if (Object.values(PROVIDER_WINDOW_KEYS).includes(key) && values[key] === undefined) {
      print(`  ${key.padEnd(17)} = ${values.window} (inherits window)`);
      continue;
    }
    print(`  ${key.padEnd(17)} = ${String(values[key]).padEnd(8)} (from ${sources[key]})`);
  }
  print("");
  print("Config files:");
  print(`  global : ${paths.global}${existsSync(paths.global) ? "" : "  (not created)"}`);
  print(`  project: ${paths.project}${existsSync(paths.project) ? "" : "  (not created)"}`);
  print("");
  print("Precedence: env var > project file > global file > default");

  if (values.allowPostpone) {
    const entry = readPostpone();
    print("");
    if (entry && entry.until > Date.now()) {
      const remainMin = Math.ceil((entry.until - Date.now()) / 60000);
      print(`Postpone: ACTIVE for ${remainMin} more min (until ${new Date(entry.until).toLocaleTimeString()})`);
    } else {
      print("Postpone: not active");
    }
  }
}
```

Update `usage()` (bin/cli.js:282-313) — add the `postpone` usage lines and the `--allow-postpone` setting description:

```javascript
function usage() {
  print(`opencode-hard-limit - weekly AI quota hard-stop for OpenCode

Usage:
  opencode-hard-limit init [--global|--project] [--threshold N] [--install]
  opencode-hard-limit set  --threshold N [--global|--project]
  opencode-hard-limit get
  opencode-hard-limit postpone [minutes]      postpone a block for N minutes (default ${DEFAULT_POSTPONE_MINUTES}; requires --allow-postpone)
  opencode-hard-limit postpone --clear        cancel an active postpone early
  opencode-hard-limit install
  opencode-hard-limit uninstall

Scope:
  --global    apply to all OpenCode projects (~/.config/opencode/opencode-hard-limit/config.json)
  --project   apply to the current directory only (./.opencode-hard-limit.json)
  (if omitted, you are asked interactively; global is recommended)

Settings (all optional except threshold for 'set'):
  --threshold N        % remaining required to allow a call (default ${DEFAULTS.minRemaining})
  --block-on-error b   block when quota can't be checked: true|false (default ${DEFAULTS.blockOnError})
  --cache-ttl ms       in-memory cache TTL (default ${DEFAULTS.cacheTtlMs})
  --timeout ms         quota CLI timeout (default ${DEFAULTS.timeoutMs})
  --min-refresh ms     minimum spacing between real quota fetches (default ${DEFAULTS.minRefreshIntervalMs})
  --rate-limit-backoff ms  extra cooldown after a 429/rate-limit (default ${DEFAULTS.rateLimitBackoffMs})
  --stale-margin pct   extra block margin while quota is blind/stale (default ${DEFAULTS.staleBlockMarginPct}; 0 disables)
  --window w           quota window to track: 5h | Weekly (default ${DEFAULTS.window})
  --window-anthropic w quota window for Claude only: 5h | Weekly (default: inherits --window)
  --window-openai w    quota window for OpenAI/Codex only: 5h | Weekly (default: inherits --window)
  --allow-postpone b   enable the "opencode-hard-limit postpone" bypass command: true|false (default ${DEFAULTS.allowPostpone})

Examples:
  opencode-hard-limit init --global --threshold 30 --install
  opencode-hard-limit set --threshold 30 --global
  opencode-hard-limit get
  opencode-hard-limit set --allow-postpone true --global
  opencode-hard-limit postpone 60`);
}
```

Update `main()` dispatch (bin/cli.js:315-370) — add the `postpone` command branch (place it after the `get`/`show` branch, before `install`):

```javascript
  if (cmd === "get" || cmd === "show") {
    showResolved();
    return;
  }

  if (cmd === "postpone") {
    postponeCommand(values, positionals);
    return;
  }

  if (cmd === "install") {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/cli-postpone.test.js test/config.test.js`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/cli-postpone.test.js test/config.test.js
git commit -m "feat: add postpone CLI subcommand"
```

---

### Task 5: `package.json` — ship `lib/postpone.js` in the npm tarball

**Depends on:** Task 1.

**Files:**
- Modify: `package.json:17-28` (`files` array)

- [ ] **Step 1: Add the file to the allowlist**

In `package.json`, update `files` (currently lines 17-28) to include the new module, right after `lib/evaluate.js`:

```json
  "files": [
    "quota-hard-stop.js",
    "quota-sidebar.tsx",
    "lib/config.js",
    "lib/deploy.js",
    "lib/quota.js",
    "lib/evaluate.js",
    "lib/postpone.js",
    "lib/reset.js",
    "bin/cli.js",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 2: Verify the tarball includes it**

Run: `npm pack --dry-run 2>&1 | grep postpone`
Expected: output includes a line for `lib/postpone.js` (confirms it will ship; per AGENTS.md this is the one gap between path-loading and a real published install).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: ship lib/postpone.js in the npm package"
```

---

### Task 6: `README.md` — document fail-postpone mode

**Depends on:** Task 3, Task 4 (needs the final command/flag names to document accurately).

**Files:**
- Modify: `README.md` — add a Settings table row inside `### Settings` (currently ends around line 259, right before `## Requirements` at line 260), and a new `## Fail-postpone mode` section immediately before `## Requirements`.

- [ ] **Step 1: Add the Settings table row**

In `README.md`, inside the `### Settings` table (the table containing the `--block-on-auth-error` row, around line 242), add a new row directly after it:

```markdown
| `--allow-postpone` | `OPENCODE_QUOTA_ALLOW_POSTPONE` | `allowPostpone` | `false` | Opt-in: enables the `opencode-hard-limit postpone` command to temporarily bypass an active block. See "Fail-postpone mode" below. |
```

(Match the exact column format/spacing already used by the surrounding rows in that table — read the table first to mirror its style precisely.)

- [ ] **Step 2: Add the new section**

Insert this new top-level section in `README.md` immediately before the `## Requirements` heading:

```markdown
## Fail-postpone mode

By default this plugin has two failure modes: **fail-closed** (`blockOnError: true` /
`blockOnAuthError: true` — block when quota can't be checked) and **fail-open**
(`blockOnError: false` / `blockOnAuthError: false` — allow when quota can't be
checked). There's a third, opt-in mode: **fail-postpone** — a manual, time-boxed
bypass of an otherwise-legitimate block, for when you've decided to accept the
risk of running over quota for a little while.

It's disabled by default. Enable it with:

```bash
opencode-hard-limit set --allow-postpone true --global
```

Once enabled, a block's error message includes a hint like:

```
[quota-hard-stop] Blocked anthropic (anthropic): quota 12% remaining is below
the 30% threshold. ... To postpone this block for a while, run
"!opencode-hard-limit postpone <minutes>" (shell mode, no LLM cost) — the
number is how many minutes to postpone for, e.g.
"!opencode-hard-limit postpone 60" postpones for 60 minutes (default 30 if
omitted).
```

Type that command directly in OpenCode's prompt (the leading `!` runs it as a
local shell command — no LLM call, no token cost):

```
!opencode-hard-limit postpone 60
```

This postpones **any** quota block (any provider, any window) for 60 minutes.
Cancel it early with:

```
!opencode-hard-limit postpone --clear
```

`opencode-hard-limit get` shows whether a postpone is currently active and how
much time is left. Postpone duration is clamped to 1–240 minutes. If
`--allow-postpone` is later disabled, any leftover postpone timer is ignored —
blocks resume immediately.
```

- [ ] **Step 3: Verify formatting**

Run: `node --eval "require('node:fs').readFileSync('README.md','utf8')"` (or simply re-read the file) and confirm the new section renders as valid Markdown (matching heading level `##`, code fences closed, table row aligned with neighboring rows).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document fail-postpone mode"
```

---

## Final Verification (after all tasks)

- [ ] Run the full test suite: `npm test`
  Expected: all tests pass, including every new test file/case added above.
- [ ] Run `npm pack --dry-run` once more and confirm `lib/postpone.js` and no stray files are present.
- [ ] Manually sanity-check the CLI end-to-end in a scratch dir:
  ```bash
  cd "$(mktemp -d)"
  node /path/to/opencode-hard-limit/bin/cli.js postpone 30      # should fail: disabled
  node /path/to/opencode-hard-limit/bin/cli.js set --allow-postpone true --project
  node /path/to/opencode-hard-limit/bin/cli.js postpone 30      # should succeed
  node /path/to/opencode-hard-limit/bin/cli.js get              # should show ACTIVE
  node /path/to/opencode-hard-limit/bin/cli.js postpone --clear
  node /path/to/opencode-hard-limit/bin/cli.js get              # should show not active
  ```
- [ ] Per this repo's commit policy (AGENTS.md): after `npm test` passes, bump `package.json` `version` (this is a user-facing feature — minor bump) as a final commit before considering the branch done.
