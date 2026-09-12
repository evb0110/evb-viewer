# Electron session lifecycle

Use one isolated session name for each agent or E2E run. A developer session
uses `default` unless it needs to coexist with another session. E2E helpers use
names beginning with `e2e-` and add the run id so parallel runs do not share
profiles or temporary files.

## Entry

Start a foreground session with:

```sh
pnpm electron:run --session <name> start
```

Use `startd` when the caller needs a detached session. The runner creates
`.devkit/sessions/<name>/`, records startup and process metadata, allocates an
Electron profile at
`.devkit/sessions/<name>/electron-user-data/`, and starts the Electron
automation app with that profile. Nuxt may be shared with another session.

When Electron first asks for an app temp directory, it creates a profile-scoped
namespace such as `/tmp/evb-viewer-u1000-<profile-hash>/`. The namespace has
mode 0700 and an `.evb-app-temp-owner.json` marker containing the namespace,
profile path, process id, and start time. Working copies, OCR scratch
directories, and other managed temporary data live below that namespace.

## Exit

The owner of a session must stop it through the same runner:

```sh
pnpm electron:run --session <name> stop
```

The normal stop asks the controller and Electron to exit, uses the verified
process identity fallback if needed, checks the profile again for surviving
Electron processes, then removes the session's app-temp namespace. It clears
the crash checkpoint and runtime metadata only after those checks succeed.
Failure artifacts such as logs and screenshots remain under the session
directory when a process stop is refused, so a later stop can retry safely.

The detached-start timeout and the controller's failed-start and signal paths
run the same startup cleanup. They kill recorded children and profile-matched
Electron children, then remove app temp only when the profile has no verified
Electron owner. If that ownership check cannot establish that the profile is
clear, the bytes stay in place.

## Recovery

Non-clean E2E restarts may set `preserveWorkspaceCheckpoint`. That marker keeps
the checkpoint and app-temp namespace while the old Electron process stops.
An Electron crash also keeps the namespace when
`workspace-checkpoint.json` remains, because it may reference a materialized
dirty working copy. The next start reuses that profile and recovery data. A
later explicit clean stop removes the checkpoint and namespace.

The app startup stale scan is deliberately conservative. It removes a
namespace only when all of these are true:

- the name belongs to the current user and is not the current namespace;
- the owner marker parses and names that exact namespace;
- the marker's process is no longer alive; and
- the profile has no `workspace-checkpoint.json`; and
- the recorded age exceeds the stale limit.

Missing or malformed markers are retained. A root directory timestamp cannot
prove that nested PDF data is unused, especially for namespaces made by older
EVB versions. A checkpoint also retains a valid owned namespace for later
working-copy recovery. An explicit E2E recovery prune may remove an old `e2e-*`
namespace only after checking for workspace recovery evidence and scanning the
profile for the exact automation Electron identity, even when session metadata
is missing or stale. It refuses the removal if a matching process survives.

## Native test scratch

The native multi-GiB PDF tests use separate `/tmp/evb-pdf-page-ops-*` files and
an RAII cleanup guard. That guard handles normal completion and panic unwinding,
but a process killed during ENOSPC or host shutdown can leave files behind.
The Electron namespace lifecycle does not cover those files. Run those tests
with the native scratch path in mind and remove only exact stale test files
after confirming no native test process owns them.
