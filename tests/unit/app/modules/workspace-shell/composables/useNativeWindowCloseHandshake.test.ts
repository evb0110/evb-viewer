import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    shallowRef,
    type ShallowRef,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {
    IWindowCloseRequest,
    TWindowCloseDecision,
    TWindowCloseRequestHandler,
} from '@contracts/systemPlatformFeature';
import type { TPdfSource } from '@app/types/pdfUi';
import type * as TRecentReadingViewModule from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import {
    createPdfDocumentSessionSlot,
    type IPdfSourceJob,
    type TPdfSourceJobIntent,
} from '@app/modules/pdf-viewer/public';
import { settlePdfSourceJob } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSessionSlot';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createDocumentJobReleaser } from '@app/modules/workspace-shell/document-sessions/documentJobRelease';
import { useNativeWindowCloseHandshake } from '@app/modules/workspace-shell/composables/useNativeWindowCloseHandshake';
import {
    bindTestDocumentFrontier,
    createWorkspaceExposeFixture,
    setTestDocumentDirty,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));
vi.mock('@app/modules/workspace-shell/document-sessions/recentReadingView', async importOriginal => ({
    ...await importOriginal<typeof TRecentReadingViewModule>(),
    rememberReadingView: vi.fn(async () => undefined),
}));
vi.stubGlobal('useToast', () => ({
    add: vi.fn(() => ({id: 'toast'})),
    remove: vi.fn(),
}));
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * One open document matching `documentContext.ts` + `useWorkspaceSaveService.ts`:
 * - A reader loads each source it is given unless the test holds that read, as a slow disk does.
 * - Save runs inside `controller.operationLease.runExclusive('save', ...)`, calls `jobReleaser.republishForSave()`
 *   before awaiting `slot.running()?.finished`, resolves its durable result before awaiting post-save adoption,
 *   and holds the lease until adoption settles (or is released).
 */
function createDocument(options: {
    tabId?: string;
    fileName?: string;
    saveFails?: boolean;
} = {}) {
    const tabId = options.tabId ?? 'tab-a';
    const fileName = options.fileName ?? 'sample.pdf';
    const controller = createWorkspaceDocumentController({
        tabId,
        assignment: {
            fileName,
            originalPath: requireDocumentRef(`/tmp/${fileName}`),
            isDirty: false,
            isDjvu: false,
        },
    });
    const workingCopyPath = shallowRef<unknown>(null);
    const pdfSrc: ShallowRef<TPdfSource | null> = shallowRef(null);
    const slot = createPdfDocumentSessionSlot({src: pdfSrc});
    const jobs: Array<{
        job: IPdfSourceJob;
        source: TPdfSource | null;
    }> = [];
    let holdsRead = (_job: IPdfSourceJob) => false;
    // The PDF the view can plan a Save from: the last source it finished loading, gone once a newer one starts.
    let loaded: {
        job: IPdfSourceJob;
        source: TPdfSource | null;
    } | null = null;
    const publish = (source: TPdfSource | null, intent: TPdfSourceJobIntent) => {
        pdfSrc.value = source;
        const job = slot.admit(intent);
        jobs.push({
            job,
            source,
        });
        loaded = null;
        if (!holdsRead(job)) {
            setTimeout(() => {
                if (!job.abort.signal.aborted) {
                    settlePdfSourceJob(job, {status: 'presented'});
                    loaded = {
                        job,
                        source,
                    };
                }
            }, 0);
        }
        return job;
    };
    const jobReleaser = createDocumentJobReleaser({
        workingCopyPath,
        pdfSrc,
        publishPdfSource: publish,
        hasView: () => true,
        running: slot.running,
        release: slot.release,
    });
    bindTestDocumentFrontier(controller, {release: jobReleaser.begin});
    setTestDocumentDirty(controller, false);
    workingCopyPath.value = controller.file.value.workingCopyPath;

    const saves: Array<{
        ok: boolean;
        plannedSource: TPdfSource | null;
    }> = [];
    controller.attachWorkspace(tabId, createWorkspaceExposeFixture({
        handleSave: vi.fn(() => {
            const durable = Promise.withResolvers<boolean>();
            void controller.operationLease.runExclusive('save', async () => {
                jobReleaser.republishForSave();
                await slot.running()?.finished;
                if (!loaded || options.saveFails) {
                    saves.push({
                        ok: false,
                        plannedSource: loaded?.source ?? null,
                    });
                    durable.resolve(false);
                    return;
                }
                const plannedSource = loaded.source;
                setTestDocumentDirty(controller, false);
                const adoption = publish(new Blob(['saved']), 'adopt').finished;
                saves.push({
                    ok: true,
                    plannedSource,
                });
                durable.resolve(true);
                await adoption;
            }).catch(durable.reject);
            return durable.promise;
        }),
    }));

    return {
        tabId,
        controller,
        pdfSrc,
        slot,
        jobReleaser,
        jobs,
        publish,
        saves,
        holdReads: (holds: (job: IPdfSourceJob) => boolean) => { holdsRead = holds; },
        isLoaded: () => loaded !== null,
        loadedSource: () => loaded?.source ?? null,
    };
}

