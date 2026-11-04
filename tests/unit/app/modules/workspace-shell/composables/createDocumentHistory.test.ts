import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    ref, shallowRef, watch,
} from 'vue';
import {createDocumentOpenFlow} from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import {
    createDocumentViews, type IDocumentViewPort,
} from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import {createWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {prepareDocumentViewsForRevisionSwap} from '@app/modules/workspace-shell/document-sessions/prepareDocumentViewsForRevisionSwap';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import {usePdfHistory} from '@app/modules/pdf-viewer/runtime/composables/usePdfHistory';
import {createDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {createDefaultWorkspaceToolbarSnapshot} from '@app/types/workspaceExpose';
import {createTabViewSessionState} from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import {
    createEpochGuard, createDocumentSessionState,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {setBrowserPlatformApi} from '@app/utils/platform';
import {createPlatformApiFixture} from '@tests/helpers/createPlatformApiFixture';
import {cast} from '@tests/helpers/cast';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import {
    createDocumentHistory,
    type IPdfLoadedState,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

function createHistoryHarness(isDesktopRuntime = false) {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(isDesktopRuntime) });
    state.workingCopyPath.value = requireDocumentRef('/tmp/work.pdf');
    state.originalPath.value = requireDocumentRef('/tmp/original.pdf');
    state.documentRevisionToken.value = requireDocumentRevisionToken('revision-before-restore');

    const documentFiles = {
        writeFile: vi.fn(async () => true),
        getDocumentRevision: vi.fn(async () => ({
            version: 1 as const,
            documentRef: requireDocumentRef('/tmp/history.pdf'),
            token: requireDocumentRevisionToken('revision-before-restore'),
            contentRevision: 1,
            authority: 'electron-working-copy' as const,
            mintedAt: requireEpochMs(1),
        })),
        statFile: vi.fn(async () => ({size: 1})),
        savePdfData: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
    };
    const documentWorkingCopy = {
        cleanupFile: vi.fn(async () => undefined),
        createWorkingCopyFromData: vi.fn(async () => requireDocumentRef('/tmp/history.pdf')),
        createWorkingCopyFromPath: vi.fn(async () => requireDocumentRef('/tmp/history.pdf')),
    };
    const applyLoadedPdfState = vi.fn(async () => undefined);

    const history = createDocumentHistory(state, {
        applyLoadedPdfState,
        clearPdfConformanceProfile: vi.fn(),
        clearOcrCache: vi.fn(),
        deferPdfConformanceProfile: vi.fn(),
        documentFiles: () => documentFiles,
        documentWorkingCopy: () => documentWorkingCopy,
        getOpenEpoch: () => 1,
        isCurrentOpenEpoch: () => true,
        readPdfStateFromPath: vi.fn(async (): Promise<IPdfLoadedState> => ({
            pdfData: new Uint8Array([3]),
            pdfSrc: {
                kind: 'path',
                path: requireDocumentRef('/tmp/history.pdf'),
                size: 1,
            },
        })),
        toPdfBlob: vi.fn(() => new Blob()),
    });

    return {
        applyLoadedPdfState,
        documentFiles,
        documentWorkingCopy,
        history,
        state,
    };
}

function createContentHistoryHarness(pathHistory: boolean, withSurface: boolean) {
    vi.stubGlobal('useToast', () => ({
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
    }));
    const state = createDocumentSessionState({isDesktopRuntime: ref(pathHistory)});
    const work = requireDocumentRef('/tmp/content-work.pdf');
    state.workingCopyPath.value = work;
    state.originalPath.value = requireDocumentRef('/tmp/content-original.pdf');
    const encode = (pages: string[]) => new TextEncoder().encode(JSON.stringify(pages));
    const storage = new Map<TDocumentRef, Uint8Array>([[
        work,
        encode([
            'A',
            'B',
            'C',
        ]),
    ]]);
    let serial = 0;
    let revisionNumber = 1;
    const size = pathHistory ? 64 * 1024 * 1024 : 16;
    const revision = (path: TDocumentRef) => ({
        version: 1 as const,
        documentRef: path,
        token: requireDocumentRevisionToken(`content-revision-${revisionNumber}`),
        contentRevision: revisionNumber,
        authority: 'electron-working-copy' as const,
        mintedAt: requireEpochMs(1),
    });
    state.documentRevisionToken.value = revision(work).token;
    const files = {
        writeFile: vi.fn(async (path: TDocumentRef, bytes: Uint8Array) => {
            storage.set(path, bytes.slice());
            revisionNumber++;
            return true;
        }),
        getDocumentRevision: async (path: TDocumentRef) => revision(path),
        statFile: async () => ({size}),
        savePdfData: async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        }),
    };
    setBrowserPlatformApi(createPlatformApiFixture({
        backend: 'browser',
        overrides: {documentFiles: files},
    }));
    const workingCopies = {
        cleanupFile: async (path: TDocumentRef) => {storage.delete(path);},
        createWorkingCopyFromPath: async (path: TDocumentRef) => {
            const next = requireDocumentRef(`/tmp/content-copy-${++serial}.pdf`);
            storage.set(next, storage.get(path)!.slice());
            return next;
        },
        createWorkingCopyFromData: async (_name: string, bytes: Uint8Array) => {
            const next = requireDocumentRef(`/tmp/content-copy-${++serial}.pdf`);
            storage.set(next, bytes.slice());
            return next;
        },
    };
    const readState = async (path: TDocumentRef): Promise<IPdfLoadedState> => ({
        pdfData: pathHistory ? null : storage.get(path)!,
        pdfSrc: pathHistory ? {
            kind: 'path',
            path,
            size,
        } : new Blob([storage.get(path)!.slice()]),
    });
    const controller = createWorkspaceDocumentController({tabId: 'one'});
    controller.addView('two');
    const toolbar = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        currentPage: 1,
        totalPages: 3,
    };
    controller.addView('cold', {
        toolbarSnapshot: toolbar,
        viewState: createTabViewSessionState(toolbar),
        readingAnchor: {
            page: 1,
            pageXFraction: 0.2,
            pageYFraction: 0.7,
            viewportXFraction: 0.3,
            viewportYFraction: 0.4,
            affinity: 'center',
        },
    });
    const views = createDocumentViews(controller);
    const pages = [
        ref(3),
        ref(2),
    ];
    const surface = createDocumentOpenSurfaceSession();
    const pdfDocument = shallowRef<IPdfDocument | null>(cast({id: 0}));
    const viewer = {
        scrollToPage: (page: number) => {pages[0]!.value = page;},
        waitForViewerLoadSettled: async () => undefined,
    };
    for (const [
        index,
        tabId,
    ] of [
            'one',
            'two',
        ].entries()) {
        const detach = views.attachView(cast<IDocumentViewPort>({
            tabId,
            isActive: ref(index === 0),
            openSurface: surface,
            view: {
                currentPage: pages[index],
                pdfViewerRef: shallowRef({
                    ...viewer,
                    preparePageMutationRevisionSwap: async () => false,
                }),
            },
        }));
        onTestFinished(detach);
    }
    const flow = createDocumentOpenFlow(state, {
        cleanupAbandonedWorkingCopy: workingCopies.cleanupFile,
        cleanupPreviousWorkingCopy: async () => undefined,
        clearPdfConformanceProfile: () => undefined,
        deferPdfConformanceProfile: () => undefined,
        incrementSessionVersion: () => history.incrementSessionVersion(),
        ensureHistoryBaselineForMutation: () => history.ensureHistoryBaselineForMutation(),
        loadEpoch: createEpochGuard(),
        openEpoch: createEpochGuard(),
        pushHistorySnapshot: (...args) => history.pushHistorySnapshot(...args),
        resetHistory: (...args) => history.resetHistory(...args),
        syncDirtyFromHistory: () => history.syncDirtyFromHistory(),
        t: (key, ..._args) => String(key),
    });
    const history = createDocumentHistory(state, {
        applyLoadedPdfState: (...args) => flow.applyLoadedPdfState(...args),
        prepareHistoryRevisionSwap: async (token, delta) => {
            if (delta) views.mapPageIdentity(delta);
            await prepareDocumentViewsForRevisionSwap(views, views.viewPorts.value.get('one')!.view.pdfViewerRef.value,
                {
                    documentRevision: token,
                    invalidatedPages: [
                        1,
                        2,
                        3,
                    ],
                    ...(delta ? {pageIdentityDelta: delta} : {}),
                });
        },
        clearPdfConformanceProfile: () => undefined,
        clearOcrCache: () => undefined,
        deferPdfConformanceProfile: () => undefined,
        documentFiles: () => files,
        documentWorkingCopy: () => workingCopies,
        getOpenEpoch: () => 1,
        isCurrentOpenEpoch: () => true,
        readPdfStateFromPath: readState,
        toPdfBlob: bytes => new Blob([bytes.slice()]),
    });
    const ledger = useWorkspaceCommandLedger();
    history.setWorkspaceCommandSink({
        register: ledger.registerCommand,
        reset: ledger.resetSource,
        forget: ledger.forgetSourceEntries,
    });
    const publishSurface = () => {
        const token = `loaded-${++serial}`;
        const generation = surface.begin({
            documentId: 'same-content',
            documentRevision: token,
        });
        surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = surface.createRenderFence({
            generation,
            documentRevision: token,
            renderVersion: 1,
            requestId: serial,
            pageNumber: 1,
        })!;
        surface.commitCanvas(fence);
        surface.commitViewport({
            ...fence,
            documentGeometryRevision: 1,
            interactionEpoch: 0,
            left: 0,
            top: 0,
        });
        surface.markReady(fence);
    };
    publishSurface();
    const ui = usePdfHistory({
        pdfDocument,
        pdfViewerRef: shallowRef(viewer),
        ...(withSurface ? {openSurface: surface} : {}),
        currentPage: pages[0]!,
        isAnySaving: ref(false),
        prepareHistory: () => undefined,
        mapHistoryPage: (direction, page) => history.mapHistoryPage?.(direction, page) ?? page,
        canUndo: ledger.canUndoTimeline,
        canRedo: ledger.canRedoTimeline,
        nextUndoSource: ledger.nextUndoSource,
        nextRedoSource: ledger.nextRedoSource,
        workingCopyPath: state.workingCopyPath,
        resetSearchCache: () => undefined,
        clearOcrCache: () => undefined,
        undoHistory: ledger.undoTimeline,
        redoHistory: ledger.redoTimeline,
    });
    const content = () => JSON.parse(new TextDecoder().decode(state.pdfData.value ?? storage.get(state.workingCopyPath.value!)!)) as string[];
    const readViews = () => ({
        mounted: pages.map(page => ({
            page: page.value,
            text: content()[page.value - 1],
        })),
        cold: {
            page: controller.getView('cold')!.viewState.value.currentPage,
            text: content()[(controller.getView('cold')!.viewState.value.currentPage ?? 1) - 1],
            anchor: controller.getView('cold')!.readingAnchor.value,
        },
    });
    return {
        state,
        history,
        ui,
        pages,
        files,
        readState,
        work,
        encode,
        storage,
        revision,
        readViews,
        views,
        observeLoads: () => {
            const stop = watch(state.pdfSrc, () => {
                pages[0]!.value = 1;
                pdfDocument.value = cast({id: ++serial});
                publishSurface();
            }, {flush: 'sync'});
            onTestFinished(stop);
        },
    };
}

