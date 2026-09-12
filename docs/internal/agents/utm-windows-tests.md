# UTM Windows tests for agents

The Windows lane runs the packaged EVB Viewer inside a UTM Windows 11 VM on
this Mac and checks saved and printed PDFs with independent oracles. The
design is in
[the research plan](../research/utm-windows-autotest-plan-2026-09-04.md) and
the gate status in
[the implementation ledger](../research/utm-windows-autotest-implementation-ledger-2026-09-04.md).
Read the ledger before claiming anything about the lane's maturity: a package
is only Qualified when every gate links to evidence.

## Commands

```sh
pnpm windows:test:prepare
pnpm windows:test:doctor
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
Running the executable inside `UTM.app` registers each CLI process as a foreground
application on this Mac and produces a recurring second UTM Dock icon. A symlink
resolves back into the app bundle. Preparation must copy the signed executable
without changing its bytes; doctor must reject a missing or stale copy. Read
[the transport investigation](../research/utm-windows-live-transport-2026-09-05.md)
when diagnosing Dock activity, false zero exits, or VM lookup failures.

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
