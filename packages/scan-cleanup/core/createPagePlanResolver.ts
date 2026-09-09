import type {
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPlacementAnchor,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type {TScanCleanupLog} from '@evb/scan-cleanup/core/types';
import {resolveReusablePagePlanResult} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';

const SCAN_CLEANUP_OUTPUT_HALVES = [
    'full',
    'left',
    'right',
] as const;

interface IPagePlanEvidenceInput {
    options: IScanCleanupOptions;
    layoutByPage?: TScanCleanupLayoutByPage;
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
    placementAnchorsByPage?: Partial<Record<
        string,
        Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>
    >>;
}

export function createPagePlanResolver(
    input: IPagePlanEvidenceInput,
    log: TScanCleanupLog,
    phase: 'lossless' | 'final',
) {
    let pinned = 0;
    let absent = 0;
    return {
        resolve(pageNumber: number) {
            const result = resolveReusablePagePlanResult(
                input.options,
                input.layoutByPage,
                input.pagePlanEvidenceByPage,
                pageNumber,
            );
            if (result.status === 'matched') {
                pinned += 1;
            } else if (result.status === 'absent') {
                absent += 1;
            } else {
                throw new Error(
                    `Stale scan cleanup page-plan evidence for page ${String(pageNumber)}:`
                    + ` ${result.status}`,
                );
            }
            const placementAnchors = input.placementAnchorsByPage?.[String(pageNumber)];
            const pageOverride = getScanCleanupPageOverride(
                input.options.pageOverrides,
                requirePageNumber(pageNumber),
            );
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                const alignment = pageOverride.placementOverrides?.[half]
                    ?? input.options.pageAlignment;
                const contentBox = pageOverride.manualContentBoxes?.[half]
                    ?? result.plan.automaticContentBoxes?.[half];
                if (
                    input.options.matchPageSize
                    && alignment === 'ink'
                    && contentBox !== undefined
                    && placementAnchors?.[half] === undefined
                ) {
                    throw new ScanCleanupContractError(
                        `missing ink placement anchor for page ${String(pageNumber)} ${half} output`,
                    );
                }
            }
            return placementAnchors === undefined || Object.keys(placementAnchors).length === 0
                ? result.plan
                : {
                    ...result.plan,
                    placementAnchors,
                };
        },
        report() {
            log(
                'debug',
                `Scan cleanup ${phase} page-plan evidence:`
                + ` pinned=${String(pinned)} absent=${String(absent)} mismatched=0`,
            );
        },
    };
}
