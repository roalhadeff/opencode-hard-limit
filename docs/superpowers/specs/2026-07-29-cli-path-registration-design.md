# CLI PATH registration

## Goal

When OpenCode loads `opencode-hard-limit` from npm, the package CLI must also
be globally available as `opencode-hard-limit` so the plugin's block message is
immediately actionable from OpenCode shell mode.

## Design

`lib/deploy.js` will export `ensureCliInstalled()`. At plugin startup it will:

1. Determine the installed package version from the package's `package.json`.
2. Check the globally available CLI version, if any.
3. Do nothing if that version matches the plugin package version.
4. Otherwise start `npm install --global opencode-hard-limit@<version>` as a
   detached, best-effort process.

The function is process-idempotent and never throws. It must not delay or
affect quota checks. `quota-hard-stop.js` invokes it alongside the existing
sidebar self-heal deployment.

## Failure handling

Absent npm, permission failures, and child-process errors are swallowed. The
plugin remains operational; only the convenience CLI registration is deferred
until a future startup succeeds.

## Verification

Tests will prove that the helper skips a matching global CLI, starts the exact
versioned global npm install when missing or outdated, and contains failures.
The full Node test suite will pass afterward.
