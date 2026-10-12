import {
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createScanCleanupOutputSaveAs } from '@app/modules/workspace-shell/composables/scanCleanupOutputTab';
import { cast } from '@tests/helpers/cast';
import type { TTranslateFn } from '@i18n-app';
import type {
    IScanCleanupCapability,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {requireDocumentInstanceId} from '@contracts/documentInstanceId';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {
    requireJobId,
    type TJobId,
} from '@contracts/shared';
import { requireEpochMs } from '@contracts/timestamps';
import {
    createDocumentPageSourceLifecycle,
    type IDocumentPageSourceTransition,
} from '@app/modules/document-viewer/page-source-renderer/documentPageSourceFeaturePackState';

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
            onSettingsChanged: vi.fn(() => () => undefined),
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
            createCompletedOutputSaveAs: vi.fn(() => async () => undefined),
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

    it.each([
        'background',
        'title-renamed',
        'save-as-renamed',
        'reloaded',
        'moved-window',
        'reopen-same-path',
        'closed-before-click',
        'cancelled-dialog',
    ])('keeps completion Save As attached to its document: %s', async (scenario) => {
        const scratch = await mkdtemp(join(tmpdir(), 'cleanup-completion-session-'));
        const savedPath = join(scratch, 'saved.pdf');
        const outputPath = '/managed/cleaned.pdf';
        const output = cast<IWorkspaceDocumentController>({
            views: shallowRef(new Map([[
                'output',
                {mountedWorkspace: computed(() => workspaces.output)},
            ]])),
            snapshot: ref({identity: {
                documentInstanceId: 'completed-document',
                originalPath: outputPath,
                workingCopyPath: '/working/output.pdf',
                documentRef: '/working/output.pdf',
            }}),
        });
        const other = cast<IWorkspaceDocumentController>({
            views: shallowRef(new Map([[
                'other',
                {mountedWorkspace: computed(() => workspaces.other)},
            ]])),
            snapshot: ref({identity: {
                documentInstanceId: 'other-document',
                originalPath: '/other.pdf',
                workingCopyPath: '/working/other.pdf',
                documentRef: '/working/other.pdf',
            }}),
        });
        const sessions = shallowRef<Record<string, IWorkspaceDocumentController>>({
            output,
            other,
        });

        const toastAdd = vi.fn();
        const workspaces: Record<string, IWorkspaceExpose> = {
            other: cast<IWorkspaceExpose>({handleSaveAs: async () => {
                await writeFile(savedPath, 'OTHER-DOCUMENT-BYTES');
                return true;
            }}),
            output: cast<IWorkspaceExpose>({handleSaveAs: async () => {
                if (scenario === 'closed-during-dialog') {
                    delete sessions.value.output;
                    return false;
                }
                if (scenario === 'cancelled-dialog') return false;
                await writeFile(savedPath, scenario === 'reopen-same-path'
                    ? 'REOPENED-DOCUMENT-BYTES'
                    : 'CLEANUP-OUTPUT-BYTES');
                return true;
            }}),
        };
        // The notice is created while this document is open. Its action is
        // then used after the reader changes the workspace.
        const save = createScanCleanupOutputSaveAs(
            outputPath,
            computed(() => sessions.value),
            () => undefined,
            {add: toastAdd},
            cast<TTranslateFn>((key: string) => key),
        );
        if (scenario === 'save-as-renamed') {
            output.snapshot.value.identity.documentInstanceId = requireDocumentInstanceId('renamed-document');
            output.snapshot.value.identity.originalPath = requireDocumentRef('/saved/new-name.pdf');
            output.snapshot.value.identity.workingCopyPath = requireDocumentRef('/working/new-name.pdf');
            output.snapshot.value.identity.documentRef = requireDocumentRef('/working/new-name.pdf');
        }
        if (scenario === 'reloaded') {
            output.snapshot.value.identity.workingCopyPath = requireDocumentRef('/working/reloaded.pdf');
            output.snapshot.value.identity.documentRef = requireDocumentRef('/working/reloaded.pdf');
        }
        if (scenario === 'title-renamed') output.snapshot.value.identity.fileName = 'Renamed title';
        if (scenario === 'reopen-same-path') {
            sessions.value.output = cast<IWorkspaceDocumentController>({
                views: output.views,
                snapshot: ref({identity: {
                    documentInstanceId: 'replacement-document',
                    originalPath: outputPath,
                    workingCopyPath: '/working/replacement.pdf',
                    documentRef: '/working/replacement.pdf',
                }}),
            });
        }
        if (scenario === 'moved-window' || scenario === 'closed-before-click') delete sessions.value.output;
        const shouldSave = ![
            'save-as-renamed',
            'moved-window',
            'reopen-same-path',
            'closed-before-click',
            'closed-during-dialog',
            'cancelled-dialog',
        ].includes(scenario);
        const shouldWarn = [
            'save-as-renamed',
            'moved-window',
            'reopen-same-path',
            'closed-before-click',
            'closed-during-dialog',
        ].includes(scenario);
        try {
            const success = await save();
            const bytes = await readFile(savedPath, 'utf8').catch(() => null);
            expect({
                success,
                bytes,
                warnings: toastAdd.mock.calls.map(([toast]) => toast.title),
            }).toEqual({
                success: shouldSave,
                bytes: shouldSave ? 'CLEANUP-OUTPUT-BYTES' : null,
                warnings: shouldWarn ? ['scanCleanup.outputClosedBeforeSaveAs'] : [],
            });
        } finally {
            await rm(scratch, {
                recursive: true,
                force: true,
            });
        }
    });

});
