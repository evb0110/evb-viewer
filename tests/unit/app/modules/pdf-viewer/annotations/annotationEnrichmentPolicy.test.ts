import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';
import {
    MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT,
    MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT,
    areAnnotationEnrichmentStatesEqual,
    evaluateAnnotationEnrichmentEligibility,
    isAnnotationEnrichmentWithinLimits,
    resolveAnnotationEnrichmentMaxBytes,
    resolveAnnotationEnrichmentState,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type {
    IAnnotationEnrichmentRequest,
    IAnnotationEnrichmentState,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';

const LIMITS = {
    eagerMaxBytes: 16 * 1024 * 1024,
    interactiveMaxBytes: 64 * 1024 * 1024,
};

function request(overrides: Partial<IAnnotationEnrichmentRequest> = {}): IAnnotationEnrichmentRequest {
    return {
        intent: 'eager',
        pageCount: 10,
        sourceByteSize: 1024,
        isBlobSource: true,
        limits: LIMITS,
        ...overrides,
    };
}

describe('annotation enrichment policy', () => {
    it('reads each intent its own byte budget', () => {
        // Distinct sentinels: equal budgets would let the two fields be
        // swapped, which silently gives the open path the on-demand budget.
        const limits = {
            eagerMaxBytes: 111,
            interactiveMaxBytes: 222,
        };

        expect(resolveAnnotationEnrichmentMaxBytes('eager', limits)).toBe(111);
        expect(resolveAnnotationEnrichmentMaxBytes('interactive', limits)).toBe(222);
    });

    /**
     * All four tier/intent pairs, because the two budgets and the two tiers can
     * be crossed wrongly in ways a partial table cannot see: the constrained
     * on-demand budget and the normal open-path budget are both 16 MiB, so a
     * test that checked only those two would still pass with the tiers swapped.
     */
    it.each([
        {
            tier: 'medium',
            intent: 'eager',
            expectedMebibytes: 16,
        },
        {
            tier: 'medium',
            intent: 'interactive',
            expectedMebibytes: 64,
        },
        {
            tier: 'low',
            intent: 'eager',
            expectedMebibytes: 4,
        },
        {
            tier: 'low',
            intent: 'interactive',
            expectedMebibytes: 16,
        },
    ] as const)(
        'takes the $intent budget for a $tier profile from the shared open-path performance policy',
        ({
            tier,
            intent,
            expectedMebibytes,
        }) => {
            const policy = resolveOpenPathSecondaryPerformancePolicy(resolvePerformanceProfile({ tier }));

            expect(resolveAnnotationEnrichmentMaxBytes(intent, {
                eagerMaxBytes: policy.eagerAnnotationNameReadMaxBytes,
                interactiveMaxBytes: policy.interactiveAnnotationNameReadMaxBytes,
            })).toBe(expectedMebibytes * 1024 * 1024);
        },
    );

    describe.each([
        {
            intent: 'eager',
            limit: LIMITS.eagerMaxBytes,
        },
        {
            intent: 'interactive',
            limit: LIMITS.interactiveMaxBytes,
        },
    ] as const)('$intent byte boundary', ({
        intent,
        limit,
    }) => {
        it.each([
            {
                label: 'below the limit',
                sourceByteSize: limit - 1,
                within: true,
            },
            {
                label: 'exactly at the limit',
                sourceByteSize: limit,
                within: true,
            },
            {
                label: 'one byte over the limit',
                sourceByteSize: limit + 1,
                within: false,
            },
        ])('$label', ({
            sourceByteSize,
            within,
        }) => {
            expect(isAnnotationEnrichmentWithinLimits(request({
                intent,
                sourceByteSize,
            }))).toBe(within);
        });
    });

    it.each([
        {
            label: 'below the eager page ceiling',
            pageCount: MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT - 1,
            within: true,
        },
        {
            label: 'exactly at the eager page ceiling',
            pageCount: MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT,
            within: true,
        },
        {
            label: 'one page over the eager page ceiling',
            pageCount: MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT + 1,
            within: false,
        },
    ])('$label', ({
        pageCount,
        within,
    }) => {
        expect(isAnnotationEnrichmentWithinLimits(request({pageCount}))).toBe(within);
    });

    it.each([
        {
            label: 'below the interactive page ceiling',
            pageCount: MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT - 1,
            within: true,
        },
        {
            label: 'exactly at the interactive page ceiling',
            pageCount: MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT,
            within: true,
        },
        {
            label: 'one page over the interactive page ceiling',
            pageCount: MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT + 1,
            within: false,
        },
    ])('$label', ({
        pageCount,
        within,
    }) => {
        expect(isAnnotationEnrichmentWithinLimits(request({
            intent: 'interactive',
            pageCount,
            isBlobSource: false,
        }))).toBe(within);
    });

    it('never enriches eagerly from a non-blob source', () => {
        expect(isAnnotationEnrichmentWithinLimits(request({isBlobSource: false}))).toBe(false);
    });

    it('never enriches a source that cannot report its size', () => {
        for (const intent of [
            'eager',
            'interactive',
        ] as const) {
            expect(isAnnotationEnrichmentWithinLimits(request({
                intent,
                sourceByteSize: null,
            }))).toBe(false);
        }
    });

    it.each([
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
    ])('rejects invalid source byte size %s', (sourceByteSize) => {
        for (const intent of [
            'eager',
            'interactive',
        ] as const) {
            expect(isAnnotationEnrichmentWithinLimits(request({
                intent,
                sourceByteSize,
            }))).toBe(false);
        }
    });

    it.each([
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
    ])('rejects invalid enrichment byte limit %s', (maxBytes) => {
        const limits = {
            eagerMaxBytes: maxBytes,
            interactiveMaxBytes: maxBytes,
        };

        expect(isAnnotationEnrichmentWithinLimits(request({limits}))).toBe(false);
    });

    it.each([
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        1.5,
    ])('rejects invalid page count %s', (pageCount) => {
        expect(isAnnotationEnrichmentWithinLimits(request({
            intent: 'interactive',
            pageCount,
        }))).toBe(false);
    });

    it.each([
        {
            label: 'a source that cannot report its size',
            overrides: {sourceByteSize: null},
            reason: 'unreadable-source',
        },
        {
            label: 'a source over the byte budget',
            overrides: {sourceByteSize: LIMITS.eagerMaxBytes + 1},
            reason: 'over-byte-limit',
        },
        {
            label: 'a document past the eager page ceiling',
            overrides: {pageCount: MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT + 1},
            reason: 'over-page-count',
        },
        {
            label: 'a non-blob source on the open path',
            overrides: {isBlobSource: false},
            reason: 'unreadable-source',
        },
        {
            label: 'a document past the interactive page ceiling',
            overrides: {
                intent: 'interactive',
                pageCount: MAX_INTERACTIVE_ANNOTATION_ENRICHMENT_PAGE_COUNT + 1,
            },
            reason: 'over-page-count',
        },
    ] as const)('explains $label as $reason', ({
        overrides,
        reason,
    }) => {
        expect(evaluateAnnotationEnrichmentEligibility(request(overrides))).toEqual({
            allowed: false,
            reason,
        });
    });

    it('reports no reason while enrichment is allowed', () => {
        expect(evaluateAnnotationEnrichmentEligibility(request())).toEqual({
            allowed: true,
            reason: null,
        });
    });

    describe('state equality', () => {
        const verdict: IAnnotationEnrichmentState = {
            status: 'skipped',
            reason: 'over-byte-limit',
            canRetry: true,
        };

        it('treats two identical verdicts as the same verdict', () => {
            expect(areAnnotationEnrichmentStatesEqual(verdict, {...verdict})).toBe(true);
        });

        it.each([
            {
                label: 'completeness',
                changed: {status: 'failed'},
            },
            {
                label: 'cause',
                changed: {reason: 'over-page-count'},
            },
            {
                // Retryability alone decides whether the notice offers an
                // action, so the bridge's de-duplication must not read a
                // canRetry change as "nothing happened".
                label: 'retryability',
                changed: {canRetry: false},
            },
        ] as const)('separates verdicts that differ in $label', ({ changed }) => {
            expect(areAnnotationEnrichmentStatesEqual(verdict, {
                ...verdict,
                ...changed,
            })).toBe(false);
        });
    });

    describe('resolved state', () => {
        const allowed = {
            allowed: true,
            reason: null,
        } as const;
        const blocked = {
            allowed: false,
            reason: 'over-byte-limit',
        } as const;

        it('reports a completed read as enriched with nothing to retry', () => {
            expect(resolveAnnotationEnrichmentState('reconciled', null, allowed)).toEqual({
                status: 'enriched',
                reason: null,
                canRetry: false,
            });
            expect(resolveAnnotationEnrichmentState('reconciled', null, blocked)).toEqual({
                status: 'enriched',
                reason: null,
                canRetry: false,
            });
        });

        it('keeps a retryable skip visible instead of calling it pending', () => {
            // The document is incomplete right now. Offering a retry is a
            // separate fact and must not erase the omission.
            expect(resolveAnnotationEnrichmentState('skipped', 'over-page-count', allowed)).toEqual({
                status: 'skipped',
                reason: 'over-page-count',
                canRetry: true,
            });
        });

        it('prefers the durable reason when the on-demand pass is also blocked', () => {
            expect(resolveAnnotationEnrichmentState('skipped', 'unreadable-source', blocked)).toEqual({
                status: 'skipped',
                reason: 'over-byte-limit',
                canRetry: false,
            });
        });

        it('separates a failed read from a size or source skip', () => {
            expect(resolveAnnotationEnrichmentState('failed', null, allowed)).toEqual({
                status: 'failed',
                reason: null,
                canRetry: true,
            });
            expect(resolveAnnotationEnrichmentState('failed', null, blocked)).toEqual({
                status: 'failed',
                reason: null,
                canRetry: false,
            });
        });
    });
});
