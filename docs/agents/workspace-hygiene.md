# Workspace hygiene for agents

An audit on 2026-09-01 found 95 GiB of repo-related disk on one machine:
19 finished ticket worktrees (49 GiB, each carrying its own Rust `target/`
and a checkout of the 0.8 GiB tesseract models), a 14 GiB `native/target/debug`,
and 32 per-run copies of `Electron.app` under `.devkit/tmp` (8.6 GiB) that no
prune step ever touched. The rules below are the fix. They bind every agent
that works in this repository, including orchestrators that drive other agents.

## Worktrees live exactly as long as their ticket

- A worktree exists to hold one branch while it is being written and reviewed.
  Once that branch is merged, the worktree has no owner and must go.
- Whoever performs the merge removes the worktree in the same step. For an
  integration branch, the orchestrator runs this right after each merge:

  ```sh
  pnpm worktrees:prune --into=origin/<integration-branch>
  pnpm worktrees:prune --into=origin/<integration-branch> \
    --target=/absolute/path/to/completed-worktree \
    --completed=/absolute/path/to/completion-receipt.json --apply
  ```

  The first call is a dry run that prints every registered worktree with its
  verdict. Apply names one completed worktree and a JSON receipt with
  `status: "completed"`, `taskKey`, `worktreePath`, and its exact 40-character
  `head`. The script rechecks the receipt, clean state, registration identity,
  and live process/session ownership immediately before non-force removal.
  A live owner, or an owner probe that cannot inspect a process running as the
  current agent user, keeps the target. It never deletes branches,
  the primary checkout, dirty trees, or the tree containing the current directory.
  A target whose directory is already missing follows a separate stale-registration
  path. It remains registered when Git cannot provide a narrowly scoped,
  metadata-only removal, rather than risking deletion of a reappeared directory.
- Worktrees created outside the checkout, such as
  `/home/ubuntu/agent-worktrees/<key>`, follow the same lifecycle. The creator
  records the task owner and removes the worktree after completion with the
  helper that created it. T3 thread deletion or settlement does not remove a
  linked Git worktree, so the owning agent or orchestrator must perform that
  cleanup explicitly while the completion evidence is still available.
- Do not create a worktree for review, diagnosis, or a read-only look at a
  branch. `git show`, `git diff`, and `gh pr diff` answer those without a
  checkout.
- Do not run `cargo build` or `cargo test` in a worktree unless the ticket
  touches `native/`. A debug build of the workspace costs several GiB per tree.
- Never copy `node_modules` between worktrees. Run pnpm from the checkout that
  will use the dependencies, and verify its package links resolve under that
  checkout's own `node_modules/.pnpm`. A worktree removal must not be able to
  break dependency resolution in the primary checkout.

## Electron automation

- The complete entry, exit, failed-start, interruption, and recovery contract
  is in [Electron session lifecycle](electron-session-lifecycle.md). Follow it
  when starting an agent or E2E session so app-temp namespaces have a known
  owner and a matching teardown path.
- Before launch, follow [Hidden Electron automation](hidden-electron-automation.md),
  including packaged tests. Runtime hiding cannot prevent macOS Dock registration.
- The hidden macOS launcher bundle is shared per installed Electron version at
  `.devkit/tmp/electron-e2e-hidden-app/electron-<version>/` and is created with
  an APFS clone, so it costs kilobytes, not 280 MiB. Every launch removes the
  bundle directories of other versions and legacy per-run copies. The launcher
  owns that directory: anything else placed under it is deleted on the next
  launch, so keep investigation output elsewhere in `.devkit`. Do not add
  per-run or per-session copies of development Electron. Packaged automation
  uses one run-owned APFS copy of its exact artifact through the shared packaged
  launcher. Remove that copy after its process tree exits; retain only reports
  and profiles needed for evidence.
- Stop every `electron:run` session in the stage that created it
  (`pnpm electron:run -s <name> stop`). At a stage boundary, verify that the
  stage's owned processes have exited. Preserve the user's default dev session
  and other tasks' active sessions. The e2e
  global setup prunes `e2e-*` sessions older than 24 hours; it does not touch
  the `default` session or anything a live process still owns.

## Rust targets

- `native/target/debug` grows without bound under `cargo test` and clippy. When
  a task is done with native work, or when free disk drops below roughly
  50 GiB, run `cargo clean --profile dev --manifest-path native/Cargo.toml`.
  Release artifacts under `native/target/release` are what the app and CI
  parity checks use; leave them unless a full rebuild is intended.
- Never build inside a crate directory (`native/<crate>/target`); always use
  `--manifest-path native/Cargo.toml` so there is one target directory.

## `.devkit` stays bounded

- Large PDFs are fixtures only if a test or script reads them by name. Keep one
  copy of each; intermediates made while assembling a fixture are deleted once
  the fixture exists.
- Downloaded CI artifacts, probe outputs, benchmark scratch, and `mktemp`-style
  directories are removed at the end of the task that made them.
- `.devkit/analysis/` holds Markdown findings, not payloads. Move or delete
  anything larger than a few MiB once the note that cites it is written.
