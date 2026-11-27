import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {SCAN_CLEANUP_SUB_PAGE_STAGES} from '@contracts/scan-cleanup/nativeProtocolV3';
import * as v from 'valibot';

const progress = v.message(
    v.pipe(
        v.object({
            stage: v.picklist([
                'queued',
                'normalizing',
                'probing',
                'extracting',
                'rasterizing',
                'classifying',
                'rendering',
                'collecting',
                'assembling',
                'handoff',
                'detecting',
            ] as const),
            completedUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
            totalUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
            percent: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
            stageIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
            stageCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
            etaSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            // Pages whose analysis image exists during this detection job.
            rasterizedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            // Pages re-read during document reconciliation and MediaBox retries.
            recheckedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            completedPageNumbers: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(1)))),
            // A long detection run reports a bounded list in verdict-arrival order.
            // Consumers use completedUnits for the authoritative distinct-page count.
            completedPageNumbersTruncated: v.optional(v.boolean()),
            // Source page numbers currently executing in parallel workers.
            activePageNumbers: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(1)))),
            // Latest fine-grained sub-page processing stage reported by an active worker.
            activeSubPageStage: v.optional(v.picklist(SCAN_CLEANUP_SUB_PAGE_STAGES)),
        }),
        v.check(
            (value) =>
                value.completedUnits <= value.totalUnits &&
                (value.rasterizedUnits === undefined || value.rasterizedUnits <= value.totalUnits) &&
                (value.stageIndex === undefined || value.stageCount === undefined || value.stageIndex <= value.stageCount) &&
                (value.completedPageNumbers === undefined ||
                    (value.completedPageNumbers.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES &&
                        (value.completedPageNumbersTruncated === true || value.completedPageNumbers.length === value.completedUnits) &&
                        new Set(value.completedPageNumbers).size === value.completedPageNumbers.length)) &&
                (value.completedPageNumbersTruncated !== true || value.completedPageNumbers !== undefined) &&
                (value.activePageNumbers === undefined ||
                    (value.activePageNumbers.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES &&
                        new Set(value.activePageNumbers).size === value.activePageNumbers.length)),
        ),
    ),
    'invalid scan-cleanup progress',
);

export const SCAN_CLEANUP_PROGRESS_SCHEMA = progress;
export type TScanCleanupProgress = v.InferOutput<typeof progress>;
export type TScanCleanupProgressStage = TScanCleanupProgress['stage'];
