# UTM Windows tests for agents

The Windows lane runs the packaged EVB Viewer inside a UTM Windows 11 VM on
this Mac and checks saved and printed PDFs with independent oracles. The
design is in
[the research plan](../research/utm-windows-autotest-plan-2026-09-04.md) and
the gate status in
[the implementation ledger](../research/utm-windows-autotest-implementation-ledger-2026-09-04.md).
Read the ledger before claiming anything about the lane's maturity: a package
is only Qualified when every gate links to evidence.

## Easy path from a fresh checkout

Run the first three commands from the same granted terminal in the logged-in
Mac GUI session, then run the smoke suite:

```sh
pnpm windows:test:prepare
pnpm windows:test:doctor
pnpm windows:test:heal
pnpm windows:test --suite smoke
```

`windows:test:heal` is the one-command golden-image repair. It starts only the
configured golden UUID, waits for QEMU guest-agent transport, skips work when a
fresh interactive unlocked EVBTester heartbeat is already present, or stages
and runs the checked-in SYSTEM bootstrap, prepared worker, Node archive,
PowerShell helpers, startup policy and generated account secret before a
reboot. It waits for a new boot ID and heartbeat, records image qualification,
and always leaves the golden stopped. It does not use native input or ask for
a credential. The generated secret stays under the external lab data root and
is absent from output and evidence.

Guest operations need Screen Recording, Accessibility and UTM Automation
consent for the responsible launcher. Ghostty works when those permissions are
granted to Ghostty. Run `doctor` from that same launcher; an SSH shell or
another app's consent cannot operate the guest channel.

The equivalent explicit form is `pnpm windows:test:provision --heal-golden`.

The manual native-input and image-recovery procedures remain below as fallback
paths for a missing guest agent or a newly built lab image.

## Commands

```sh
pnpm windows:test:prepare
pnpm windows:test:doctor
pnpm windows:test:heal
pnpm windows:test
pnpm windows:test --suite critical --artifact /absolute/path/to/candidate.exe
pnpm windows:test --suite all --environment utm-win11-arm64-app-arm64
pnpm windows:test:report --run RUN_ID
pnpm windows:test:stop --run RUN_ID
```

Run `prepare` once after updating the runner to build its worker and fixtures.
It preserves VM images and configuration and refuses to run while a lease exists.
Run `doctor` first in every new terminal or launcher, including a different agent app. It reads the host configuration,
probes UTM and its Automation consent, checks the golden image and caches,
and never starts, stops, or modifies a VM.

Use the prepared, hash-verified standalone `utmctl` under the host tools cache.

If the guest agent is missing, read the native-input recovery fallback section in
docs/contributing/windows-tests/setup-and-repair.md before declaring computer
use unavailable. The retained command is
pnpm windows:test:provision --plan /absolute/path/to/.devkit/plan.json.
It claims one clone from a before/after inventory, reuses the destructive
identity guard before every UTM AppleScript input keystroke, input scan code,
or input mouse click, and reports guest-agent and worker readiness separately.
It never treats an input call as guest completion. Keep input text, UUIDs,
bundle paths, and passwords out of output. A successful recovery needs a guest
marker read and a fresh worker heartbeat, plus screenshot evidence when visual
input verification is required. Delete the lab clone after the campaign and
confirm the personal Windows VM remains stopped.
Once the marker pull proves that the guest agent is available, use its file push,
file pull, and exec operations for the worker bundle, the standard-account
repair helper, task registration, startup, and diagnosis. Read
`state/startup-validation.json`, `state/worker-logon.json`, and
`state/heartbeat.json` from the guest. The worker requires a standard
interactive account. `scripts/windows-test/guest/powershell/ensure-standard-test-user.ps1`
repairs a copied image with an administrator-only account without weakening
that worker check. A task registration or sent input is not a heartbeat.
Running the executable inside `UTM.app` registers each CLI process as a foreground
application on this Mac and produces a recurring second UTM Dock icon. A symlink
resolves back into the app bundle. Preparation must copy the signed executable
without changing its bytes; doctor must reject a missing or stale copy. Read
[the transport investigation](../research/utm-windows-live-transport-2026-09-05.md)
when diagnosing Dock activity, false zero exits, or VM lookup failures.

For a copied image whose Group Policy Startup directory is absent, the
`pnpm windows:test:heal` command uses the SYSTEM route in the setup and repair
guide. Stage the checked-in
`install-system-bootstrap.cmd`, `system-bootstrap-worker.cmd`,
`start-worker.cmd`, worker bundle, Node archive, account secret, and startup
INI through the guarded provision CLI. The installer creates the missing
directory and runs the account and on-logon setup as SYSTEM. Pull the SYSTEM,
task, launch, and heartbeat markers after every reboot. A marker or a task
registration is not worker readiness. The guide records the current live gap,
including the case where the guest agent does not return after reboot.
The SYSTEM payload disables Windows 11 passwordless-device enforcement and
first-logon screens, removes `AutoLogonCount`, records `query user` on the
next startup pass, and installs a profile Startup launcher as the fallback
when an interactive session exists but the on-logon task does not fire.

Keep one UTM app instance running before invoking doctor, run, or stop. The
runner checks its executable, PID, and start time before Apple Events commands
and refuses a missing or replaced process. It does not reopen UTM after a
detected crash. A crash between the process check and command dispatch remains
a macOS race; these operations cannot be made atomic. Inspect retained evidence
before restarting a failed clone. A clone that stops while the host awaits a
result fails as infrastructure rather than waiting for the entire job deadline.

