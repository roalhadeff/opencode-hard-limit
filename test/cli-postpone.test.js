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

// isPostponeActive()/readPostpone() resolve their path from the CURRENT
// process's XDG_CONFIG_HOME, whereas runCli() only sets it for the spawned
// subprocess. To inspect the timer state the CLI subprocess wrote into the
// sandbox, temporarily mirror the same XDG_CONFIG_HOME in this process too.
function withXdg(xdg, fn) {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

test("postpone refuses to run when allowPostpone is disabled (default)", () => {
  const { xdg, proj } = sandbox();
  const result = runCli(["postpone", "30"], { cwd: proj, xdg });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled/i);
  withXdg(xdg, () => assert.equal(isPostponeActive(), false));
});

test("postpone writes an active timer once allowPostpone is enabled", () => {
  const { xdg, proj } = sandbox();
  let result = runCli(["set", "--allow-postpone", "true", "--project"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(resolveConfig({ projectDir: proj }).values.allowPostpone, true);

  result = runCli(["postpone", "45"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /45 minute/);
  withXdg(xdg, () => assert.equal(isPostponeActive(), true));
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
  withXdg(xdg, () => assert.equal(isPostponeActive(), true));

  const result = runCli(["postpone", "--clear"], { cwd: proj, xdg });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  withXdg(xdg, () => {
    assert.equal(isPostponeActive(), false);
    assert.equal(readPostpone(), null);
  });
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
