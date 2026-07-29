# CLI PATH registration

## Goal

When OpenCode loads `opencode-hard-limit` from npm, the package CLI must also
be globally available as `opencode-hard-limit` so the plugin's block message is
immediately actionable from OpenCode shell mode.

## Design

`lib/deploy.js` will export `ensureCliInstalled()`. At plugin startup it will:

1. Determine the installed package version from the package's `package.json`.
2. Start `npm install --global opencode-hard-limit@<version>` as a
   detached, best-effort process.

The npm install is idempotent and reconciles the installed version; a
process-level guard prevents duplicate startup processes. The function never
throws and must not delay or affect quota checks. `quota-hard-stop.js` invokes
it alongside the existing sidebar self-heal deployment.

## Failure handling

Absent npm, permission failures, and child-process errors are swallowed. The
plugin remains operational; only the convenience CLI registration is deferred
until a future startup succeeds.

## Verification

Tests will prove that the helper skips a matching global CLI, starts the exact
versioned global npm install when missing or outdated, and contains failures.
The full Node test suite will pass afterward.
