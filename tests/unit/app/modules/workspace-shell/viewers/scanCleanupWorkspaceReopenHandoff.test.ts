import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type {
    IScanCleanupCapability,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {
    requireJobId,
    type TJobId,
} from '@contracts/shared';
import { requireEpochMs } from '@contracts/timestamps';
import {
    createDocumentPageSourceLifecycle,
    type IDocumentPageSourceTransition,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

function progress(processedCount = 0, totalPages = 1) {
    return {
        stage: 'rendering' as const,
        completedUnits: processedCount,
        totalUnits: totalPages,
        percent: processedCount / totalPages * 100,
        completedPageNumbers: Array.from({length: processedCount}, (_, index) => index + 1),
    };
}

describe('scan-cleanup workspace reopen handoff', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('keeps scan invalidation owned until the generated document supersedes the source', async () => {
        const sourceRef = requireDocumentRef('/source/book.pdf');
        const outputRef = requireDocumentRef('/managed/book-cleaned.pdf');
        const src = ref<TDocumentRef | null>(sourceRef);
        const revision = ref(requireDocumentRevisionToken('scan-source-revision'));
        const scope = effectScope();
        const lifecycle = scope.run(() => createDocumentPageSourceLifecycle({
            chassisAuthority: null,
            readIsActive: () => true,
            readRevisionToken: () => revision.value,
            readSrc: () => src.value,
        }))!;
        const reopenGate = Promise.withResolvers<undefined>();
        const reopenCommitted = Promise.withResolvers<undefined>();
        const transitions: IDocumentPageSourceTransition[] = [];
        lifecycle.channel.subscribe(async (transition) => {
            transitions.push(transition);
            if (transition.fence.src !== outputRef) {
                return;
            }
            await reopenGate.promise;
            if (transition.isCurrent()) {
                reopenCommitted.resolve(undefined);
            }
        });
        lifecycle.start();
        await vi.waitFor(() => expect(transitions).toHaveLength(1));
        const sourceTransition = transitions[0]!;

        let jobStateListener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true as const,
                jobId: requireJobId('scan-handoff-job'),
                outputPdfPath: outputRef,
            })),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async (jobId: TJobId) => ({
                jobId,
                status: 'running' as const,
                progress: progress(),
                updatedAtMs: requireEpochMs(1),
            })),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn((listener) => {
                jobStateListener = listener;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };

        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: async (path) => {
                src.value = requireDocumentRef(path);
                revision.value = requireDocumentRevisionToken('scan-output-revision');
                await nextTick();
                await reopenCommitted.promise;
                return true;
            },
            saveActiveDocumentAs: vi.fn(),
            t: ((key: string) => key) as never,
            toast: {add: vi.fn()},
        });

        try {
            await coordinator.startScanCleanup({
                ownerId: 'scan-handoff-owner',
                documentRevision: revision.value,
                sourcePdfPath: sourceRef,
                options: expect.anything() as never,
            });
            jobStateListener({
                jobId: requireJobId('scan-handoff-job'),
                status: 'completed',
                outputPdfPath: outputRef,
                summary: {
                    inputPages: 1,
                    outputPages: 1,
                    spreadsSplit: 0,
                    offcutsDiscarded: 0,
                    deskewSkipped: 0,
                    cropSkipped: 0,
                    excludedPages: 0,
                    blankPagesSkipped: 0,
                    warnings: [],
                },
                partial: false,
                progress: progress(1),
                updatedAtMs: requireEpochMs(2),
            });

            await vi.waitFor(() => expect(transitions).toHaveLength(2));
            const outputTransition = transitions[1]!;
            expect(outputTransition.fence).toMatchObject({
                documentRevision: 'scan-output-revision',
                src: outputRef,
            });
            expect(sourceTransition.isCurrent()).toBe(false);
            expect(outputTransition.isCurrent()).toBe(true);
            expect(coordinator.isScanCleanupRunning.value).toBe(true);

            reopenGate.resolve(undefined);
            await vi.waitFor(() => expect(coordinator.isScanCleanupRunning.value).toBe(false));
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        } finally {
            cleanup();
            lifecycle.dispose();
            scope.stop();
        }
    });
});
