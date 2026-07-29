# CLI PATH Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically register the installed plugin version's CLI globally so `opencode-hard-limit` is available in OpenCode shell mode.

**Architecture:** Extend the existing deployment module with a best-effort, process-idempotent CLI installer. It reads the installed package version, starts a detached `npm install --global opencode-hard-limit@<version>`, and never throws. The plugin calls this helper through a test-replaceable module reference during startup alongside sidebar deployment.

**Tech Stack:** Node.js ESM, `node:child_process`, `node:test`, `node:assert/strict`.

---

### Task 1: Add a failing test for global CLI registration

**Files:**
- Modify: `test/deploy.test.js:13, 325`
- Modify: `lib/deploy.js:13-30, 174-189`

- [ ] **Step 1: Write the failing test**

Add `ensureCliInstalled` to the `lib/deploy.js` import, add `writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "opencode-hard-limit", version: "9.8.7" }))` to `fakePkgRoot`, then append:

```js
test("ensureCliInstalled: starts a detached npm install for the package version", () => {
  const { root } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  const calls = [];
  const child = { on() {}, unref() {} };

  ensureCliInstalled({
    pkgRoot: pkg,
    spawnProcess(...args) {
      calls.push(args);
      return child;
    },
  });

  assert.deepEqual(calls, [[
    "npm",
    ["install", "--global", "opencode-hard-limit@9.8.7"],
    { stdio: "ignore", detached: true },
  ]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deploy.test.js`

Expected: FAIL because `ensureCliInstalled` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `lib/deploy.js`, add `let cliInstallStarted = false;` and export the helper:

```js
export function ensureCliInstalled({ pkgRoot = DEFAULT_PKG_ROOT, spawnProcess = spawn } = {}) {
  if (cliInstallStarted) return false;
  try {
    const { version } = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    if (typeof version !== "string" || !version) return false;
    cliInstallStarted = true;
    const child = spawnProcess("npm", ["install", "--global", `opencode-hard-limit@${version}`], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deploy.test.js`

Expected: PASS, including the new CLI-installer test.

- [ ] **Step 5: Commit**

```bash
git add lib/deploy.js test/deploy.test.js
git commit -m "feat: register CLI globally from plugin"
```

### Task 2: Invoke the CLI installer from the plugin

**Files:**
- Modify: `quota-hard-stop.js:23, 102-107`
- Test: `test/quota-hard-stop.test.js`
- Modify: `README.md:35-57`
- Modify: `package.json:3`

- [ ] **Step 1: Write the failing test**

After `const { __test__ } = QuotaHardStopPlugin;`, disable real global npm work for this test file and append a focused startup test:

```js
__test__.setCliInstaller(() => {});

test("plugin initialization invokes the CLI installer", async () => {
  let calls = 0;
  __test__.setCliInstaller(() => { calls += 1; });
  await QuotaHardStopPlugin({ directory: process.cwd() });
  __test__.setCliInstaller(() => {});

  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quota-hard-stop.test.js`

Expected: FAIL because `setCliInstaller` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Change the deployment import and add a replaceable installer after `let quotaReader = readWeekly;`:

```js
import { ensureCliInstalled, ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";

let cliInstaller = ensureCliInstalled;

// Self-heal: ensure the deployed sidebar and globally callable CLI match the installed npm version.
ensureTuiDeployed();
cliInstaller();
```

Add these members to `QuotaHardStopPlugin.__test__`:

```js
setCliInstaller(fn) {
  cliInstaller = typeof fn === "function" ? fn : ensureCliInstalled;
},
resetCliInstaller() {
  cliInstaller = ensureCliInstalled;
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quota-hard-stop.test.js`

Expected: PASS.

- [ ] **Step 5: Document and version the behavior**

Update the installation explanation in `README.md` to state that plugin startup installs the matching published CLI globally for the `opencode-hard-limit postpone` shell command. Change `package.json` version from `0.14.3` to `0.15.0`.

- [ ] **Step 6: Run complete verification**

Run: `npm test && npm pack --dry-run`

Expected: all tests pass and the tarball includes `lib/deploy.js`, `quota-hard-stop.js`, and `bin/cli.js`.

- [ ] **Step 7: Commit**

```bash
git add quota-hard-stop.js test/quota-hard-stop.test.js README.md package.json
git commit -m "feat: install CLI when plugin starts"
```
