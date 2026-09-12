# Hidden Electron automation

## Development target

For feature debugging or UI acceptance, use the running Electron dev app from
the current checkout. Identify it through the current
`.devkit/sessions/<session>/session.json`, then attach to that session's exact
Electron PID, profile, and CDP port. A generic `Electron` app-name match is not
enough because packaged and stale automation apps can use the same identity.

`/Applications/EVB Viewer.app` is the installed packaged app, not the default
development target. Use it only when the task explicitly covers packaged or
release behavior. Keep that scope separate from source and dev-app acceptance.

The display name `Electron`, bundle ID `com.github.Electron`, and foreground
window are not target identifiers. Never pass them to Computer Use. Pass only
the full app path reported for the resolved session. Use that app binding for
visual state and accessibility checks, then use the session CDP endpoint for
clicks, typing, key presses, menu traversal, and loops. If the resolver is not
ready, or the accessibility result shows more than the target window, stop and
report the ambiguous session instead of choosing a visible Electron window.
If the resolver reports only the shared `node_modules` Electron runtime path,
Computer Use has no safe target; use the session CDP endpoint without opening an
app by name.

On the user's Mac, all agent-owned Electron runs must start without a window,
focus change, or Dock icon. This includes packaged smoke tests and ad hoc CDP
probes. `app.dock.hide()` and `app.setActivationPolicy('accessory')` run after
macOS registers the app, so environment flags alone cannot prevent a Dock flash.

Development automation uses `electronRunLaunchConfig.ts`. Hidden or no-focus
macOS launches require its copied bundle with boolean `LSUIElement=true`.
The launcher verifies that value before every launch, including cached bundles.
If preparation or verification fails, stop and fix the harness. Do not retry
through stock Electron, a direct original app executable, or raw `open -a`.

## Packaged runs

Use the shared runner with an unused task-owned directory and a free CDP port:

```bash
node --import tsx scripts/release/runPackagedAutomation.ts \
  --executable '/path/to/EVB Viewer.app/Contents/MacOS/EVB Viewer' \
  --work-directory .devkit/reports/my-task/run-1 \
  -- --remote-debugging-port=62859
```

Keep the runner attached until the test finishes. Close the app through CDP,
or send SIGTERM to this runner's exact PID. The runner forwards termination to
its own child tree and removes the copied bundle after exit. It retains the
task's profile for evidence or a later reopen. Choose a different directory for
concurrent runs. Never use the default dev session or the user's normal profile.

Scripts with their own process lifecycle use `preparePackagedAutomationLaunch`
from `scripts/release/preparePackagedAutomationLaunch.ts`, then spawn its returned
`executablePath` with its returned `env`. Remove its `bundleDirectory` after the
owned process tree exits. The helper removes inherited `ELECTRON_RUN_AS_NODE`,
forces hidden/no-focus settings, and prepares a unique APFS clone on macOS.
Never replace the returned path or environment with the original inputs.

The original package remains unchanged. The automation copy has modified
launch metadata, so report original artifact identity and copied launch path
separately. A hidden copy tests packaged application behavior. It does not prove
the original signature, Gatekeeper startup, Dock registration, or activation.
The `LSUIElement` edit breaks a Developer ID seal and macOS kills such an app
about two seconds after launch, so the preparer re-signs the copy ad hoc without
the hardened runtime; the original bundle is never touched.

## Visible acceptance and ownership

Dock reactivation and production LaunchServices tests have visible assertions.
Run them on an isolated hosted CI runner. On this Mac they require the user's
explicit request for that visible run and the documented production-identity
opt-in. Setting `CI=true` locally does not authorize or isolate a visible run.
Keep these assertions intact; do not substitute hidden-copy results.

Before parallel GUI work, identify the current app path, PID, profile, and owner.
Reserve the automation slot and sequence launches with dependency installs.
Clean up only the processes and bundles created by the current run. Preserve
the user's installed app, primary dev session, and other tasks' processes.
