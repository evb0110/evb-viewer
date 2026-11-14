import {createPdfDocumentAnnotations} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import {
    asAnnotationId, type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    ref, shallowRef, watch, effectScope,
} from 'vue';
import {createDocumentOpenFlow} from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import {
    createDocumentViews, type IDocumentViewPort,
} from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import {createWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {prepareDocumentViewsForHistorySwap} from '@app/modules/workspace-shell/document-sessions/prepareDocumentViewsForRevisionSwap';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import {usePdfHistory} from '@app/modules/pdf-viewer/runtime/composables/usePdfHistory';
import {createDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';
import {createDefaultWorkspaceToolbarSnapshot} from '@app/types/workspaceExpose';
import {createTabViewSessionState} from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import {
    createEpochGuard, createDocumentSessionState,
} from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import {setBrowserPlatformApi} from '@app/utils/platform';
import {createPlatformApiFixture} from '@tests/helpers/createPlatformApiFixture';
import {cast} from '@tests/helpers/cast';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import {
    createDocumentHistory,
    type IPdfLoadedState,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';

const revisionToken = (name: string) => requireDocumentRevisionToken(name);

/** A working copy whose revisions undo restores; `mutate` is a page operation that makes the next one. */
function createHistoryHarness(isDesktopRuntime = false) {
    const state = createDocumentSessionState({
            isDesktopRuntime: ref(isDesktopRuntime),
            document: createWorkspaceDocumentController({tabId: 'tab-1'}),
        });
    const work = requireDocumentRef('/tmp/work.pdf');
    state.workingCopyPath.value = work;
    state.originalPath.value = requireDocumentRef('/tmp/original.pdf');
    state.documentRevisionToken.value = revisionToken('revision-1');
    let serial = 1;
    const revisionInfo = () => ({
        version: 1 as const,
        documentRef: work,
        token: state.documentRevisionToken.value!,
        contentRevision: serial,
        authority: 'electron-working-copy' as const,
        mintedAt: requireEpochMs(1),
    });
    const documentFiles = {getDocumentRevision: vi.fn(async () => revisionInfo())};
    const documentWorkingCopy = {
        cleanupFile: vi.fn(async () => undefined),
        restoreDocumentRevision: vi.fn(async (_path: TDocumentRef, revision: TDocumentRevisionToken) => {
            state.documentRevisionToken.value = revision;
            return revisionInfo();
        }),
        retainDocumentRevisions: vi.fn(async (_path: TDocumentRef, _revisions: TDocumentRevisionToken[]) => undefined),
    };
    const applyLoadedPdfState = vi.fn(async () => undefined);

    const history = createDocumentHistory(state, {
        applyLoadedPdfState,
        clearOcrCache: vi.fn(),
        documentFiles: () => documentFiles,
        documentWorkingCopy: () => documentWorkingCopy,
        getOpenEpoch: () => 1,
        isCurrentOpenEpoch: () => true,
        readPdfStateFromPath: vi.fn(async (): Promise<IPdfLoadedState> => ({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path: work,
                size: 1,
            },
        })),
    });

    const ledger = useWorkspaceCommandLedger();
    history.setWorkspaceCommandSink({
        register: ledger.registerCommand,
        reset: ledger.resetSource,
        forget: ledger.forgetSourceEntries,
    });
    const mutate = async () => {
        await history.ensureHistoryBaselineForMutation();
        state.documentRevisionToken.value = revisionToken(`revision-${++serial}`);
        return history.reloadWorkingCopyIntoHistory();
    };
    const retained = () => [...documentWorkingCopy.retainDocumentRevisions.mock.lastCall?.[1] ?? []].sort();
    return {
        applyLoadedPdfState,
        documentFiles,
        documentWorkingCopy,
        mutate,
        retained,
        history: {
            ...history,
            undo: ledger.undoTimeline,
            redo: ledger.redoTimeline,
            canUndo: ledger.canUndoTimeline,
            canRedo: ledger.canRedoTimeline,
            setWorkspaceCommandSink: (sink: Parameters<typeof history.setWorkspaceCommandSink>[0]) => history.setWorkspaceCommandSink(sink ? {
                ...sink,
                register: command => {ledger.registerCommand(command); sink.register(command);},
                reset: source => {ledger.resetSource(source); sink.reset(source);},
                forget: (source, ids) => {ledger.forgetSourceEntries(source, ids); sink.forget(source, ids);},
            } : null),
        },
        state,
        work,
    };
}

function createContentHistoryHarness(pathHistory: boolean, beforeRevisionPrepare?: () => Promise<void>, documentAnnotations?: () => ReturnType<typeof createPdfDocumentAnnotations>) {
    vi.stubGlobal('useToast', () => ({
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
    }));
    const state = createDocumentSessionState({
            isDesktopRuntime: ref(pathHistory),
            document: createWorkspaceDocumentController({tabId: 'tab-1'}),
        });
    const work = requireDocumentRef('/tmp/content-work.pdf');
    state.workingCopyPath.value = work;
    state.originalPath.value = requireDocumentRef('/tmp/content-original.pdf');
    const encode = (pages: string[]) => new TextEncoder().encode(JSON.stringify(pages));
    // The working copy's revisions: a write makes the next one, and only the ones history retains survive.
    let serial = 0;
    let revisionNumber = 1;
    const tokenOf = (number: number) => requireDocumentRevisionToken(`content-revision-${number}`);
    let current = tokenOf(1);
    const revisions = new Map([[current, encode([
        'A',
        'B',
        'C',
    ])]]);
    const storage = {
        get: (_path: TDocumentRef) => revisions.get(current),
        set: (_path: TDocumentRef, bytes: Uint8Array) => {
            current = tokenOf(++revisionNumber);
            revisions.set(current, bytes.slice());
        },
    };
    const size = pathHistory ? 64 * 1024 * 1024 : 16;
    const revision = (path: TDocumentRef) => ({
        version: 1 as const,
        documentRef: path,
        token: current,
        contentRevision: revisionNumber,
        authority: 'electron-working-copy' as const,
        mintedAt: requireEpochMs(1),
    });
    state.documentRevisionToken.value = current;
    const files = {
        writeFile: vi.fn(async (path: TDocumentRef, bytes: Uint8Array) => {
            storage.set(path, bytes);
            return true;
        }),
        getDocumentRevision: async (path: TDocumentRef) => revision(path),
        statFile: async () => ({size}),
    };
    setBrowserPlatformApi(createPlatformApiFixture({
        backend: 'browser',
        overrides: {documentFiles: files},
    }));
    const workingCopies = {
        cleanupFile: async () => undefined,
        restoreDocumentRevision: async (path: TDocumentRef, token: TDocumentRevisionToken) => {
            if (!revisions.has(token)) throw new Error(`Revision ${token} was not retained`);
            current = token;
            return revision(path);
        },
        retainDocumentRevisions: async (_path: TDocumentRef, kept: TDocumentRevisionToken[]) => {
            for (const token of revisions.keys()) {
                if (token !== current && !kept.includes(token)) revisions.delete(token);
            }
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
                    scrollToPage: (page: number) => {pages[index]!.value = page;},
                    preparePageMutationRevisionSwap: async () => {
                        await beforeRevisionPrepare?.();
                        return false;
                    },
                }),
            },
            search: {
                resetSearchCache: () => undefined,
                adoptPageRotation: () => undefined,
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
        loadEpoch: createEpochGuard(),
        openEpoch: createEpochGuard(),
        resetHistory: options => history.resetHistory(options),
        syncDirtyFromHistory: () => history.syncDirtyFromHistory(),
        t: (key, ..._args) => String(key),
    });
    const history = createDocumentHistory(state, {
        ...(documentAnnotations ? {documentAnnotations} : {}),
        applyLoadedPdfState: (...args) => flow.applyLoadedPdfState(...args),
        prepareHistoryRevisionSwap: (token, delta) => prepareDocumentViewsForHistorySwap(
            views, 3, token, delta,
        ),
        clearOcrCache: () => undefined,
        documentFiles: () => files,
        documentWorkingCopy: () => workingCopies,
        getOpenEpoch: () => 1,
        isCurrentOpenEpoch: () => true,
        readPdfStateFromPath: readState,
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
        prepareReload: views.prepareReload,
        isAnySaving: ref(false),
        prepareHistory: () => undefined,
        mapHistoryPage: (direction, page) => history.mapHistoryPage?.(direction, page) ?? page,
        canUndo: ledger.canUndoTimeline,
        canRedo: ledger.canRedoTimeline,
        nextUndoSource: ledger.nextUndoSource,
        nextRedoSource: ledger.nextRedoSource,
        workingCopyPath: state.workingCopyPath,
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
        ledger,
        history: {
            ...history,
            undo: ledger.undoTimeline,
            redo: ledger.redoTimeline,
            canUndo: ledger.canUndoTimeline,
            canRedo: ledger.canRedoTimeline,
        },
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
    ])('leaves every view unchanged when history preparation is superseded (path=%s)', async pathHistory => {
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        onTestFinished(() => { release.resolve(undefined); });
        const h = createContentHistoryHarness(pathHistory, () => {
            entered.resolve(undefined);
            return release.promise;
        });
        const initial = await h.readState(h.work);
        h.state.pdfSrc.value = initial.pdfSrc;
        h.state.pdfReloadSrc.value = initial.pdfSrc;
        h.state.pdfData.value = initial.pdfData;
        await h.history.ensureHistoryBaselineForMutation();
        h.storage.set(h.work, h.encode([
            'B',
            'C',
        ]));
        await h.history.reloadWorkingCopyIntoHistory({pageIdentityDelta: {
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
        }});
        h.pages[0]!.value = 2;
        h.pages[1]!.value = 1;
        const before = h.readViews();
        const source = h.state.pdfSrc.value;
        const undo = h.history.undo();
        await entered.promise;
        // A new document/session takes ownership while the old surface is
        // preparing. Refusing that restore must also refuse its view mapping.
        h.history.incrementSessionVersion();
        release.resolve(undefined);
        await expect(undo).resolves.toBe(false);
        // The working copy took the undo, which the next session reads; the replaced one keeps its views in place.
        const places = (views: typeof before) => ({mounted: views.mounted.map(view => view.page), cold: views.cold.anchor});
        expect(places(h.readViews())).toEqual(places(before));
        expect(h.state.pdfSrc.value).toBe(source);
        expect(h.history.canUndo.value).toBe(false);
    });
    it.each([
        false,
        true,
    ].flatMap(pathHistory => [
        'unchanged',
        'replacement',
        'lazy',
    ].map(save => ({
        pathHistory,
        save,
    }))))(
        'keeps each current content page through history (path=$pathHistory, save=$save)', async ({
            pathHistory, save,
        }) => {
            const h = createContentHistoryHarness(pathHistory);
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
            await h.history.reloadWorkingCopyIntoHistory({pageIdentityDelta: delta});
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
                await h.history.captureHistoryCleanState()();
            } else if (save === 'lazy') {
                await h.history.captureHistoryCleanState()();
            }
            h.observeLoads();
            expect(await h.ui.handleUndo()).toBe(true);
            // A mounted view's page is what its viewer reports; cold views keep theirs here.
            expect(h.readViews()).toMatchObject({
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
            await h.history.reloadWorkingCopyIntoHistory({pageIdentityDelta: moveDelta});
            expect(h.history.canRedo.value).toBe(false);
            expect(await h.ui.handleRedo()).toBe(false);
            expect(await h.ui.handleUndo()).toBe(true);
            expect(h.readViews()).toMatchObject({
                cold: {
                    page: 2,
                    text: 'B',
                },
            });
            expect(await h.ui.handleRedo()).toBe(true);
            expect(h.readViews()).toMatchObject({
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

    it('publishes file checkpoints directly to the workspace command sink', async () => {
        const {history, mutate} = createHistoryHarness();
        const registrations: Array<{
            source: string;
            undo: () => Promise<boolean>;
            cmd: () => Promise<boolean>;
        }> = [];
        const reset = vi.fn();
        history.setWorkspaceCommandSink({
            register: command => registrations.push(command as typeof registrations[number]),
            reset,
            forget: vi.fn(),
        });
        await history.resetHistory();
        await mutate();

        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({source: 'file'});
        await expect(registrations[0]?.undo()).resolves.toBe(true);
        await expect(registrations[0]?.cmd()).resolves.toBe(true);

        history.incrementSessionVersion();
        expect(reset).toHaveBeenLastCalledWith(undefined);
    });

    it('undoes and redoes by restoring revisions of the same working copy, with no copy', async () => {
        const {
            applyLoadedPdfState, documentWorkingCopy, history, mutate, state, work,
        } = createHistoryHarness(true);
        await history.resetHistory();
        await mutate();
        expect(state.isDirty.value).toBe(true);

        await expect(history.undo()).resolves.toBe(true);
        expect(documentWorkingCopy.restoreDocumentRevision).toHaveBeenLastCalledWith(work, revisionToken('revision-1'), {
            expectedDocumentRevisionToken: revisionToken('revision-2'),
        });
        expect(applyLoadedPdfState).toHaveBeenLastCalledWith(work, expect.anything(), expect.objectContaining({preserveHistory: true}));
        expect(applyLoadedPdfState.mock.lastCall).not.toContainEqual(expect.objectContaining({previousPath: expect.anything()}));
        expect(state.isDirty.value).toBe(false);

        await expect(history.redo()).resolves.toBe(true);
        expect(documentWorkingCopy.restoreDocumentRevision).toHaveBeenLastCalledWith(work, revisionToken('revision-2'), {
            expectedDocumentRevisionToken: revisionToken('revision-1'),
        });
        expect(state.workingCopyPath.value).toBe(work);
        expect(state.isDirty.value).toBe(true);
    });

    it('retains exactly the revisions history names: a new edit after an undo and the history limit let go', async () => {
        const {history, mutate, retained} = createHistoryHarness(true);
        await history.resetHistory();
        await mutate();
        await mutate();
        expect(retained()).toEqual(['revision-1', 'revision-2', 'revision-3']);

        await expect(history.undo()).resolves.toBe(true);
        await mutate();
        expect(history.canRedo.value).toBe(false);
        expect(retained()).toEqual(['revision-1', 'revision-2', 'revision-4']);

        for (let step = 0; step < 20; step += 1) await mutate();
        expect(retained()).toHaveLength(20);
        expect(retained()).not.toContain('revision-1');

        history.clearHistory();
        expect(retained()).toEqual([]);
    });

    it('propagates a refused restore', async () => {
        const {documentWorkingCopy, history, mutate} = createHistoryHarness();
        await history.resetHistory();
        await mutate();
        documentWorkingCopy.restoreDocumentRevision.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            expectedRevision: revisionToken('revision-2'),
            actualRevision: revisionToken('revision-after-edit'),
        }));

        await expect(history.undo()).rejects.toMatchObject({code: 'STALE_REVISION'});
    });

    it('shares first-mutation staging and records one baseline plus the result', async () => {
        const {documentFiles, history, mutate} = createHistoryHarness(true);
        const first = history.ensureHistoryBaselineForMutation();
        const second = history.ensureHistoryBaselineForMutation();
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(documentFiles.getDocumentRevision).toHaveBeenCalledOnce();

        await mutate();
        await expect(history.undo()).resolves.toBe(true);
        expect(history.canUndo.value).toBe(false);
    });

    it('refuses first-mutation staging when the document switches meanwhile', async () => {
        const {documentFiles, history, state} = createHistoryHarness(true);
        const revision = Promise.withResolvers<Awaited<ReturnType<typeof documentFiles.getDocumentRevision>>>();
        const info = await documentFiles.getDocumentRevision();
        documentFiles.getDocumentRevision.mockReturnValueOnce(revision.promise);

        const baseline = history.ensureHistoryBaselineForMutation();
        state.workingCopyPath.value = requireDocumentRef('/tmp/next.pdf');
        history.incrementSessionVersion();
        revision.resolve(info);

        await expect(baseline).resolves.toBe(false);
    });

    it('stages the saved revision before the next mutation without adding file undo', async () => {
        const {history, retained} = createHistoryHarness(true);
        const register = vi.fn();
        history.setWorkspaceCommandSink({
            register,
            reset: vi.fn(),
            forget: vi.fn(),
        });
        await history.resetHistory();
        await history.captureHistoryCleanState()();

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(true);

        expect(retained()).toEqual(['revision-1']);
        expect(register).not.toHaveBeenCalled();
    });

    it('refuses to stage a checkpoint after its working-copy revision changes', async () => {
        const {
            documentFiles,
            history,
            state,
        } = createHistoryHarness(true);
        state.documentRevisionToken.value = revisionToken('lazy-history-before');
        await history.captureHistoryCleanState()();
        documentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: requireDocumentRef('/tmp/work.pdf'),
            token: revisionToken('lazy-history-after'),
            contentRevision: 3,
            authority: 'electron-working-copy',
            mintedAt: requireEpochMs(3),
        });

        await expect(history.ensureHistoryBaselineForMutation()).resolves.toBe(false);
    });

    it('keeps redo after an annotation-only Save', async () => {
        const {
            documentWorkingCopy, history, mutate, state,
        } = createHistoryHarness(true);
        await history.resetHistory();
        await mutate();
        await history.captureHistoryCleanState()();
        await expect(history.undo()).resolves.toBe(true);
        expect(documentWorkingCopy.restoreDocumentRevision).toHaveBeenLastCalledWith(expect.anything(), revisionToken('revision-1'), expect.anything());
        await expect(history.redo()).resolves.toBe(true);
        expect(documentWorkingCopy.restoreDocumentRevision).toHaveBeenLastCalledWith(expect.anything(), revisionToken('revision-2'), expect.anything());
        expect(state.isDirty.value).toBe(false);
    });
});

