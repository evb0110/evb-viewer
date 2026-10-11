import type {
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPlacementAnchor,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputHalf,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TScanCleanupLog} from '@evb/scan-cleanup/core/types';
import {resolveReusablePagePlanResult} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import {collectScanCleanupSheetInkTops} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';

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
            // Every output the anchor producers place must arrive with its
            // anchor; they and this check read the sheet through one rule.
            const evidence = input.pagePlanEvidenceByPage?.[String(pageNumber)];
            const inkTops = input.options.matchPageSize
                ? collectScanCleanupSheetInkTops(input.options, {
                    pageNumber,
                    layoutClassification: input.layoutByPage?.[String(pageNumber)] ?? evidence?.layoutClassification,
                    evidence,
                    metadata: undefined,
                }, 0)
                : {};
            for (const half of Object.keys(inkTops) as TScanCleanupOutputHalf[]) {
                if (placementAnchors?.[half] === undefined) {
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
