# Workspace hygiene

- A worktree exists while its branch is being written and reviewed. Whoever lands
  the branch removes the worktree in the same step (`git worktree remove`, after
  checking it is clean and no process runs from it). `pnpm worktrees:prune` lists
  registered worktrees with a verdict for each.
- Do not create a worktree for review or diagnosis; `git show`, `git diff` and
  `gh pr diff` answer those.
- Run `cargo build` or `cargo test` only when the task touches `native/`, always
  with `--manifest-path native/Cargo.toml`. When native work is done or free disk
  drops below about 50 GiB, run `cargo clean --profile dev --manifest-path
  native/Cargo.toml`. Leave `native/target/release` alone.
- Never copy `node_modules` between worktrees; run pnpm in the checkout that uses
  it.
- Stop every `electron:run` session you started (`pnpm electron:run -s <name>
  stop`) and verify its processes exited. Preserve the user's `default` session
  and other tasks' sessions.
- `.devkit` holds task scratch and evidence. Delete downloads, probe output,
  benchmark scratch and temp directories when the task that made them ends. Keep
  one copy of a large fixture only if a test or script reads it by name.