// A3/T2/T4: physical checkpoint replay never owns canonical annotation intent.
describe.each([
    false,
    true,
])('B01 canonical command isolation (path=%s)', path => {
    function setup() {
        const h = createContentHistoryHarness(path, undefined, () => owner);
        const scope = effectScope();
        onTestFinished(() => scope.stop());
        const owner: ReturnType<typeof createPdfDocumentAnnotations> = scope.run(() => createPdfDocumentAnnotations({
            workingCopyPath: h.state.workingCopyPath,
            source: h.state.pdfSrc,
            documentRevisionToken: h.state.documentRevisionToken,
            documentSession: h.history.fileHistorySessionVersion,
        }))!;
        owner.history.setWorkspaceCommandSink({
            register: h.ledger.registerCommand,
            reset: h.ledger.resetSource,
            forget: h.ledger.forgetSourceEntries,
        });
        const note: INoteEntity = {
            kind: 'note',
            identity: {id: asAnnotationId('b01-note')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'Accepted B01 note',
            color: '#ffff00',
            open: false,
            position: {
                left: 0.1,
                top: 0.1,
                width: 0.02,
                height: 0.02,
            },
        };
        const reconcile = (parsed: INoteEntity[] = []) => {
            owner.replaceLoadedDocument(h.state.documentRevisionToken.value, false);
            return owner.application.value.store.replaceFromDocument(parsed, [], undefined, [], [], true);
        };
        const mutate = async (label: string, pageIdentityDelta?: IPageIdentityDelta) => {
            await h.files.writeFile(h.state.workingCopyPath.value!, h.encode([label]));
            h.state.documentRevisionToken.value = (await h.files.getDocumentRevision(h.state.workingCopyPath.value!)).token;
            if (label === 'OCR text') owner.adoptCurrentRevision();
            return h.history.reloadWorkingCopyIntoHistory({...(pageIdentityDelta ? {pageIdentityDelta} : {})});
        };
        return {
            ...h,
            owner,
            get store() {return owner.application.value.store;},
            note,
            reconcile,
            mutate,
        };
    }

    it('A26-1 keeps materialization unsaved and the original annotation Undo available', async () => {
        const h = setup();
        await h.history.ensureHistoryBaselineForMutation();
        h.store.createNote(h.note);
        h.store.markPersisted(h.store.beginSave(), [], null, true);
        await h.history.reloadWorkingCopyRevision();
        await h.mutate('rotated');
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        h.reconcile();
        expect(h.store.list().filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual(['Accepted B01 note']);
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(h.ledger.nextUndoSource.value).toBe('annotation');
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(h.store.list()).toEqual([]);
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('A26-2 keeps accepted notes and drafts through both OCR inverse directions', async () => {
        const h = setup();
        h.store.createNote(h.note);
        h.owner.setTextBoxDraft('b01-draft', 'Uncommitted text');
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('OCR text');
        h.reconcile();
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        h.reconcile();
        expect(h.store.list().filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual(['Accepted B01 note']);
        expect(h.owner.textBoxDrafts.get('b01-draft')).toBe('Uncommitted text');
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        h.reconcile();
        expect(h.store.list().filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual(['Accepted B01 note']);
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(true);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(h.store.list()).toEqual([]);
    });

    it('keeps the captured save frontier dirty after a newer file command and ignores a replaced session', async () => {
        const h = setup();
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('rotated');
        const acknowledge = h.history.captureHistoryCleanState();
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('cropped');
        await acknowledge();
        expect(h.state.isDirty.value).toBe(true);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(h.state.isDirty.value).toBe(false);
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(h.state.isDirty.value).toBe(true);
        const stale = h.history.captureHistoryCleanState();
        h.history.incrementSessionVersion();
        await h.history.resetHistory();
        h.state.recoveryDirtyBaseline.value = true;
        await stale();
        h.history.syncDirtyFromHistory();
        expect(h.state.isDirty.value).toBe(true);
    });

    it('keeps a later file command before-checkpoint separate from an earlier command after-checkpoint', async () => {
        const h = setup();
        const content = () => JSON.parse(new TextDecoder().decode(h.state.pdfData.value ?? h.storage.get(h.state.workingCopyPath.value!)!));
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('rotation only');
        const materialized = h.encode(['rotation with saved note']);
        await h.files.writeFile(h.state.workingCopyPath.value!, materialized);
        h.state.documentRevisionToken.value = (await h.files.getDocumentRevision(h.state.workingCopyPath.value!)).token;
        h.state.pdfData.value = path ? null : materialized;
        await h.history.captureHistoryCleanState()();
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('crop with saved note');
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(content()).toEqual(['rotation with saved note']);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(content()).toEqual(['rotation only']);
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(content()).toEqual(['crop with saved note']);
    });

    it('releases saved deletion targets when their last file command is discarded', async () => {
        const h = setup();
        h.store.createNote(h.note);
        h.store.markPersisted(h.store.beginSave());
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('rotated');
        h.store.delete(h.note.identity.id);
        h.store.markPersisted(h.store.beginSave());
        h.ledger.resetSource('annotation');
        expect(h.store.get(h.note.identity.id)?.deleted).toBe(true);
        h.ledger.resetSource('file');
        expect(h.store.get(h.note.identity.id)).toBeNull();
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('resets notes, drafts and commands for a genuine replacement of the same pathname', async () => {
        const h = setup();
        h.store.createNote(h.note);
        h.owner.setTextBoxDraft('draft', 'pending');
        h.history.incrementSessionVersion();
        expect(h.store.list()).toEqual([]);
        expect(h.owner.textBoxDrafts.size).toBe(0);
        expect(h.ledger.canUndoTimeline.value).toBe(false);
    });

    it('replays structural deletion without losing the annotation command or duplicating it', async () => {
        const h = setup();
        h.store.createNote(h.note);
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('remaining pages', {
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
        });
        h.reconcile();
        expect(h.store.list()).toEqual([]);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        h.reconcile();
        expect(h.store.list().filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual(['Accepted B01 note']);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(h.store.list()).toEqual([]);
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(h.store.list()).toEqual([]);
    });

    it('restores the annotations of an Insert exactly as they were before it on Undo and after it on Redo', async () => {
        const h = setup();
        const inserted: INoteEntity = {
            ...h.note,
            identity: {
                id: asAnnotationId('inserted-page-note'),
                pdfRef: '20R',
            },
            pageIndex: requirePageIndex(1),
            persistedRevision: 0,
            contents: 'Inserted page note',
        };
        h.store.createNote(h.note);
        await h.history.ensureHistoryBaselineForMutation();
        const beforeInsert = h.store.list({includeDeleted: true});
        await h.mutate('inserted', {
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 1},
                {insertedId: 'inserted-page'},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
            ],
        });
        h.reconcile([inserted]);
        const afterInsert = h.store.list({includeDeleted: true});
        expect(afterInsert.filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual([
            'Accepted B01 note',
            'Inserted page note',
        ]);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        expect(h.store.list({includeDeleted: true})).toEqual(beforeInsert);
        h.reconcile();
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(h.store.list({includeDeleted: true})).toEqual(afterInsert);
        h.reconcile([inserted]);
        expect(h.store.list({includeDeleted: true})).toEqual(afterInsert);
    });

    it('A26-3 keeps a saved note undone until its own Redo and requires writer work after older bytes', async () => {
        const h = setup();
        await h.history.ensureHistoryBaselineForMutation();
        await h.mutate('rotated');
        h.store.createNote(h.note);
        h.store.markPersisted(h.store.beginSave());
        await h.history.captureHistoryCleanState()();
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        await expect(h.ledger.undoTimeline()).resolves.toBe(true);
        h.reconcile();
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        h.reconcile();
        expect(h.store.list()).toEqual([]);
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(h.ledger.nextRedoSource.value).toBe('annotation');
        await expect(h.ledger.redoTimeline()).resolves.toBe(true);
        expect(h.store.list().filter(entity => entity.kind === 'note').map(entity => entity.contents)).toEqual(['Accepted B01 note']);
        expect(h.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(h.store.dirtyEntities()).toHaveLength(1);
    });
});
