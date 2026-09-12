# Windows test image migration policy

The golden image is the reference environment for every Windows result. Its
identity is part of each result, so a change to the image is a change to what
the lane measures. This policy keeps upgrades explicit and reversible.

## What counts as an image change

- A Windows feature or cumulative update that changes the OS build.
- A UTM or QEMU upgrade on the host.
- A change of the pinned guest tools: Node runtime, `winapp` CLI, UIA helper.
- A change of the guest layout, ACLs, logon task, sign-in policy or marker.
- Any change to the disks attached to the image or their reset policy.

Defender signature refreshes are recorded as drift on the run, not as an
image change. Real-time protection must stay enabled.

## Candidate lane

1. Clone the current golden image into a candidate under
   `images/baselines/<imageId>-candidate/`. Never modify the qualified golden
   image in place.
2. Apply exactly one class of change per candidate. Do not combine an OS
   upgrade, a driver upgrade and a runner change into one comparison.
3. Record every version in the candidate manifest: Windows build, UTM, QEMU,
   Node, `winapp`, Electron of the reference app build.
4. Repeat the M0 controls from the plan on the candidate: clone identity
   (exactly one new UUID, distinct bundle path, marker present), transport
   (delayed success, nonzero failure, stale output rejected), worker identity
   (SID, session, input desktop), native Print and Save dialogs, owned-process
   cleanup, drift detection.
5. Run the known-bad and known-good regression checks: official 0.1.450 must
   fail WIN-SAVE-01 and WIN-PRINT-01 as product failures; the fixed artifact
   must pass the critical suite on the candidate.
6. Re-verify the selector records in `tests/windows/native-ui/selectors.json`
   on the candidate and update `verifiedOnImage`.

## Promotion

- Promote by updating `goldenImageId` and `goldenVmId` in the host config and
  marking the candidate manifest `qualifiedAt` with the evidence run IDs.
- Keep the previous golden image stopped under `images/baselines/` until the
  new image has completed its first ten clean critical runs. Then it may be
  removed; keep its manifest.
- Record the promotion and the runner version that qualified it in the
  implementation ledger. A runner revision that requires a newer image than
  the last qualified one is a breaking change and must say so in its commit.

## Rollback

Set the config back to the previous image ID and VM UUID. Do not delete the
failed candidate until its failure evidence is captured. Runs that executed
on the candidate keep their image ID in their summaries; never rewrite them.

## Retention defaults

| Item | Default |
| --- | --- |
| Golden images kept | Current and previous |
| Active clones | One per host |
| Retained failed clones | One per host |
| Pass manifests | 7 days |
| Failure evidence | 30 days |

These are starting values. Adjust them in the host config, not in code, and
never prune a live VM, the personal VM backup, or the only failure evidence.
