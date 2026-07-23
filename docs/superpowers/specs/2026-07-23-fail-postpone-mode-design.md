# Fail-postpone mode: temporary quota-block override

**Status:** Approved
**Date:** 2026-07-23

## Problem

Today `quota-hard-stop.js` has two failure modes, controlled by
`blockOnError` / `blockOnAuthError`:

- **fail-closed** (default): unreadable/errored quota blocks the model call.
- **fail-open**: unreadable/errored quota is allowed through.

There is no way to temporarily bypass a *legitimate* block (quota genuinely
below `minRemaining`) without leaving OpenCode to edit config files, and no
way to do so with an explicit, time-boxed, auditable decision. The user wants
a third mode — **fail-postpone** — where a block can be manually and
temporarily suspended, but only if the user has explicitly opted in via a
config flag.

## Why not a synchronous in-chat prompt

Investigated via @librarian (4 sessions, see conversation record): OpenCode's
server-plugin `chat.params` hook has **no supported API** to open a blocking
dialog and await a user choice. `permission.ask` only mutates an
already-created permission decision; a genuine confirm/dialog API
(`api.ui.DialogConfirm`) exists only in the separate TUI-plugin runtime, not
reachable from a server plugin. This is confirmed by open feature request
[#5147](https://github.com/anomalyco/opencode/issues/5147).

OpenCode's TUI does support native shell-escape (`!some-command`, runs
locally, no LLM call/token cost — confirmed via official docs and TUI
source). This is the mechanism the design uses instead of an in-chat prompt.

## Design

### 1. New config flag: `allowPostpone`

Added to `lib/config.js` following the existing boolean-config pattern
(`blockOnError`/`blockOnAuthError`):

- `DEFAULTS.allowPostpone = false`
- `ENV_KEYS.allowPostpone = 'OPENCODE_QUOTA_ALLOW_POSTPONE'`
- Added to `BOOL_KEYS`
- New `bin/cli.js` flag: `--allow-postpone` (and `--no-allow-postpone` to
  unset), wired into `buildPatch()` for `set`/`init`, documented in
  `usage()`.

This flag gates the **entire feature**. If `false` (default), postpone is
unavailable end-to-end: the CLI refuses to write a postpone state, and
`chat.params` ignores any postpone state file even if one exists on disk
(defense in depth against stale state after the flag is turned off).

### 2. New module: `lib/postpone.js`

Mirrors the on-disk state pattern already used by `quotaCachePath()` in
`lib/quota.js` (state file under `configDirGlobal()`, atomic write via
tmp+rename):

```js
postponePath()                 // join(configDirGlobal(), 'postpone.json')
readPostpone()                 // -> { until: number } | null (swallows parse errors)
writePostpone(minutes)         // clamps minutes to 1..240, writes { until: Date.now() + minutes*60000 }
clearPostpone()                // deletes the state file if present
isPostponeActive(now = Date.now()) // -> boolean, reads state and checks now < until
```

Minutes clamp (1..240) mirrors the clamp style already used in
`lib/config.js` `coerce()` for other numeric knobs.

Scope is **global**, not per-provider/window — postponing is an explicit,
holistic "I accept the risk right now" action, not a per-provider tuning
knob. Per-provider scoping is an explicit non-goal (YAGNI) for this
iteration.

### 3. New CLI subcommand: `postpone`

`bin/cli.js` gets a new command branch:

```
opencode-hard-limit postpone [minutes]     # default 30 if omitted
opencode-hard-limit postpone --clear       # cancel an active postpone early
```

Behavior:

- Resolves config via existing `resolveConfig({projectDir: cwd()})`.
- If `values.allowPostpone !== true`: fails immediately with a clear message:
  `"Postpone está desabilitado. Habilite com: opencode-hard-limit set --allow-postpone"`
  — no state file is written.
- Otherwise calls `writePostpone(minutes)` and prints confirmation including
  **the resolved absolute expiry time** and **explicitly states the units**,
  e.g.:
  `Bloqueio adiado por 60 minutos (até HH:MM). Rode "opencode-hard-limit postpone --clear" para cancelar antes.`
- `--clear` calls `clearPostpone()` and prints confirmation (no-op message if
  nothing was active).
- `minutes` argument is parsed as an integer; non-numeric input fails with a
  usage hint.

`opencode-hard-limit get` (`showResolved()`) is extended to print the
`allowPostpone` value like any other resolved key, and — if `allowPostpone`
is true and a postpone is currently active — an extra line showing time
remaining.

### 4. Runtime integration in `quota-hard-stop.js`

After the existing `const {block, reason} = evaluate(quotaProvider, res, cfg)`
call, add:

```js
if (block && cfg.allowPostpone && isPostponeActive()) {
  // postponed overrides every block reason (below-threshold, stale-failsafe,
  // auth-error, etc.) — the user made an explicit, time-boxed decision.
  block = false
  reason = 'postponed'
}
```

The block-error-message builder (`blockMsg` construction) is extended: when
`cfg.allowPostpone === true` and the call is about to block, append a hint
to the thrown error message that:

- explicitly names the mechanism (`!opencode-hard-limit postpone <minutos>`,
  run in OpenCode's shell-escape mode — no LLM cost),
- **explicitly states the parameter is minutes** and gives the default,
  e.g.:
  `Para adiar o bloqueio por um tempo, rode: !opencode-hard-limit postpone 60 — o número é a quantidade de MINUTOS que o bloqueio fica suspenso (padrão: 30 min se omitido).`

When `cfg.allowPostpone === false` (default), the block message is
**unchanged** from today — no mention of postpone, since it is unavailable.

### 5. Testing

- `test/postpone.test.js` (new, mirrors existing `lib/*.test.js` style):
  write/read round-trip, `--clear` behavior, minutes clamp (0, 1, 240, 241,
  negative, non-integer), `isPostponeActive` true/false/expired-boundary
  cases.
- `quota-hard-stop.test.js`: integration case — construct a scenario that
  would block (e.g. `below-threshold`), enable `allowPostpone` in config,
  write an active postpone via `lib/postpone.js`, assert `chat.params` does
  **not** throw and resolves normally. Also assert that with
  `allowPostpone: false` an active (stale) postpone file is ignored and the
  call still blocks (defense-in-depth case).
- `bin/cli.js` smoke test (matching existing CLI test conventions, if any
  exist under `test/`) for `postpone` and `postpone --clear`, including the
  refusal path when `allowPostpone` is off.

### 6. Docs

`README.md` gets a new section (placed near the existing config-flags
documentation) explaining:

- what fail-postpone mode is and why it's opt-in,
- how to enable it (`opencode-hard-limit set --allow-postpone`),
- the `!opencode-hard-limit postpone [minutes]` shell-escape trick, with an
  explicit example and explanation that `minutes` is literally minutes,
- how to cancel early (`postpone --clear`),
- the security/intent framing: this is a manual, explicit, time-boxed risk
  acceptance — not a silent bypass — and is disabled by default.

## Explicitly out of scope (YAGNI)

- Per-provider/per-window postpone scoping.
- A persistent "default postpone minutes" config knob (CLI arg only).
- Any form of in-chat/synchronous dialog (confirmed infeasible for server
  plugins today).
- Sidebar UI changes to surface postpone state visually (can be a future
  iteration; not required for this feature to be useful).
