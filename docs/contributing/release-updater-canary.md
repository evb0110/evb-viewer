# Updater release canary

The release workflow validates updater metadata before upload and again after the draft release assets are downloaded. The gate requires the release version to match `package.json`, every referenced artifact to exist, and every metadata size and SHA-512 value to match the exact uploaded bytes.

## Residual N-1 → N check

An actual automatic update cannot be a deterministic pre-publication gate with the production GitHub provider: the feed is only available to installed clients after the signed release becomes public. A draft-only or unsigned feed would exercise materially different trust and provider behavior.

After promotion, perform this canary on each platform for which updater metadata was published:

1. Install the previous public signed version in a disposable VM or macOS test account.
2. Confirm the About dialog reports N-1 and no EVB Viewer process from another installation is running.
3. Trigger **Check for updates**, wait for the download to finish, and choose the restart/install action.
4. Confirm the relaunched executable is the installed application, the About dialog reports N, and a PDF opens and renders.
5. Preserve the updater log and application log with the release record.

Do not use an installed production copy for this canary. A future reliable automation lane requires disposable signed-machine images and an isolated public-compatible update feed; until then, the deterministic artifact-integrity gate plus this post-promotion smoke is the release contract.

## macOS installations without administrator rights

EVB enables Squirrel's `SquirrelMacEnableDirectContentsWrite` preference before
installation. ShipIt then replaces the app's `Contents` while keeping the app
entry in `/Applications` in place. The app bundle must be writable; the parent
folder does not need to be. A non-writable bundle is refused before shutdown
with guidance to ask an administrator or use a copy in `~/Applications`.

An older installed version cannot acquire this fix through a blocked updater.
If its ShipIt log shows `NSPOSIXErrorDomain Code=13` while moving the app bundle,
and the bundle itself is writable, enable the same app-scoped mode once before
retrying the update:

```sh
defaults write com.evb.viewer SquirrelMacEnableDirectContentsWrite -bool true
```

This does not grant permissions or require administrator rights. If the bundle
itself is managed or read-only, an administrator must update it, or the user can
install their own copy in `~/Applications` where workplace policy permits.

The behavior comes from [Squirrel's Contents replacement path](https://github.com/Squirrel/Squirrel.Mac/blob/main/Squirrel/SQRLInstaller.m#L519-L589).
The focused macOS case in `tests/unit/electron/updates.test.ts` exercises the
shipped ShipIt executable against disposable signed apps under a non-writable
parent and verifies the installed bytes and signature. It disables relaunch;
the signed-release UI canary above remains a separate post-promotion check.
