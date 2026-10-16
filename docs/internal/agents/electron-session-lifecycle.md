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
namespace in a folder that survives a reboot. A person's app uses
`$XDG_STATE_HOME` or `~/.local/state` on Linux, `~/Library/Application Support`
on macOS and `%LOCALAPPDATA%` on Windows, each with an `evb-viewer-state`
folder. Every automation launch sets `EVB_APP_STATE_DIR` to a task-owned
folder: a session or E2E run uses `.devkit/sessions/<name>/app-state/`, a
packaged run `<work-directory>/app-state/`, and unit tests the OS temp folder.
A launch that sets only `EVB_AUTOMATION_USER_DATA_DIR` keeps the folder inside
that profile (`<profile>/evb-viewer-state`). No automation run reads, writes or
sweeps the person's folder. Releases before
2026-10 kept the namespace in the OS temp folder, which startup still reads
and then sweeps. The namespace has mode 0700 and an
`.evb-app-temp-owner.json` marker containing the namespace, profile path,
process id, and start time. Working copies with their save journals, export
recovery records, OCR scratch directories, and other managed data live below
that namespace.

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

## Window size

Two session commands change size and they are not interchangeable:

```sh
pnpm electron:run --session <name> windowResize 600 668
pnpm electron:run --session <name> emulateViewport 1280 820
```

`windowResize` resizes the real window so its content area becomes the
requested size, compensating for the native frame, and fails when the window
does not reach it. It works for a hidden window. `emulateViewport` only changes
the metrics the renderer reports; the native window does not move, so it cannot
reproduce a layout defect a person causes by dragging a window edge. A session
keeps whatever size it was last given. E2E sessions start at the canonical
content area and the reset between tests returns to it, clearing viewport
emulation too; see
[hidden automation](hidden-electron-automation.md#what-an-e2e-renderer-sees).
