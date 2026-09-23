import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';

const s = runtimeSchema;
const progress = s.refine(s.object({
    stage: s.oneOf([
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
    ] as const, 'invalid scan-cleanup progress'),
    completedUnits: s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress',
    }),
    totalUnits: s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress',
    }),
    percent: s.number({
        min: 0,
        max: 100,
        message: 'invalid scan-cleanup progress',
    }),
    stageIndex: s.optional(s.number({
        integer: true,
        min: 1,
        message: 'invalid scan-cleanup progress stage index',
    })),
    stageCount: s.optional(s.number({
        integer: true,
        min: 1,
        message: 'invalid scan-cleanup progress stage count',
    })),
    etaSeconds: s.optional(s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress ETA',
    })),
    // Pages whose analysis image exists during this detection job.
    rasterizedUnits: s.optional(s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup rasterized units',
    })),
    // Pages re-read during document reconciliation and MediaBox retries.
    recheckedUnits: s.optional(s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup rechecked units',
    })),
    completedPageNumbers: s.optional(s.array(s.number({
        integer: true,
        min: 1,
        message: 'invalid scan-cleanup completed page numbers',
    }))),
    // A long detection run reports a bounded list in verdict-arrival order.
    // Consumers use completedUnits for the authoritative distinct-page count.
    completedPageNumbersTruncated: s.optional(s.boolean()),
}), value =>
    value.completedUnits <= value.totalUnits
    && (
        value.rasterizedUnits === undefined
        || value.rasterizedUnits <= value.totalUnits
    )
    && (
        value.stageIndex === undefined
        || value.stageCount === undefined
        || value.stageIndex <= value.stageCount
    )
    && (
        value.completedPageNumbers === undefined
        || (
            value.completedPageNumbers.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
            && (
                value.completedPageNumbersTruncated === true
                || value.completedPageNumbers.length === value.completedUnits
            )
            && new Set(value.completedPageNumbers).size === value.completedPageNumbers.length
        )
    )
    && (
        value.completedPageNumbersTruncated !== true
        || value.completedPageNumbers !== undefined
    ),
'invalid scan-cleanup progress');

export const SCAN_CLEANUP_PROGRESS_SCHEMA = progress;
export type TScanCleanupProgress = TInferSchema<typeof progress>;
export type TScanCleanupProgressStage = TScanCleanupProgress['stage'];
