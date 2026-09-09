# Scan-cleanup package

`core/` contains the portable conversion, detection, policy, and manifest algorithms. It may depend on `@evb/contracts`, but it must not import Electron or an Electron feature.

`adapters/` contains the Node runtime adapters used by the Electron scan-cleanup utility-process worker and the scan-cleanup CLI. The worker owner remains `electron/features/scan-cleanup/worker/main.ts`; the native-facing MRC and raster adapters run only through that worker or the CLI composition.

Consumers import the package through `@evb/scan-cleanup`, with `@evb/scan-cleanup/core` and `@evb/scan-cleanup/adapters` available for focused entry points.