describe('createDocumentHistory', () => {
    it.each([
        false,
        true,
    ].flatMap(pathHistory => [
        false,
        true,
    ].flatMap(withSurface => [
        'unchanged',
        'replacement',
        'lazy',
    ].map(save => ({
        pathHistory,
        withSurface,
        save,
    })))))(
        'keeps each current content page through history (path=$pathHistory, surface=$withSurface, save=$save)', async ({
            pathHistory, withSurface, save,
        }) => {
            const h = createContentHistoryHarness(pathHistory, withSurface);
            const initial = await h.readState(h.work);
            h.state.pdfSrc.value = initial.pdfSrc;
            h.state.pdfReloadSrc.value = initial.pdfSrc;
            h.state.pdfData.value = initial.pdfData;
            await h.history.ensureHistoryBaselineForMutation();
            const delta: IPageIdentityDelta = {
                previousPageCount: 3,
                nextPageCount: 2,
                ranges: [
                    {
                        kind: 'delete',
                        fromPageNumber: 1,
                        count: 1,
                    },
                    {
                        kind: 'retain',
                        fromPageNumber: 2,
                        toPageNumber: 1,
                        count: 2,
                    },
                ],
            };
            h.storage.set(h.work, h.encode([
                'B',
                'C',
            ]));
            await h.history.reloadWorkingCopyIntoHistory({
                markDirty: true,
                pageIdentityDelta: delta,
            });
            // Forward edit is already complete. Map what both readers see now,
            // rather than giving history positions saved at the edit's start.
            h.pages[0]!.value = 2;
            h.pages[1]!.value = 1;
            if (save === 'replacement') {
                const saved = h.encode([
                    'B',
                    'C',
                ]);
                // Distinct bytes for the same content force Save's entry replacement.
                const padded = new Uint8Array([
                    ...saved,
                    32,
                ]);
                await h.files.writeFile(h.state.workingCopyPath.value!, padded);
                await h.history.markCurrentHistoryEntryClean(padded, {recordSnapshotChange: false});
            } else if (save === 'lazy') {
                await h.history.markCurrentHistoryEntryClean(null, {
                    recordSnapshotChange: false,
                    lazyBaseline: {
                        workingPath: h.state.workingCopyPath.value!,
                        revision: h.revision(h.state.workingCopyPath.value!).token,
                        size: pathHistory ? 64 * 1024 * 1024 : 16,
                    },
                });
            }
            h.observeLoads();
            expect(await h.ui.handleUndo()).toBe(true);
            expect(h.readViews()).toMatchObject({
                mounted: [
                    {
                        page: 3,
                        text: 'C',
                    },
                    {
                        page: 2,
                        text: 'B',
                    },
                ],
                cold: {
                    page: 2,
                    text: 'B',
                    anchor: {
                        page: 2,
                        pageXFraction: 0.2,
                        pageYFraction: 0.7,
                        viewportXFraction: 0.3,
                        viewportYFraction: 0.4,
                    },
                },
            });
            h.pages[1]!.value = 3;
            expect(await h.ui.handleRedo()).toBe(true);
            expect(h.readViews()).toMatchObject({
                mounted: [
                    {
                        page: 2,
                        text: 'C',
                    },
                    {
                        page: 2,
                        text: 'C',
                    },
                ],
                cold: {
                    page: 1,
                    text: 'B',
                    anchor: {
                        page: 1,
                        pageYFraction: 0.7,
                    },
                },
            });
            expect(await h.ui.handleUndo()).toBe(true);
            // A new structural edit after Undo discards the old redo transition.
            const current = h.state.workingCopyPath.value!;
            h.storage.set(current, h.encode([
                'C',
                'A',
                'B',
            ]));
            const moveDelta: IPageIdentityDelta = {
                previousPageCount: 3,
                pages: [
                    {fromPageNumber: 3},
                    {fromPageNumber: 1},
                    {fromPageNumber: 2},
                ],
            };
            h.views.mapPageIdentity(moveDelta);
            await h.history.reloadWorkingCopyIntoHistory({
                markDirty: true,
                pageIdentityDelta: moveDelta,
            });
            expect(h.history.canRedo.value).toBe(false);
            expect(await h.ui.handleRedo()).toBe(false);
            expect(await h.ui.handleUndo()).toBe(true);
            expect(h.readViews()).toMatchObject({
                mounted: [
                    {
                        page: 3,
                        text: 'C',
                    },
                    {
                        page: 3,
                        text: 'C',
                    },
                ],
                cold: {
                    page: 2,
                    text: 'B',
                },
            });
            expect(await h.ui.handleRedo()).toBe(true);
            expect(h.readViews()).toMatchObject({
                mounted: [
                    {
                        page: 1,
                        text: 'C',
                    },
                    {
                        page: 1,
                        text: 'C',
                    },
                ],
                cold: {
                    page: 3,
                    text: 'B',
                },
            });
        });

    it('keeps a recovered dirty baseline when history has no entries', () => {
        const {
            history,
            state,
        } = createHistoryHarness(true);
        state.recoveryDirtyBaseline.value = true;

        history.syncDirtyFromHistory();

        expect(state.isDirty.value).toBe(true);
    });

    it('keeps 2+ GiB desktop path history in managed files without a byte snapshot', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const largeDocumentSize = (2 * 1024 * 1024 * 1024) + 1;
        state.pdfSrc.value = {
            kind: 'path',
            path: requireDocumentRef('/tmp/work.pdf'),
            size: largeDocumentSize,
        };
        state.pdfReloadSrc.value = state.pdfSrc.value;
        documentWorkingCopy.createWorkingCopyFromPath
            .mockResolvedValueOnce(requireDocumentRef('/tmp/large-history-baseline.pdf'))
            .mockResolvedValueOnce(requireDocumentRef('/tmp/large-history-next.pdf'));

        await expect(history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true})).resolves.toBe(true);
        await expect(history.pushHistorySnapshot(new Uint8Array([2]), {reuseSnapshot: true})).resolves.toBe(true);

        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 2,
            historyIndex: 1,
            historyCleanIndex: 0,
        });
        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            1,
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            2,
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(documentWorkingCopy.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(documentFiles.savePdfData).not.toHaveBeenCalled();
    });

    it('cleans a canceled desktop path history clone', async () => {
        const {
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        state.pdfSrc.value = {
            kind: 'path',
            path: requireDocumentRef('/tmp/work.pdf'),
            size: 2 * 1024 * 1024 * 1024,
        };
        const staging = Promise.withResolvers<TDocumentRef>();
        documentWorkingCopy.createWorkingCopyFromPath.mockReturnValueOnce(staging.promise);
        let isCurrent = true;

        const reset = history.resetHistory(new Uint8Array([1]), {
            reuseSnapshot: true,
            isCurrent: () => isCurrent,
        });
        await vi.waitFor(() => {
            expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledOnce();
        });
        isCurrent = false;
        staging.resolve(requireDocumentRef('/tmp/canceled-history.pdf'));

        await expect(reset).resolves.toBe(false);
        expect(documentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/canceled-history.pdf');
        expect(history.getHistoryDebugState().historyLength).toBe(0);
    });

    it('cleans a failed lazy desktop path history clone', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
        } = createHistoryHarness(true);
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: requireDocumentRef('/tmp/work.pdf'),
                revision: requireDocumentRevisionToken('revision-before-restore'),
                size: 2 * 1024 * 1024 * 1024,
            },
            recordSnapshotChange: false,
        });
        documentWorkingCopy.createWorkingCopyFromPath.mockResolvedValueOnce(requireDocumentRef('/tmp/failed-history.pdf'));
        documentFiles.getDocumentRevision
            .mockResolvedValueOnce({
                version: 1,
                documentRef: requireDocumentRef('/tmp/work.pdf'),
                token: requireDocumentRevisionToken('revision-before-restore'),
                contentRevision: 1,
                authority: 'electron-working-copy',
                mintedAt: requireEpochMs(1),
            })
            .mockRejectedValueOnce(new Error('revision read failed'));

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(false);
        expect(documentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/failed-history.pdf');
    });

    it('keeps every undo step of a browser document whose snapshots exceed the in-memory budget', async () => {
        const {history} = createHistoryHarness(false);
        const snapshot = (fill: number) => new Uint8Array(10 * 1024 * 1024).fill(fill);
        await expect(history.resetHistory(snapshot(0), {reuseSnapshot: true})).resolves.toBe(true);
        for (let step = 1; step <= 3; step += 1) {
            await expect(history.pushHistorySnapshot(snapshot(step), {reuseSnapshot: true})).resolves.toBe(true);
        }
        expect(history.getHistoryDebugState()).toMatchObject({
            historyLength: 4,
            historyIndex: 3,
        });
        for (let step = 0; step < 3; step += 1) {
            await expect(history.undo()).resolves.toBe(true);
        }
        expect(history.canUndo.value).toBe(false);
        expect(history.canRedo.value).toBe(true);
    });

    it('keeps document open viable when an oversized baseline cannot be staged', async () => {
        const {
            documentWorkingCopy,
            history,
        } = createHistoryHarness(true);
        documentWorkingCopy.createWorkingCopyFromPath.mockRejectedValueOnce(new Error('staging failed'));

        await expect(history.resetHistory(
            new Uint8Array((16 * 1024 * 1024) + 1),
            { reuseSnapshot: true },
        )).resolves.toBe(true);

        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 0,
            historyIndex: 0,
            historyCleanIndex: -1,
        });
    });

    it('rejects oversized byte entries supplied through the public history entry API', () => {
        const {history} = createHistoryHarness();

        expect(history.pushHistoryEntry({
            kind: 'bytes',
            snapshot: new Uint8Array((16 * 1024 * 1024) + 1),
        })).toBe(false);
        expect(history.getHistoryDebugState().historyLength).toBe(0);
    });

    it('publishes file checkpoints directly to the workspace command sink', async () => {
        const {history} = createHistoryHarness();
        const registrations: Array<{
            source: string;
            estimatedBytes?: number;
            undo: () => Promise<boolean>;
            cmd: () => Promise<boolean>;
        }> = [];
        const reset = vi.fn();
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command as typeof registrations[number]),
            reset,
            forget: vi.fn(),
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.pushHistorySnapshot(new Uint8Array([
            2,
            3,
        ]), {reuseSnapshot: true});

        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            source: 'file',
            estimatedBytes: 2,
        });
        await expect(registrations[0]?.undo()).resolves.toBe(true);
        await expect(registrations[0]?.cmd()).resolves.toBe(true);

        history.incrementSessionVersion();
        expect(reset).toHaveBeenCalledWith();
    });

    it('keeps the undo cursor unchanged when restoring bytes fails', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);

        documentFiles.writeFile.mockRejectedValueOnce(new Error('write failed'));

        await expect(history.undo()).rejects.toThrow('write failed');
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
    });

    it('restores byte history with the current document revision token', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });

        await expect(history.undo()).resolves.toBe(true);

        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore') },
        );
    });

    it('restores byte-identical checkpoints through an undo and redo round trip', async () => {
        const {
            documentFiles,
            history,
            state,
        } = createHistoryHarness();
        const before = new Uint8Array([
            37,
            80,
            68,
            70,
            45,
            49,
            46,
            55,
            10,
            1,
            2,
            3,
        ]);
        const after = new Uint8Array([
            37,
            80,
            68,
            70,
            45,
            49,
            46,
            55,
            10,
            9,
            8,
            7,
        ]);
        await history.resetHistory(before, {reuseSnapshot: true});
        await history.pushHistorySnapshot(after, {reuseSnapshot: true});

        await expect(history.undo()).resolves.toBe(true);
        expect(documentFiles.writeFile).toHaveBeenLastCalledWith(
            '/tmp/work.pdf',
            before,
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore')},
        );
        expect(state.pdfData.value).toEqual(before);

        await expect(history.redo()).resolves.toBe(true);
        expect(documentFiles.writeFile).toHaveBeenLastCalledWith(
            '/tmp/work.pdf',
            after,
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore')},
        );
        expect(state.pdfData.value).toEqual(after);
    });

    it('propagates missing revision rejection when byte history restore has no token', async () => {
        const {
            documentFiles,
            history,
            state,
        } = createHistoryHarness();
        state.documentRevisionToken.value = null;

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        documentFiles.writeFile.mockRejectedValueOnce(createMissingRevisionError({documentRef: requireDocumentRef('/tmp/work.pdf')}));

        await expect(history.undo()).rejects.toMatchObject({ code: 'MISSING_REVISION' });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            undefined,
        );
    });

    it('propagates stale revision rejection when byte history restore uses an old token', async () => {
        const {
            documentFiles,
            history,
        } = createHistoryHarness();

        await history.resetHistory(new Uint8Array([1]), { reuseSnapshot: true });
        await history.pushHistorySnapshot(new Uint8Array([2]), { reuseSnapshot: true });
        documentFiles.writeFile.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            expectedRevision: requireDocumentRevisionToken('revision-before-restore'),
            actualRevision: requireDocumentRevisionToken('revision-after-edit'),
        }));

        await expect(history.undo()).rejects.toMatchObject({ code: 'STALE_REVISION' });
        expect(history.getHistoryDebugState().historyIndex).toBe(1);
        expect(documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            new Uint8Array([1]),
            { expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-restore') },
        );
    });

    it('restores path-backed external mutations to the clean baseline on undo', async () => {
        const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
        state.workingCopyPath.value = requireDocumentRef('/tmp/work.pdf');
        state.originalPath.value = requireDocumentRef('/tmp/original.pdf');
        state.documentRevisionToken.value = requireDocumentRevisionToken('revision-before-restore');

        const createWorkingCopyFromPath = vi.fn()
            .mockResolvedValueOnce(requireDocumentRef('/tmp/history-baseline.pdf'))
            .mockResolvedValueOnce(requireDocumentRef('/tmp/history-ocr.pdf'))
            .mockResolvedValueOnce(requireDocumentRef('/tmp/restored-work.pdf'));
        const readPdfStateFromPath = vi.fn(async (path: TDocumentRef): Promise<IPdfLoadedState> => ({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path,
                size: 64 * 1024 * 1024,
            },
        }));
        const applyLoadedPdfState = vi.fn(async () => true);
        const register = vi.fn();
        const history = createDocumentHistory(state, {
            applyLoadedPdfState,
            clearPdfConformanceProfile: vi.fn(),
            clearOcrCache: vi.fn(),
            deferPdfConformanceProfile: vi.fn(),
            documentFiles: () => ({
                writeFile: vi.fn(async () => true),
                getDocumentRevision: vi.fn(async () => ({
                    version: 1 as const,
                    documentRef: requireDocumentRef('/tmp/history.pdf'),
                    token: requireDocumentRevisionToken('revision-before-restore'),
                    contentRevision: 1,
                    authority: 'electron-working-copy' as const,
                    mintedAt: requireEpochMs(1),
                })),
                statFile: vi.fn(async () => ({size: 64 * 1024 * 1024})),
                savePdfData: vi.fn(async () => ({
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                })),
            }),
            documentWorkingCopy: () => ({
                cleanupFile: vi.fn(async () => undefined),
                createWorkingCopyFromData: vi.fn(async () => requireDocumentRef('/tmp/unused-data-history.pdf')),
                createWorkingCopyFromPath,
            }),
            getOpenEpoch: () => 1,
            isCurrentOpenEpoch: () => true,
            readPdfStateFromPath,
            toPdfBlob: vi.fn(() => new Blob()),
        });
        history.setWorkspaceCommandSink({
            register,
            reset: vi.fn(),
            forget: vi.fn(),
        });

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(true);
        await expect(history.reloadWorkingCopyIntoHistory({markDirty: true})).resolves.toBe(true);

        expect(register).toHaveBeenCalledOnce();
        expect(register.mock.calls[0]?.[0]).toMatchObject({source: 'file'});
        expect(register.mock.calls[0]?.[0]).not.toHaveProperty('estimatedBytes');
        expect(history.canUndo.value).toBe(true);
        expect(state.isDirty.value).toBe(true);
        expect(history.getHistoryDebugState()).toMatchObject({
            historyLength: 2,
            historyIndex: 1,
            historyCleanIndex: 0,
        });

        await expect(history.undo()).resolves.toBe(true);

        expect(state.isDirty.value).toBe(false);
        expect(history.getHistoryDebugState()).toMatchObject({
            historyLength: 2,
            historyIndex: 0,
            historyCleanIndex: 0,
        });
        expect(createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            1,
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(createWorkingCopyFromPath).toHaveBeenNthCalledWith(
            3,
            '/tmp/history-baseline.pdf',
            '/tmp/original.pdf',
        );
        expect(applyLoadedPdfState).toHaveBeenCalledWith(
            '/tmp/restored-work.pdf',
            {
                pdfData: null,
                pdfSrc: {
                    kind: 'path',
                    path: requireDocumentRef('/tmp/restored-work.pdf'),
                    size: 64 * 1024 * 1024,
                },
            },
            expect.objectContaining({
                preserveHistory: true,
                previousPath: '/tmp/work.pdf',
            }),
        );
    });

    it('shares first-mutation staging and records one baseline plus the result', async () => {
        const {
            applyLoadedPdfState,
            documentWorkingCopy,
            history,
        } = createHistoryHarness(true);
        const staging = Promise.withResolvers<TDocumentRef>();
        documentWorkingCopy.createWorkingCopyFromPath.mockReturnValue(staging.promise);

        const first = history.ensureHistoryBaselineForMutation();
        const second = history.ensureHistoryBaselineForMutation();
        await vi.waitFor(() => {
            expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledOnce();
        });

        staging.resolve(requireDocumentRef('/tmp/first-mutation-baseline.pdf'));
        await expect(Promise.all([
            first,
            second,
        ])).resolves.toEqual([
            true,
            true,
        ]);
        await history.pushHistorySnapshot(new Uint8Array([2]), {reuseSnapshot: true});

        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 2,
            historyIndex: 1,
            historyCleanIndex: 0,
        });
        expect(history.canUndo.value).toBe(true);

        await expect(history.undo()).resolves.toBe(true);
        expect(applyLoadedPdfState).toHaveBeenCalledWith(
            '/tmp/first-mutation-baseline.pdf',
            expect.objectContaining({pdfData: new Uint8Array([3])}),
            expect.objectContaining({
                preserveHistory: true,
                previousPath: '/tmp/work.pdf',
            }),
        );
    });

    it('cleans first-mutation staging when the document switches', async () => {
        const {
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const staging = Promise.withResolvers<TDocumentRef>();
        documentWorkingCopy.createWorkingCopyFromPath.mockReturnValue(staging.promise);

        const baseline = history.ensureHistoryBaselineForMutation();
        await vi.waitFor(() => {
            expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledOnce();
        });
        state.workingCopyPath.value = requireDocumentRef('/tmp/next.pdf');
        history.incrementSessionVersion();
        staging.resolve(requireDocumentRef('/tmp/stale-mutation-baseline.pdf'));

        await expect(baseline).resolves.toBe(false);
        expect(documentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/stale-mutation-baseline.pdf');
        expect(history.getHistoryDebugState().historyLength).toBe(0);
    });

    it('materializes a lazy clean baseline before the next external mutation without adding file undo', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const revision = requireDocumentRevisionToken('lazy-history-revision');
        state.documentRevisionToken.value = revision;
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            token: revision,
            contentRevision: 2,
            authority: 'electron-working-copy',
            mintedAt: requireEpochMs(2),
        });
        const register = vi.fn();
        history.setWorkspaceCommandSink({
            register,
            reset: vi.fn(),
            forget: vi.fn(),
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: requireDocumentRef('/tmp/work.pdf'),
                revision,
                size: 128,
            },
            recordSnapshotChange: false,
        });

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(true);

        expect(documentFiles.getDocumentRevision).toHaveBeenCalledTimes(2);
        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(register).not.toHaveBeenCalled();
        expect(history.getHistoryDebugState()).toEqual({
            historyLength: 1,
            historyIndex: 0,
            historyCleanIndex: 0,
        });
    });

    it('refuses to materialize a lazy baseline after its working-copy revision changes', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const baselineRevision = requireDocumentRevisionToken('lazy-history-before');
        state.documentRevisionToken.value = baselineRevision;
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: requireDocumentRef('/tmp/work.pdf'),
                revision: baselineRevision,
                size: 128,
            },
            recordSnapshotChange: false,
        });
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            token: requireDocumentRevisionToken('lazy-history-after'),
            contentRevision: 3,
            authority: 'electron-working-copy',
            mintedAt: requireEpochMs(3),
        });

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(false);

        expect(documentWorkingCopy.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('materializes a lazy redo snapshot before file undo moves the cursor', async () => {
        const {
            documentFiles,
            documentWorkingCopy,
            history,
            state,
        } = createHistoryHarness(true);
        const revision = requireDocumentRevisionToken('lazy-redo-revision');
        state.documentRevisionToken.value = revision;
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            token: revision,
            contentRevision: 4,
            authority: 'electron-working-copy',
            mintedAt: requireEpochMs(4),
        });
        await history.resetHistory(new Uint8Array([1]), {reuseSnapshot: true});
        await history.pushHistorySnapshot(new Uint8Array([2]), {reuseSnapshot: true});
        await history.markCurrentHistoryEntryClean(null, {
            lazyBaseline: {
                workingPath: requireDocumentRef('/tmp/work.pdf'),
                revision,
                size: 256,
            },
            recordSnapshotChange: false,
        });

        await expect(history.undo()).resolves.toBe(true);

        expect(documentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/original.pdf',
        );
        expect(documentWorkingCopy.createWorkingCopyFromPath.mock.invocationCallOrder[0])
            .toBeLessThan(documentFiles.writeFile.mock.invocationCallOrder[0]!);
        expect(history.canRedo.value).toBe(true);
    });
});
