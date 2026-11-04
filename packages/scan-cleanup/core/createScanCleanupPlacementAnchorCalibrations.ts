import type {
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupPlacementAnchorCalibrationRequest,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    createScanCleanupDetectionSignature,
    createScanCleanupPlacementAnchorCalibrationSignature,
} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    buildScanCleanupPlacementAnchorSummary,
    resolveScanCleanupPlacementAnchorsFromResult,
} from '@evb/scan-cleanup/core/placementAnchors';

interface IBuild {
    key: string;
    promise: ReturnType<typeof buildScanCleanupPlacementAnchorSummary>;
    controller: AbortController;
    waiters: number;
}

/**
 * The placement-anchor summaries built over retained detection stores, one per
 * store, rebuilt when the request's identity changes. A changed option set
 * does not abort a caller still waiting on the previous build, but a
 * superseded build nobody awaits is aborted, so rapid option changes do not
 * run concurrent passes over one store. The caller owns the store's lease.
 */
export function createScanCleanupPlacementAnchorCalibrations() {
    const builds = new Map<string, IBuild>();
    return {
        /** The request's options must already carry their page-override defaults. */
        async resolve(
            storeId: string,
            resultStore: IScanCleanupDetectionResultStore,
            request: IScanCleanupPlacementAnchorCalibrationRequest,
        ): Promise<IScanCleanupPlacementAnchorCalibration> {
            const detectionSignature = createScanCleanupDetectionSignature(request.options);
            const calibrationSignature = createScanCleanupPlacementAnchorCalibrationSignature(request.options);
            const key = JSON.stringify([
                storeId,
                request.ownerId,
                request.documentRevision,
                detectionSignature,
                calibrationSignature,
            ]);
            let build = builds.get(storeId);
            if (build === undefined || build.key !== key) {
                if (build !== undefined && build.waiters === 0) {
                    build.controller.abort();
                }
                const controller = new AbortController();
                const promise = buildScanCleanupPlacementAnchorSummary({
                    options: request.options,
                    resultStore,
                    signal: controller.signal,
                    identity: {
                        documentRevision: request.documentRevision,
                        detectionSignature,
                        calibrationSignature,
                    },
                });
                const created: IBuild = {
                    key,
                    promise,
                    controller,
                    waiters: 0,
                };
                build = created;
                builds.set(storeId, created);
                void promise.catch(() => {
                    if (builds.get(storeId) === created) {
                        builds.delete(storeId);
                    }
                });
            }
            const currentBuild = build;
            currentBuild.waiters += 1;
            let summary: Awaited<typeof currentBuild.promise>;
            try {
                summary = await currentBuild.promise;
            } finally {
                currentBuild.waiters -= 1;
                if (currentBuild.waiters === 0 && builds.get(storeId) !== currentBuild) {
                    currentBuild.controller.abort();
                }
            }
            const result = request.pageNumber === undefined
                ? undefined
                : await resultStore.getPage(request.pageNumber);
            if (request.pageNumber !== undefined && result === undefined) {
                throw new Error(`Scan cleanup placement calibration has no page ${String(request.pageNumber)}`);
            }
            return {
                summary,
                placementAnchors: result === undefined
                    ? {}
                    : resolveScanCleanupPlacementAnchorsFromResult(summary, request.options, result),
            };
        },
        /** Forgets a store's build; one nobody awaits stops. */
        retire(storeId: string) {
            const build = builds.get(storeId);
            builds.delete(storeId);
            if (build !== undefined && build.waiters === 0) build.controller.abort();
        },
        /** Retires every build whose store is no longer kept. */
        retireUnless(isKept: (storeId: string) => boolean) {
            for (const storeId of [...builds.keys()]) {
                if (!isKept(storeId)) this.retire(storeId);
            }
        },
        dispose() {
            builds.forEach(build => build.controller.abort());
            builds.clear();
        },
    };
}
