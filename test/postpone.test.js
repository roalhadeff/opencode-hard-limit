import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
    mkdirSync(dirname(postponePath()), { recursive: true });
    writeFileSync(postponePath(), JSON.stringify({ nope: true }), "utf8");
    assert.equal(readPostpone(), null);
  });
});