function listenForWindowClose(
    documents: ReturnType<typeof createDocument> | ReturnType<typeof createDocument>[],
    requestDirtyCloseConfirmation: () => Promise<TWindowCloseDecision> = async () => 'save',
) {
    const list = Array.isArray(documents) ? documents : [documents];
    const entries = Object.fromEntries(list.map(doc => [
        doc.tabId,
        doc.controller,
    ]));
    let handler: TWindowCloseRequestHandler | null = null;
    useNativeWindowCloseHandshake({
        documentSessionsByTabId: shallowRef(entries),
        requestDirtyCloseConfirmation,
        systemCapability: {
            onWindowCloseRequest: (callback) => {
                handler = callback;
                return () => undefined;
            },
        },
    });
    return (requestId = 'close-1') => handler!(cast<IWindowCloseRequest>({requestId}));
}

describe('native window close', () => {
    // An OCR result applied over pending annotation edits publishes a reload that a slow read holds. The window's
    // close ends that read, then its Save plans from the revision on screen and its adoption ends too (#1598, N7).
    it('saves edits that need the PDF after ending a held reload, and ends the Save adoption read', async () => {
        const document = createDocument();
        document.publish(new Blob(['opened']), 'open');
        await flush();
        expect(document.isLoaded()).toBe(true);

        document.holdReads(job => job.intent === 'reload' || job.intent === 'adopt');
        const ocrSource = new Blob(['recognized']);
        const ocrReload = document.publish(ocrSource, 'reload');
        setTestDocumentDirty(document.controller, true);
        document.holdReads(job => job.intent === 'adopt');

        const decision = await listenForWindowClose(document)();

        expect(await ocrReload.finished).toEqual({status: 'released'});
        expect(document.saves).toEqual([{
            ok: true,
            plannedSource: ocrSource,
        }]);
        expect(decision).toBe('save');
        const adoption = document.jobs.find(entry => entry.job.intent === 'adopt');
        expect(await adoption?.job.finished).toEqual({status: 'released'});
        expect(document.controller.snapshot.value.dirty).toBe(false);

        // The close ended its release: a read the document starts afterwards is not ended.
        document.holdReads(() => true);
        const later = document.publish(new Blob(['later']), 'reload');
        await flush();
        expect(later.abort.signal.aborted).toBe(false);
    });

    // A Save that fails keeps the window: the revision it showed again stays on screen, published once.
    it('keeps the window after a failed Save with its released revision published once', async () => {
        const document = createDocument({saveFails: true});
        document.publish(new Blob(['opened']), 'open');
        await flush();
        document.holdReads(job => job.intent === 'reload');
        const ocrSource = new Blob(['recognized']);
        document.publish(ocrSource, 'reload');
        setTestDocumentDirty(document.controller, true);
        document.holdReads(() => false);

        expect(await listenForWindowClose(document)()).toBe('cancel');
        await flush();
        expect(document.saves).toEqual([{
            ok: false,
            plannedSource: ocrSource,
        }]);

        expect(document.jobs.map(entry => entry.job.intent)).toEqual([
            'open',
            'reload',
            'reload',
        ]);
        expect(document.isLoaded()).toBe(true);
        expect(document.controller.snapshot.value.dirty).toBe(true);
        document.holdReads(() => true);
        const later = document.publish(new Blob(['later']), 'reload');
        await flush();
        expect(later.abort.signal.aborted).toBe(false);
    });

    // Regression for lease-window race: while the dirty-close dialog is open, a background ocr-apply acquires
    // operationLease and publishes a new pdfSrc after the user confirms Save (before Save acquires the lease).
    // Because republishForSave() runs inside Save's own lease turn, Save plans from that latest OCR revision.
    it('saves from a new OCR revision published after confirmation while Save waits for operationLease', async () => {
        const document = createDocument();
        document.publish(new Blob(['opened']), 'open');
        await flush();
        setTestDocumentDirty(document.controller, true);

        const ocrInLease = Promise.withResolvers<undefined>();
        const releaseOcrPublish = Promise.withResolvers<undefined>();
        const lateOcrSource = new Blob(['recognized-during-close']);
        let ocrJob: IPdfSourceJob | null = null;

        const close = listenForWindowClose(document, async () => {
            // Background OCR acquires operationLease while the confirmation dialog is up and
            // publishes its new pdfSrc only after confirmation returns 'save'.
            void document.controller.operationLease.runExclusive('ocr-apply', async () => {
                ocrInLease.resolve(undefined);
                await releaseOcrPublish.promise;
                ocrJob = document.publish(lateOcrSource, 'reload');
                await ocrJob.finished;
            });
            await ocrInLease.promise;
            return 'save';
        });

        document.holdReads(job => job.intent === 'adopt');
        const decisionPromise = close();
        await ocrInLease.promise;
        await flush();
        // Save is now queued behind ocr-apply on operationLease; let OCR publish and release.
        releaseOcrPublish.resolve(undefined);

        const decision = await decisionPromise;

        expect(decision).toBe('save');
        expect(await ocrJob!.finished).toEqual({status: 'released'});
        expect(document.saves).toEqual([{
            ok: true,
            plannedSource: lateOcrSource,
        }]);
        const adoption = document.jobs.find(entry => entry.job.intent === 'adopt');
        expect(await adoption?.job.finished).toEqual({status: 'released'});
    });

    // Regression for pending flush:'pre' watcher callback: a same-tick pdfSrc write whose watch callback
    // has not flushed yet must not release the job kept or republished by republishForSave(), while a
    // subsequent adoption is still released.
    it('does not let a pending flush:pre watch callback release the job kept for Save', async () => {
        const document = createDocument();
        document.publish(new Blob(['opened']), 'open');
        await flush();
        document.holdReads(() => true);

        const end = document.controller.releaseJobs();
        try {
            // Subcase A: prior job was released (released === true), then pdfSrc changes synchronously
            // right before republishForSave() queues a kept reload.
            const firstReload = document.publish(new Blob(['first-ocr']), 'reload');
            await flush();
            expect(await firstReload.finished).toEqual({status: 'released'});

            const secondSource = new Blob(['second-ocr']);
            document.pdfSrc.value = secondSource; // queues flush:'pre' watcher without flushing yet
            document.jobReleaser.republishForSave();
            const keptReload = document.slot.running();
            expect(keptReload).not.toBeNull();

            await flush();
            expect(keptReload!.abort.signal.aborted).toBe(false);

            // Subcase B: a later adopt produces a distinct job and IS still released.
            const adoptJob = document.publish(new Blob(['saved']), 'adopt');
            await flush();
            expect(await adoptJob.finished).toEqual({status: 'released'});
        } finally {
            end(false);
        }

        // Subcase C: no prior job was released (released === false), then a synchronous publish leaves a
        // running job with a pending flush:'pre' watcher right before republishForSave() runs.
        const endFresh = document.controller.releaseJobs();
        try {
            const syncJob = document.publish(new Blob(['sync-ocr']), 'reload');
            document.jobReleaser.republishForSave();
            await flush();
            expect(syncJob.abort.signal.aborted).toBe(false);
        } finally {
            endFresh(false);
        }
    });

    // Guard against republishing when pdfSrc is null even if workingCopyPath did not change.
    it('does not publish a null pdfSrc on republishForSave or end(true)', async () => {
        const document = createDocument();
        document.holdReads(() => true);
        const held = document.publish(new Blob(['recognized']), 'reload');
        const end = document.controller.releaseJobs();
        expect(await held.finished).toEqual({status: 'released'});

        document.pdfSrc.value = null;
        const countBefore = document.jobs.length;
        document.jobReleaser.republishForSave();
        end(true);

        expect(document.jobs).toHaveLength(countBefore);
    });

    it.each<TWindowCloseDecision>([
        'cancel',
        'discard',
    ])('handles %s without saving, cleans up watchers, and republishes released jobs once', async (choice) => {
        const document = createDocument();
        document.publish(new Blob(['opened']), 'open');
        await flush();
        document.holdReads(job => job.intent === 'reload');
        const ocrReload = document.publish(new Blob(['recognized']), 'reload');
        setTestDocumentDirty(document.controller, true);
        document.holdReads(() => false);

        const decision = await listenForWindowClose(document, async () => choice)();
        await flush();

        expect(decision).toBe(choice);
        expect(await ocrReload.finished).toEqual({status: 'released'});
        expect(document.saves).toEqual([]);
        expect(document.jobs.map(entry => entry.job.intent)).toEqual([
            'open',
            'reload',
            'reload',
        ]);
        expect(document.isLoaded()).toBe(true);

        document.holdReads(() => true);
        const later = document.publish(new Blob(['later']), 'reload');
        await flush();
        expect(later.abort.signal.aborted).toBe(false);
    });

    it('recovers Tab 1 saved revision once and does not double-publish Tab 2 on partial multi-tab Save failure', async () => {
        const tab1 = createDocument({
            tabId: 'tab-1',
            fileName: 'first.pdf',
        });
        const tab2 = createDocument({
            tabId: 'tab-2',
            fileName: 'second.pdf',
            saveFails: true,
        });
        tab1.publish(new Blob(['open-1']), 'open');
        tab2.publish(new Blob(['open-2']), 'open');
        await flush();

        tab1.holdReads(job => job.intent === 'reload' || job.intent === 'adopt');
        tab2.holdReads(job => job.intent === 'reload');
        tab1.publish(new Blob(['ocr-1']), 'reload');
        tab2.publish(new Blob(['ocr-2']), 'reload');
        setTestDocumentDirty(tab1.controller, true);
        setTestDocumentDirty(tab2.controller, true);
        tab1.holdReads(job => job.intent === 'adopt');
        tab2.holdReads(() => false);

        const decision = await listenForWindowClose([
            tab1,
            tab2,
        ])();
        await flush();

        expect(decision).toBe('cancel');
        expect(tab1.saves.map(entry => entry.ok)).toEqual([true]);
        expect(tab2.saves.map(entry => entry.ok)).toEqual([false]);
        // Tab 1: open -> released ocr reload -> save reload -> released adopt -> finally reload (once).
        expect(tab1.jobs.map(entry => entry.job.intent)).toEqual([
            'open',
            'reload',
            'reload',
            'adopt',
            'reload',
        ]);
        // Tab 2: open -> released ocr reload -> save reload (once; finally does not double-publish).
        expect(tab2.jobs.map(entry => entry.job.intent)).toEqual([
            'open',
            'reload',
            'reload',
        ]);
        expect(tab1.isLoaded()).toBe(true);
        expect(tab2.isLoaded()).toBe(true);

        // Watchers on both tabs are cleaned up.
        tab1.holdReads(() => true);
        tab2.holdReads(() => true);
        const later1 = tab1.publish(new Blob(['later-1']), 'reload');
        const later2 = tab2.publish(new Blob(['later-2']), 'reload');
        await flush();
        expect(later1.abort.signal.aborted).toBe(false);
        expect(later2.abort.signal.aborted).toBe(false);
    });

    it('rejects a repeated close request while a close is in flight without installing duplicate watchers', async () => {
        const document = createDocument();
        document.publish(new Blob(['opened']), 'open');
        await flush();
        setTestDocumentDirty(document.controller, true);

        const confirmEntered = Promise.withResolvers<undefined>();
        const confirmDecision = Promise.withResolvers<TWindowCloseDecision>();
        const close = listenForWindowClose(document, async () => {
            confirmEntered.resolve(undefined);
            return await confirmDecision.promise;
        });

        const firstClose = close('close-1');
        await confirmEntered.promise;
        expect(await close('close-2')).toBe('cancel');

        confirmDecision.resolve('cancel');
        expect(await firstClose).toBe('cancel');

        // After the first close finishes, no stray watcher remains installed.
        document.holdReads(() => true);
        const later = document.publish(new Blob(['later']), 'reload');
        await flush();
        expect(later.abort.signal.aborted).toBe(false);
    });
});
