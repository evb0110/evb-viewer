# Scan-cleanup package

`core/` contains portable conversion and detection orchestration, policy and
manifest assembly. It may depend on `@evb/contracts`, but it must not import
Electron or an Electron feature.

The Rust engine's `engine/document_analysis.rs` owns document analysis sequencing,
layout reconciliation, ink priors and alternate MediaBox analysis on desktop
and in the browser. TypeScript supplies rasters and returns each analysis as
exact JSON text. The engine asks for the next analysis or returns the finished
page plans; hosts do not repeat its sequencing rules.

Rust protocol types are the wire source. `protocol/typescript.rs` generates
`packages/contracts/scan-cleanup/nativeWire.generated.ts` and the WASM request
declarations. `nativeProtocolV3.ts` and `browserScanCleanupWasm.ts` decode native
JSON and WASM results at their boundaries. Internal consumers use those decoded
values rather than validating them again.

The renderer's `useScanCleanupDetectionSession.ts` owns one record map per job;
its per-page views are selectors. `useScanCleanupPreviewSession.ts` owns one
preview frame with its result and presentation and cache identities.

`adapters/` contains the Node runtime adapters, the native-facing raster renderers and MRC layer readers, and has three users:

- Full cleanup runs in a Node `worker_threads` worker, `electron/features/scan-cleanup/worker/main.ts`, started by `runScanCleanupWorkerTask.ts` through `electron/utils/workerTask.ts`. A thread shares the main process, so a crash there is not isolated from it; the native tools it starts are separate processes owned by `electron/native-tools/runNativeCommand.ts`.
- Preview and detection run in the Electron main process, composed in `scanCleanupMainBindings.ts` and `scanCleanupPreviewLifecycle.ts`, and call the same renderers, sidecar and MRC adapters directly. Their resource owners are the preview rendering owner, the detection lifecycle and raster retention in `electron/features/scan-cleanup/`.
- The scan-cleanup CLI composes the adapters in `scripts/scan-cleanup-convert.ts`.

Consumers import the package through `@evb/scan-cleanup`, with `@evb/scan-cleanup/core` and `@evb/scan-cleanup/adapters` available for focused entry points.
