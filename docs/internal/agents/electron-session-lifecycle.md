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
keeps whatever size it was last given, so a test that resizes restores the
original content area when it finishes.
