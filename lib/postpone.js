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
