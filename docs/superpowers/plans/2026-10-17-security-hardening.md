# Pi delegate security hardening implementation plan

> For agentic workers: use subagent-driven-development for independently owned changes and requesting-code-review before integration. Steps use checkboxes for evidence.

Goal: fix the verified security findings in the owner's mpisat fork, exercise both subscriptions through its actual MCP entrypoint, and deliver verified commits to fork/main.

Architecture: preserve the existing in-process Pi worker and MCP tools. Add a server-owned canonical workspace root, guard the existing file tools at execution, load instructions without running untrusted project configuration, and require an administrator opt-in for extensions. Keep shell/extensions explicitly privileged and describe the limits honestly.

Tech stack: Node.js, TypeScript, current official Pi SDK, MCP TypeScript SDK, existing Node assertion tests and a loopback synthetic model server.

Snapshot: aff965a6ea38c315d8310099eb6466773d36615a; implementation branch security-hardening; worktree /tmp/pi-delegate-mcp-fix-20261017. Tracked baseline clean; original audit checkout retains its separate untracked probe. Delivery branch: mpisat/pi-delegate-mcp main. No upstream PR, npm publication or Claude Code configuration is authorized by this plan.

Evidence: the source README says tools are read-only by default, enabledModels is enforced, and delegates read AGENTS.md/CLAUDE.md. The audit's actual MCP probes demonstrated out-of-root reads reaching a fake provider, caller-triggered extension JavaScript, omitted-model scope bypass, absent instructions, unpropagated cancellation and raw terminal controls. There is no PRD or older product spec in the repository. The owner explicitly authorized fixing these issues and creating/pushing the mpisat fork.

## Chunk 1: Fix and deliver the bounded findings

### Task 1: Workspace, resources and dependency compatibility

Files: package.json, npm-shrinkwrap.json, .github/workflows/release.yml, src/config.ts, src/permissions.ts, src/registry.ts, src/pi/worker.ts, src/tools/spawn.ts, src/tools/init.ts, src/tools/models.ts, new src/pi/workspace.ts, new src/pi/resources.ts if needed, test/integration.mjs, new test/security.mjs, new test/security-helpers.mjs, README.md.

- [x] Extend the real stdio MCP/local fake-provider harness with allowed inside reads and denied parent, absolute, symlink-file, symlink-directory and cwd escapes. Assert the synthetic canary never reaches the provider, and denial has a specific workspace-policy reason. Include read, grep, find and ls paths. Keep SDK behavior behind the actual session/tool execution boundary.
- [x] Add tests asserting project AGENTS.md/CLAUDE.md reaches prompts with extensions false, while project executable configuration and symlinked context outside the root do not load. Reject extensions true by default before any JavaScript runs, and positively test the separately enabled privileged extension path.
- [x] Run these tests against the original code and record each intended failing assertion. Use independent test cases so the first failure does not hide later findings.
- [x] Implement a canonical root fixed by server configuration/startup cwd, not by per-call input. Validate requested cwd beneath it and enforce containment on the real file operations. Resolve symlinks and reject cross-root targets. Guard non-regular file reads and search traversal. Document remaining concurrent filesystem mutation limits; do not claim an OS sandbox.
- [x] Apply cwd and extension validation before init/models scope reads and before spawning any task. Prevalidate every merged spawn_batch request before starting the batch; test mixed valid/invalid cwd and extension requests yield zero sessions and zero provider calls.
- [x] Load project instructions deliberately within the root, preserve global agent instructions as trusted configuration, and prevent project settings/packages/MCP/extensions from executing during normal resource loading. Extensions remain an explicit server-side privileged opt-in, additionally selected per call.
- [x] Pin current Pi 1.3.0 and patched dependencies, regenerate the lockfile with install scripts disabled, adapt to public SDK interfaces, and run npm audit and the complete offline suite. A dependency upgrade must not re-enable built-in MCP/codemode or bypass the literal tool allowlist.

Commands: npm run build; node --test test/security.mjs; npm run test:ci; npm audit --json. RED must be an assertion on the actual leak/execution, GREEN all assertions passing and no reported dependency advisories.

### Task 2: Model selection and status-line safety

Files: src/pi/models.ts, src/pi/worker.ts only if coordinated with Task 1 owner, src/statusline/render.ts, new test/model-security.mjs and/or cases in test/security.mjs, new test/statusline-security.mjs, README.md.

