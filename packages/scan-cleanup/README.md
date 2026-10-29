# Scan-cleanup package

`core/` contains the portable conversion, detection, policy, and manifest algorithms. It may depend on `@evb/contracts`, but it must not import Electron or an Electron feature.

`adapters/` contains the Node runtime adapters, the native-facing raster renderers and MRC layer readers, and has three users:

- Full cleanup runs in a Node `worker_threads` worker, `electron/features/scan-cleanup/worker/main.ts`, started by `runScanCleanupWorkerTask.ts` through `electron/utils/workerTask.ts`. A thread shares the main process, so a crash there is not isolated from it; the native tools it starts are separate processes owned by `electron/native-tools/runNativeCommand.ts`.
- Preview and detection run in the Electron main process, composed in `scanCleanupMainBindings.ts` and `scanCleanupPreviewLifecycle.ts`, and call the same renderers, sidecar and MRC adapters directly. Their resource owners are the preview rendering owner, the detection lifecycle and raster retention in `electron/features/scan-cleanup/`.
- The scan-cleanup CLI composes the adapters in `scripts/scan-cleanup-convert.ts`.

Consumers import the package through `@evb/scan-cleanup`, with `@evb/scan-cleanup/core` and `@evb/scan-cleanup/adapters` available for focused entry points.