Input ownership is a hard invariant. The harness never captures host keyboard
or mouse input. Before a clone test starts, the launcher reads the UTM
Accessibility checkbox for that clone and requires `Capture Input` to be off.
If the checkbox is on, the launcher sends UTM's supported Command+Option release
chord and reads the checkbox again. A remaining on state, an unavailable UTM
window, an unavailable Accessibility control, or a focused UTM process after the
check fails the run before guest input begins. The release probe hides a focused
UTM window and the guard requires both `after: 0` and
`hostInputAvailable: true`. The harness never presses the Capture Input
checkbox. After every test, stop request, teardown, and error path it releases
the chord again and hides a focused UTM window so the launcher that started the
run receives host input.
Launch and cleanup probe records live under `runs/<RUN_ID>/input-capture-*.json`.

Exit codes are stable and the only thing CI or a script should branch on:

| Code | Meaning |
| --- | --- |
| 0 | Every required case in the selected automated scope passed |
| 1 | Usage error or an uncaught runner crash |
| 2 | Product failure (assertion, crash, corrupt or wrong output) |
| 3 | Infrastructure failure (VM, session, transport, driver, evidence) |
| 4 | Unsupported configuration or unavailable required capability |
| 5 | Canceled |
| 6 | Another run holds the VM lease; the active run ID is printed |

Exit 0 never means every catalogue obligation was tested. `report` prints the
uncovered obligations and the human contact-sheet review obligation
separately. Do not mark that review done from a machine result.

## Rules that bind agents

- The personal VM registered in UTM under the display name `Windows` is never
  a clone source, test target, delete target or force-stop target. Its UUID and
  bundle path must never enter this repository, a job file, or a log that gets
  uploaded. The runner refuses destructive operations unless the UUID is in
  the host allowlist and the bundle path is under the configured test-image
  root.
- Host configuration, images, caches and run evidence live in
  `~/Library/Application Support/EVBViewerWindowsTests/`, outside every
  checkout. Do not put them under `.devkit`, and do not prune that root as
  part of workspace hygiene.
- Windows lab images take tens of gigabytes on a shared workstation disk.
  When a Windows campaign finishes, pass or fail, delete every clone it
  created and the lab golden image under the test-image root, then confirm
  the space came back with `df`. The next campaign provisions a fresh image.
  Keep an image only when the user asks for it in the current request.
- Diagnostic and provisioning helpers must apply the same existing-process
  guard as the runner before every UTM Apple Event. A raw `utmctl file pull`
  can relaunch UTM after a crash. Never use retry loops that reopen the app.
- On this UTM 4.7.5 host, disable automatic preview screenshots with the
  application `NoScreenshot` preference before qualification. Repeated
  CoreGraphics image-copy crashes match the mechanism reported in upstream
  issue 7745. This is a host mitigation pending repeated-run evidence, not an
  upstream code fix. Record the prior preference and change it only with all
  VMs stopped and UTM quit. Do not disable guest displays or test screenshots.
- A host CLI exit code is transport evidence only. A run passes when the
  validated guest result matches the job's run, boot, VM, image and artifact
  identities and the evidence manifest hashes verify.
- The first result of a run is never replaced. A rerun gets a new run ID.
- Cleanup kills only processes identified by PID, start time and executable.
  Never kill Electron, QEMU, UTM or PowerShell processes by name.
- Keep UTM input capture off. Guest automation uses the Windows UI driver over
  the guest channel, not the host keyboard or mouse. Do not click the UTM
  Capture Input control, add a host input injection shortcut, or accept a run
  without launch and cleanup probe evidence.
- Run broad host validation separately from timed VM acceptance. Use bounded
  test concurrency, such as `--maxWorkers=2`, on this shared workstation. Do
  not stop other agents' processes to make a VM timing result pass.
- Tests must run without Windows audio. Provision the lab with `Audiosrv`
  disabled and stopped, and verify both at worker logon. Endpoint mute returned
  success on this host while the user still heard sounds, so it does not prove
  quiet operation. Preserve the virtual sound card because removing it stalled
  lab boot. Do not change the host volume or the personal VM's settings.
- The numbered print fixture is A4. Provision Microsoft Print to PDF for A4
  output and verify that policy at every worker logon. A Letter driver
  default is lab drift and must block a print run before the candidate starts.
- Acceptance launches keep the renderer sandbox, CSP, UAC, Defender and TLS
  validation intact. `--no-sandbox` and the other flags listed in
  `forbiddenAcceptanceLaunchFlags` are rejected.
- The registry in `tests/windows/capabilities.json` is the coverage source
  of truth. Adding a Windows behavior means adding or updating a case there;
  the policy test rejects duplicate IDs, empty oracles and required cases that
  are still planned.

## Where things live

| Path | Contents |
| --- | --- |
| `scripts/windows-test/contracts/` | Exit codes, states, job and result schemas, host and guest path layout |
| `scripts/windows-test/host/` | Lease, utmctl transport, coordinator, doctor, report, stop |
| `scripts/windows-test/images/` | Image manifest and the destructive-target identity guard |
| `scripts/windows-test/guest/` | Windows worker, launch adapter, native UI adapters, case modules, PowerShell helpers |
| `scripts/windows-test/registry/` | Capability registry loader, lint and change-area suite selector |
| `scripts/windows-test/fixtures/` | Deterministic fixture generators and manifest verification |
| `scripts/windows-test/oracles/` | Host-side PDF oracles and the human-review obligation record |
| `tests/windows/` | `capabilities.json`, fixture manifest, native UI selector records |
| `docs/contributing/windows-tests/` | Setup and repair guide, image migration policy |

Setup, repair and image maintenance are in
[setup and repair](../../contributing/windows-tests/setup-and-repair.md) and
[image migration policy](../../contributing/windows-tests/image-migration-policy.md).