- [x] Test explicit allowed/denied models and omitted-model defaults through actual MCP requests. A disallowed configured default must be rejected before a provider request, including strict scope. An allowed default must resolve and report the actual provider/model, not a placeholder.
- [x] Test plain labels remain useful and C0/C1 terminal controls, OSC and escape sequences never pass through the actual statusline CLI. Capture output as bytes without rendering controls.
- [x] Observe each failing assertion against original code, implement the smallest fixes, and rerun the cases. Preserve existing custom-provider scope behavior except the verified omitted-model hole.

Commands: npm run build; node --test test/model-security.mjs test/statusline-security.mjs; npm run test:ci. Record specific RED/GREEN evidence.

### Task 3: Cancellation, real providers and delivery

Files: src/tools/spawn.ts, src/registry.ts, src/pi/worker.ts, test/security.mjs, new test/security-helpers.mjs, new test/cancellation.mjs, new test/lifecycle.mjs, package.json test:ci, new test/live.mjs, README.md, this plan.

- [x] Add a real MCP cancellation test for run: reject the caller with the cancellation reason and observe the worker becomes aborted; positively assert ordinary completion still returns its result. Include cancellation during startup, after tool/model activity, and cleanup of listeners. Confirm spawn remains independent after its successful immediate response.
- [x] Observe RED, wire request AbortSignal through startup and the blocking run lifecycle, clean up listeners on every exit, and verify GREEN without swallowing construction/cancellation failures or disposing active work prematurely.
- [x] Review the implementation against the seven findings and execution boundaries, then correct all verified review concerns. Rerun build, full offline security tests, npm audit, and git diff --check on the final combined tree.
- [x] Run minimal actual MCP tasks through both existing subscriptions in disposable projects: verify a read-based answer, retained-context follow-up, and negative path guards; no real project content or secrets in prompts/logs. If testing privileged write tools, use only disposable fixture files and explicit server permissions.
- [x] Update README with the fork's actual defaults and safe installation/launch, verified model names, explicit model selection, cancellation semantics, privilege opt-ins and isolation limits. Do not record provider keys or private machine-specific auth paths.
- [ ] Fetch fork/main immediately before integration, integrate intended commits without rewriting shared history, rerun required checks on the integrated tree, push fork/main, and verify remote main contains the final commit. No completion claim while work is only on the implementation branch.

Commands: npm run test:ci; npm audit --json; git diff --check; node test/live.mjs if added as an explicitly opt-in script; git fetch fork main; git push fork HEAD:main; git ls-remote fork refs/heads/main. Preserve test logs outside the repository if they contain machine metadata; never commit credentials.


## Verification evidence before integration

- Original-behavior failures: `/tmp/pi-fix-security-red.log`, `/tmp/pi-fix-cancellation-red.log`, `/tmp/pi-model-status-red.log`.
- Additional review regressions observed failing on their causes before fixes: `/tmp/pi-fix-review-red.log` (Unicode normalization, literal tool selectors, non-regular settings), `/tmp/pi-model-selection-symlink-red.log` (Pi default ordering and project-settings links), `/tmp/pi-fix-global-instructions-red.log` (trusted global instruction links).
- Combined offline suite: `/tmp/pi-fix-reviewed-ci.log`, 60 tests passed, plus existing regression/integration scripts and the 12-tool stdio handshake.
- Corrected live MCP acceptance: `/tmp/pi-fork-live-results.json`. Both `opencode-go/deepseek-v4.1-flash` and `commandcode/deepseek/deepseek-v4.1-flash` read the disposable fixture, recalled its value without that answer in the follow-up prompt or further tool calls, and rejected shell/outside-root requests.
- Dependency advisory check: `/tmp/pi-fork-dependency-audit.json`, zero reported vulnerabilities. No configured provider credential values were found in repository files.
- Final integration and remote containment evidence will be recorded in the delivery report after pushing. Claude Code remains disconnected.

- Installed-package verification detected transitive dependency drift when npm omitted the repository lockfile from the archive. Converted the unchanged lock data to the publishable npm shrinkwrap format for the installed CLI. The archive allowlist and packaging test explicitly require the lock. Fresh npm 11 local archive installs still resolved newer transitive versions despite its inclusion, so the README applies the lock with npm ci inside the installed CLI after archive installation.
