# Project 8 process-proof fixture

This fixture is a local Linux proof for issues #402 and #404. It starts a
synthetic worker, a detached native-parent process, and a marker-controlled
native descendant. The worker and native parent exit only after their explicit
release markers appear. The descendant keeps a task-owned file open and stays
alive after both parent exits.

The diagnostics harness records each process PID, `/proc` start time, command,
executable, parent PID, and process-group ID. It refuses a stale start-time
identity, then calls the existing PID-based process-tree helper. The helper
must prove that the descendant and its process group are gone before the
harness removes the temporary fixture root.

Run the bounded local reproduction on Linux with:

```bash
pnpm exec tsx scripts/diagnostics/project8-process-proof/runProject8ProcessProof.ts
```

The command creates one `evb-project8-process-proof-*` directory below the
system temporary directory and removes it after the proof. If a process cannot
be matched to its recorded task-owned identity, cleanup leaves the directory
in place and reports the refusal instead of killing an unrelated process.
