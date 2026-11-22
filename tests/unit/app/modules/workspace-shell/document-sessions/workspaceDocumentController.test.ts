import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    reactive,
    ref,
    shallowRef,
} from 'vue';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import type { ITab } from '@app/types/tabs';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { didFinishOpen } from '@app/types/documentOpenOutcome';
import {
    createWorkspaceDocumentController,
    describeTabDocument,
    snapshotOccupiesTab,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { describeDocumentTarget } from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import { useNativeWindowCloseHandshake } from '@app/modules/workspace-shell/composables/useNativeWindowCloseHandshake';
import type {
    IWindowCloseRequest,
    TWindowCloseRequestHandler,
} from '@contracts/systemPlatformFeature';
import {
    bindTestDocumentFrontier,
    createWorkspaceExposeFixture,
    setTestDocumentDirty,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { readToastDescription } from '@tests/helpers/toastDescription';
import { cast } from '@tests/helpers/cast';
import {
    createPdfDocumentSessionSlot,
    type IPdfSourceJob,
} from '@app/modules/pdf-viewer/public';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfSource } from '@app/types/pdfUi';

describe('workspace document operation lease', () => {
    it('reports a background recovery copy as busy but not foreground busy', async () => {
        const {operationLease} = createWorkspaceDocumentController({tabId: 'tab-lease'});
        const recovery = Promise.withResolvers<void>();
        const save = Promise.withResolvers<void>();

        const recoveryRun = operationLease.runExclusive('recovery-snapshot', () => recovery.promise);
        expect(operationLease.isBusy.value).toBe(true);
        expect(operationLease.isForegroundBusy.value).toBe(false);

        const saveRun = operationLease.runExclusive('save', () => save.promise);
        expect(operationLease.isForegroundBusy.value).toBe(true);

        recovery.resolve();
        await recoveryRun;
        expect(operationLease.isForegroundBusy.value).toBe(true);

        save.resolve();
        await saveRun;
        expect(operationLease.isBusy.value).toBe(false);
        expect(operationLease.isForegroundBusy.value).toBe(false);
    });
});

describe('workspace document controller views', () => {
    it('makes the tab empty at the close commit while file cleanup is pending', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({
            fileName: 'closed.pdf',
            originalPath: requireDocumentRef('/docs/closed.pdf'),
            isDirty: false,
            isDjvu: false,
        });
        const cleanup = Promise.withResolvers<void>();
        bindTestDocumentFrontier(controller, {teardown: () => cleanup.promise});
        const closing = controller.close({});
        await expect(closing.closed).resolves.toBe(true);
        expect(controller.snapshot.value.phase).toBe('empty');
        expect(snapshotOccupiesTab(controller.snapshot.value)).toBe(false);
        let released = false;
        void closing.released.then(() => {
            released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        cleanup.resolve();
        await closing.released;
        expect(released).toBe(true);
    });

    // A close ends the jobs its document runs before it waits for that
    // document's operations, so an operation held by a reader cannot hold it.
    function closingDocument() {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({
            fileName: 'edited.pdf',
            originalPath: requireDocumentRef('/docs/edited.pdf'),
            isDirty: false,
            isDjvu: false,
        });
        const events: string[] = [];
        const held = Promise.withResolvers<void>();
        const document = {
            drain: vi.fn(async () => {
                events.push('release');
                held.resolve();
                await controller.operationLease.whenIdle();
                return true;
            }),
            republish: vi.fn(() => events.push('republish')),
            save: vi.fn(async () => {
                events.push('save');
                return false;
            }),
            retire: vi.fn(() => events.push(`retire:${controller.snapshot.value.phase}`)),
            teardown: vi.fn(async () => {
                events.push(`teardown:${controller.snapshot.value.phase}`);
            }),
        };
        bindTestDocumentFrontier(controller, document);
        setTestDocumentDirty(controller, true);
        // A Save waiting in the lease for its reload to accept the new revision.
        void controller.operationLease.runExclusive('save', async () => {
            await held.promise;
            events.push('save lease ended');
        });
        const decide = (decision: 'save' | 'discard' | 'cancel') => vi.fn(async () => {
            events.push(`decide:${decision}`);
            return decision;
        });
        return {controller, document, events, decide};
    }

    // A PDF session whose loads never accept their document, as a held reader does.
    function heldSourceSlot() {
        const source = shallowRef<TPdfSource | null>({kind: 'path', path: requireDocumentRef('/working/a.pdf'), size: 1});
        const slot = createPdfDocumentSessionSlot({src: source, reloadSrc: source});
        const session = reactive({currentJob: null as IPdfSourceJob | null, admit(job: IPdfSourceJob) {
            session.currentJob = job;
            return job;
        }});
        slot.resolve(() => cast<TPdfDocumentSession>(session));
        return slot;
    }

    // STOP 1: Save and Save As of A while an open of B is claimed stay A's;
    // only the open's own file work starts another logical document.
    it('keeps the document session through its own Save and Save As while another open is claimed', () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const revisionOf = (path: string, token: string) => ({
            version: 1 as const,
            token: requireDocumentRevisionToken(token),
            documentRef: requireDocumentRef(path),
            authority: 'electron-working-copy' as const,
            contentRevision: 1,
            mintedAt: requireEpochMs(1_790_000_000_000),
        });
        controller.commitFile({
            originalPath: requireDocumentRef('/docs/a.pdf'),
            workingCopyPath: requireDocumentRef('/working/a.pdf'),
            revisionInfo: revisionOf('/working/a.pdf', 'a-1'),
        });
        const a = controller.snapshot.value.identity;
        const opening = controller.claimOpen({
            kind: 'open',
            target: describeDocumentTarget(requireDocumentRef('/docs/b.pdf')),
        });

        controller.commitFile({revisionInfo: revisionOf('/working/a.pdf', 'a-2')});
        controller.commitFile({
            originalPath: requireDocumentRef('/docs/a-copy.pdf'),
            workingCopyPath: requireDocumentRef('/working/a-copy.pdf'),
            revisionInfo: revisionOf('/working/a-copy.pdf', 'a-copy-1'),
        });
        expect(controller.snapshot.value.identity).toMatchObject({
            documentSessionKey: a.documentSessionKey,
            documentInstanceId: a.documentInstanceId,
            originalPath: '/docs/a-copy.pdf',
        });

        controller.commitFile({originalPath: requireDocumentRef('/docs/b.pdf'), workingCopyPath: requireDocumentRef('/working/b.pdf')}, opening);
        expect(controller.snapshot.value.identity.documentSessionKey).not.toBe(a.documentSessionKey);
    });

    // STOP 2: with B's open pending, a Save still writing when Close is clicked
    // publishes its reload during the drain, which releases it.
    it('finishes a close while another open is pending and a late Save reload is held', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({fileName: 'a.pdf', originalPath: requireDocumentRef('/docs/a.pdf'), isDirty: false, isDjvu: false});
        const slot = heldSourceSlot();
        bindTestDocumentFrontier(controller, {drain: () => slot.drain(() => controller.operationLease.whenIdle())});
        controller.claimOpen({kind: 'open', target: describeDocumentTarget(requireDocumentRef('/docs/b.pdf'))});
        const write = Promise.withResolvers<void>();
        void controller.operationLease.runExclusive('save', async () => {
            await write.promise;
            await slot.admit('adopt').accepted;
        });

        const closing = controller.close({});
        write.resolve();

        await expect(closing.closed).resolves.toBe(true);
        expect(controller.snapshot.value.phase).toBe('empty');
    });

    // STOP 5: the earlier job settled before Close; the reload a Save admits
    // during the drain is released, so Cancel shows the revision again.
    it('republishes after Cancel when the drain released a job admitted after it began', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({fileName: 'a.pdf', originalPath: requireDocumentRef('/docs/a.pdf'), isDirty: false, isDjvu: false});
        const slot = heldSourceSlot();
        const republish = vi.fn();
        bindTestDocumentFrontier(controller, {drain: () => slot.drain(() => controller.operationLease.whenIdle()), republish});
        setTestDocumentDirty(controller, true);
        const earlier = slot.admit('open');
        earlier.abort.abort({status: 'presented'});
        const write = Promise.withResolvers<void>();
        void controller.operationLease.runExclusive('save', async () => {
            await write.promise;
            await slot.admit('adopt').accepted;
        });

        const closing = controller.close({decide: async () => 'cancel'});
        write.resolve();

        await expect(closing.closed).resolves.toBe(false);
        expect(republish).toHaveBeenCalledOnce();
    });

    // Close→Cancel: an operation that began before the close (a file Undo)
    // still applies afterwards; the close took nothing from the document.
    it('leaves the document as it was through Close and Cancel, so earlier work still applies', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({fileName: 'a.pdf', originalPath: requireDocumentRef('/docs/a.pdf'), isDirty: false, isDjvu: false});
        bindTestDocumentFrontier(controller);
        setTestDocumentDirty(controller, true);
        const undo = Promise.withResolvers<void>();
        const before = controller.snapshot.value;
        const undone = controller.operationLease.runExclusive('history', async () => {
            await undo.promise;
            return controller.snapshot.value.activeTransaction?.id === before.activeTransaction?.id
                && controller.snapshot.value.sessionRevision === before.sessionRevision;
        });

        const closing = controller.close({decide: async () => 'cancel'});
        await Promise.resolve();
        undo.resolve();

        await expect(undone).resolves.toBe(true);
        await expect(closing.closed).resolves.toBe(false);
        expect(controller.snapshot.value.activeTransaction).toBeNull();
    });

    // STOP 4: the window's own Save publishes a reload that no view accepts;
    // the window drains again before its final check, and leaves nothing armed.
    it('closes the window after its Save whose reload is held, and a veto leaves the document saveable', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({fileName: 'a.pdf', originalPath: requireDocumentRef('/docs/a.pdf'), isDirty: false, isDjvu: false});
        const slot = heldSourceSlot();
        bindTestDocumentFrontier(controller, {
            drain: () => slot.drain(() => controller.operationLease.whenIdle()),
            save: async () => {
                void controller.operationLease.runExclusive('save', async () => {
                    await slot.admit('adopt').accepted;
                });
                setTestDocumentDirty(controller, false);
                return true;
            },
        });
        setTestDocumentDirty(controller, true);
        let requestClose: TWindowCloseRequestHandler | null = null;
        useNativeWindowCloseHandshake({
            documentSessionsByTabId: shallowRef({'tab-1': controller}),
            requestDirtyCloseConfirmation: async () => 'save',
            systemCapability: {onWindowCloseRequest: (handler) => {
                requestClose = handler;
                return () => {};
            }},
        });

        await expect(requestClose!(cast<IWindowCloseRequest>({}))).resolves.toBe('save');
        // Main vetoes the close: the next reload is the document's own again.
        expect(controller.snapshot.value.activeTransaction).toBeNull();
        expect(slot.admit('reload').abort.signal.aborted).toBe(false);
    });

    it('releases the held job before asking, and shows the revision again when Cancel keeps the edits', async () => {
        const {controller, document, events, decide} = closingDocument();

        await expect(controller.close({decide: decide('cancel')}).closed).resolves.toBe(false);

        expect(events).toEqual(['release', 'save lease ended', 'decide:cancel', 'republish']);
        expect(document.teardown).not.toHaveBeenCalled();
        expect(controller.snapshot.value).toMatchObject({phase: 'presented', dirty: true});
    });

    it('keeps the document and its edits when the Save before close fails', async () => {
        const {controller, document, events, decide} = closingDocument();

        await expect(controller.close({decide: decide('save')}).closed).resolves.toBe(false);

        expect(events).toEqual(['release', 'save lease ended', 'decide:save', 'save', 'republish']);
        expect(document.retire).not.toHaveBeenCalled();
        expect(controller.snapshot.value).toMatchObject({phase: 'presented', dirty: true});
    });

    it('retires a saved document before publishing it empty, then tears it down', async () => {
        const {controller, document, events, decide} = closingDocument();
        document.save.mockImplementation(async () => {
            events.push('save');
            setTestDocumentDirty(controller, false);
            return true;
        });

        const closing = controller.close({decide: decide('save')});
        await expect(closing.closed).resolves.toBe(true);
        await closing.released;

        expect(events).toEqual(['release', 'save lease ended', 'decide:save', 'save', 'retire:presented', 'teardown:empty']);
        expect(document.republish).not.toHaveBeenCalled();
    });

    it('occupies an empty tab before mounting and presents the claimed open', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const target = {
            fileName: 'moved.pdf',
            originalPath: requireDocumentRef('/docs/moved.pdf'),
        };
        const transactionId = controller.claimOpen({
            kind: 'open',
            target,
        });
        expect(snapshotOccupiesTab(controller.snapshot.value)).toBe(true);
        const opened = controller.runOpen({
            kind: 'open',
            target,
            transactionId,
        }, async () => {
            controller.commitFile({
                ...target,
                isDjvu: false,
                revisionInfo: null,
            });
            return {presentation: Promise.resolve({status: 'presented'})};
        });
        await expect(didFinishOpen(opened)).resolves.toBe(true);
        expect(controller.snapshot.value.phase).toBe('presented');
        expect(controller.snapshot.value.identity.fileName).toBe('moved.pdf');
    });

    it('ends an open as failed and gives the tab back when its presentation rejects', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const opened = controller.runOpen({
            kind: 'open',
            target: {
                fileName: 'broken.pdf',
                originalPath: requireDocumentRef('/docs/broken.pdf'),
            },
        }, async () => ({presentation: Promise.reject(new Error('The renderer receipt failed.'))}));

        await expect(opened.finished).resolves.toEqual({
            status: 'failed',
            failure: null,
        });
        expect(controller.snapshot.value.activeTransaction).toBeNull();
        expect(controller.snapshot.value.phase).toBe('empty');
    });

    it('refuses a superseded claim even when a newer open has the same source', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const target = {
            fileName: 'same.pdf',
            originalPath: requireDocumentRef('/docs/same.pdf'),
        };
        const transactionId = controller.claimOpen({
            kind: 'open',
            target,
        });
        const newer = controller.runOpen({
            kind: 'open',
            target,
        }, async () => {
            controller.commitFile({
                ...target,
                isDjvu: false,
                revisionInfo: null,
            });
            return {presentation: Promise.resolve({status: 'presented'})};
        });
        await newer.finished;
        const instance = controller.snapshot.value.identity.documentInstanceId;
        await expect(controller.runOpen({
            kind: 'open',
            target,
            transactionId,
        }, async () => {
            controller.commitFile({
                ...target,
                isDjvu: false,
                revisionInfo: null,
            });
            return {presentation: Promise.resolve({status: 'presented'})};
        }).finished).resolves.toEqual({status: 'superseded'});
        expect(controller.snapshot.value.identity.fileName).toBe('same.pdf');
        expect(controller.snapshot.value.identity.documentInstanceId).toBe(instance);
        expect(controller.snapshot.value.phase).toBe('presented');
    });

    it.each([
        'save-as',
        'conversion',
    ])('keeps the admitted lifetime when %s adopts a new path and revision', (operation) => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({
            fileName: operation === 'conversion' ? 'source.djvu' : 'source.pdf',
            originalPath: requireDocumentRef(operation === 'conversion' ? '/docs/source.djvu' : '/docs/source.pdf'),
            isDirty: true,
            isDjvu: operation === 'conversion',
        });
        const admitted = controller.snapshot.value.identity;
        const savedPath = requireDocumentRef('/docs/saved.pdf');
        const workingPath = requireDocumentRef('/working/saved.pdf');
        controller.commitFile({
            originalPath: savedPath,
            isDjvu: false,
            revisionInfo: {
                version: 1,
                token: requireDocumentRevisionToken('saved-revision-2'),
                documentRef: workingPath,
                authority: 'electron-working-copy',
                contentRevision: 2,
                mintedAt: requireEpochMs(1_790_000_000_000),
            },
        });
        expect(controller.snapshot.value.identity).toMatchObject({
            documentSessionKey: admitted.documentSessionKey,
            documentInstanceId: admitted.documentInstanceId,
            originalPath: savedPath,
            workingCopyPath: workingPath,
            isDjvu: false,
            revisionInfo: {token: 'saved-revision-2'},
        });
    });

    it.each([
        '/docs/source.pdf',
        '/docs/replacement.pdf',
    ])('rejects the old target when a fresh open adopts %s before presentation', async (path) => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.assign({
            fileName: 'source.pdf',
            originalPath: requireDocumentRef('/docs/source.pdf'),
            isDirty: false,
            isDjvu: false,
        });
        const admitted = controller.snapshot.value.identity;
        const oldTarget = controller.createCommandTarget('tab-1');
        const target = {
            originalPath: requireDocumentRef(path),
            fileName: 'opened.pdf',
        };
        const presented = Promise.withResolvers<{status: 'presented'}>();
        const opened = controller.runOpen({
            kind: 'open',
            target,
        }, async () => ({presentation: presented.promise}));
        expect(controller.validateCommandTarget(oldTarget).ok).toBe(false);
        controller.commitFile({
            ...target,
            isDjvu: false,
            revisionInfo: null,
        }, controller.snapshot.value.activeTransaction?.id);
        expect(controller.snapshot.value.identity.documentSessionKey).not.toBe(admitted.documentSessionKey);
        expect(controller.snapshot.value.identity.documentInstanceId).not.toBe(admitted.documentInstanceId);
        expect(controller.snapshot.value.activeTransaction?.kind).toBe('open');
        expect(controller.validateCommandTarget(oldTarget).ok).toBe(false);
        presented.resolve({status: 'presented'});
        await opened.finished;
        expect(controller.snapshot.value.phase).toBe('presented');
        expect(controller.validateCommandTarget(oldTarget).ok).toBe(false);
    });

    it('resumes the retained checkpoint lifetime through working-copy restore and presentation', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const sourcePath = requireDocumentRef('/docs/source.pdf');
        const workingPath = requireDocumentRef('/working/recovered.pdf');
        controller.assign({
            fileName: 'source.pdf',
            originalPath: sourcePath,
            recoveryWorkingCopyPath: workingPath,
            isDirty: true,
            isDjvu: false,
        });
        const admitted = controller.snapshot.value.identity;
        const presented = Promise.withResolvers<{status: 'presented'}>();
        const restored = controller.runOpen({
            kind: 'restore',
            target: {originalPath: sourcePath},
        }, async () => ({presentation: presented.promise}));
        controller.commitFile({
            originalPath: sourcePath,
            isDjvu: false,
            revisionInfo: {
                version: 1,
                token: requireDocumentRevisionToken('restored-revision-1'),
                documentRef: workingPath,
                authority: 'electron-working-copy',
                contentRevision: 1,
                mintedAt: requireEpochMs(1_790_000_000_000),
            },
        });
        expect(controller.snapshot.value.identity.documentSessionKey).toBe(admitted.documentSessionKey);
        expect(controller.snapshot.value.identity.documentInstanceId).toBe(admitted.documentInstanceId);
        presented.resolve({status: 'presented'});
        await restored.finished;
        expect(controller.snapshot.value.identity.documentSessionKey).toBe(admitted.documentSessionKey);
        expect(controller.snapshot.value.identity.documentInstanceId).toBe(admitted.documentInstanceId);
        expect(controller.snapshot.value.recoveryWorkingCopyPath).toBeNull();
        expect(controller.snapshot.value.dirty).toBe(true);
    });

    it('retires a mounted view on removal: its workspace is gone and later mounts are refused', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        controller.addView('tab-2');
        const view = controller.getView('tab-2')!;
        const workspace = createWorkspaceExposeFixture();
        controller.attachWorkspace('tab-2', workspace);
        expect(await view.whenMounted()).toBe(workspace);

        expect(controller.removeView('tab-2')).toBe(1);

        expect(controller.getView('tab-2')).toBeNull();
        expect(view.mountedWorkspace.value).toBeNull();
        expect(await view.whenMounted()).toBeNull();
        controller.attachWorkspace('tab-2', workspace);
        expect(view.mountedWorkspace.value).toBeNull();
    });

    it('shows its mounted workspace toolbar live and keeps the last one while unmounted', () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const view = controller.getView('tab-1')!;
        const toolbar = ref({
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            currentPage: 2,
            totalPages: 4,
        });
        const workspace = createWorkspaceExposeFixture({getToolbarSnapshot: () => toolbar.value});
        controller.attachWorkspace('tab-1', workspace);
        expect(view.toolbarSnapshot.value).toMatchObject({hasPdf: true, currentPage: 2});

        toolbar.value = {...toolbar.value, currentPage: 3};
        expect(view.toolbarSnapshot.value.currentPage).toBe(3);

        controller.detachWorkspace('tab-1', workspace);
        toolbar.value = createDefaultWorkspaceToolbarSnapshot();
        expect(view.toolbarSnapshot.value).toMatchObject({hasPdf: true, currentPage: 3});

        // Mounted again after its document closed, the view shows Start's toolbar.
        controller.attachWorkspace('tab-1', workspace);
        expect(view.toolbarSnapshot.value.hasPdf).toBe(false);
    });

    it('answers a pending mount waiter of a removed, never-mounted view with null', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const view = controller.getView('tab-1')!;
        const pending = view.whenMounted();

        expect(controller.removeView('tab-1')).toBe(0);

        await expect(pending).resolves.toBeNull();
        await expect(view.whenMounted()).resolves.toBeNull();
    });
});

const toastAdd = vi.fn();
vi.stubGlobal('useToast', () => ({add: toastAdd}));

afterEach(() => {
    toastAdd.mockClear();
});

const receipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
    occurredAt: requireEpochMs(1_790_000_000_000),
    severity: 'error',
} as FailureReceipt;

function createSessions() {
    const tabs = ref<ITab[]>([{id: 'tab-1'}]);
    const sessions = useWorkspaceDocumentSessions({
        activeTabId: ref('tab-1'),
        tabs,
    });
    return {
        session: sessions.getSession('tab-1')!,
        tabs,
    };
}

function openThatFails(failure: FailureReceipt | null) {
    const {
        session,
        tabs,
    } = createSessions();
    const opened = session.runOpen({
        kind: 'open',
        target: {
            fileName: 'gone.pdf',
            originalPath: requireDocumentRef('/docs/gone.pdf'),
        },
    }, async () => {
        session.markFailed({
            message: 'The file was moved or deleted.',
            failure,
        });
        return null;
    });
    return {
        opened: didFinishOpen(opened),
        tabs,
    };
}

describe('a tab whose open fails', () => {
    it('tells why once, naming the file, even when the tab is then removed', async () => {
        const {
            opened,
            tabs,
        } = openThatFails(receipt);
        await expect(opened).resolves.toBe(false);
        tabs.value = [];

        expect(toastAdd).toHaveBeenCalledOnce();
        const toast = toastAdd.mock.calls[0]?.[0];
        expect(toast).toMatchObject({
            id: receipt.eventId,
            color: 'error',
            title: 'errors.file.open',
        });
        expect(readToastDescription(toast.description)).toBe('gone.pdf: The file was moved or deleted.\nerrors.runtime.errorId: 01234567');
    });

    it('tells an expected outcome without a receipt as a warning with nothing to copy', async () => {
        const {opened} = openThatFails(null);
        await opened;

        expect(toastAdd).toHaveBeenCalledOnce();
        expect(toastAdd.mock.calls[0]?.[0]).toEqual({
            color: 'warning',
            icon: 'i-ph-warning',
            title: 'errors.file.open',
            description: 'gone.pdf: The file was moved or deleted.',
        });
    });
});

// The shell's tabs and the real document controllers, with a New Tab that is
// active and whose workspace chunk has not arrived yet.
function createRoutingToNewTab() {
    const tabs = ref<ITab[]>([
        {id: 'tab-start'},
        {id: 'tab-new'},
    ]);
    const activeTabId = ref<string | null>('tab-new');
    const documentSessions = useWorkspaceDocumentSessions({
        activeTabId,
        tabs,
    });
    let created = 0;
    const routing = useAppShellWorkspaceRouting({
        activePaneId: ref('pane-1'),
        activeTabId,
        documentSessions,
        tabLifecycleById: ref({}),
        createTab: ({activate}) => {
            created += 1;
            const tab = {id: `tab-opened-${created}`};
            tabs.value = [
                ...tabs.value,
                tab,
            ];
            if (activate) activeTabId.value = tab.id;
            return tab;
        },
        getTabById: tabId => tabs.value.find(tab => tab.id === tabId) ?? null,
        removeTabFromState: (tabId) => {
            tabs.value = tabs.value.filter(tab => tab.id !== tabId);
        },
        resolveTabForAction: () => null,
        handleCloseTab: vi.fn(),
        moveTabToNewWindow: vi.fn(),
        moveTabToWindow: vi.fn(),
        mergeWindowInto: vi.fn(),
    });
    // The tab's workspace mounts and opens the file the way a real one does:
    // its open claims the tab, records the file, then presents it.
    function mountWorkspace(tabId: string) {
        const session = documentSessions.getSession(tabId)!;
        session.attachWorkspace(tabId, createWorkspaceExposeFixture({handleOpenFileDirectWithPersist: async (path: TDocumentRef) => {
            const opened = session.runOpen({
                kind: 'open',
                target: describeDocumentTarget(path),
            }, async () => {
                session.commitFile({originalPath: path});
                return {presentation: Promise.resolve({status: 'presented'})};
            });
            return didFinishOpen(opened);
        }}));
    }
    function describeTabs() {
        return tabs.value.map(tab => describeTabDocument(documentSessions.getSession(tab.id)!.snapshot.value).fileName);
    }
    return {
        describeTabs,
        documentSessions,
        mountWorkspace,
        routing,
        tabs,
    };
}

describe('routing a document while the tab it picked is still mounting', () => {
    it('gives a second open its own tab, and both documents stay open', async () => {
        const {
            describeTabs,
            mountWorkspace,
            routing,
            tabs,
        } = createRoutingToNewTab();

        const first = routing.openPathInAppropriateTab(requireDocumentRef('/docs/alpha.pdf'));
        const second = routing.openPathInAppropriateTab(requireDocumentRef('/docs/beta.pdf'));
        // The workspace chunk arrives for every tab waiting on it.
        for (const tab of tabs.value.slice(1)) mountWorkspace(tab.id);

        await expect(Promise.all([
            first,
            second,
        ])).resolves.toEqual([
            true,
            true,
        ]);
        expect(describeTabs()).toEqual([
            null,
            'alpha.pdf',
            'beta.pdf',
        ]);
    });

    it('leaves a new tab to the document that took it before the first open could start', async () => {
        const {
            describeTabs,
            documentSessions,
            mountWorkspace,
            routing,
        } = createRoutingToNewTab();

        const opened = routing.handleOpenInNewTab(requireDocumentRef('/docs/alpha.pdf'));
        // Another owner opens a different file in the tab before it mounts.
        const session = documentSessions.getSession('tab-opened-1')!;
        const beta = requireDocumentRef('/docs/beta.pdf');
        await session.runOpen({
            kind: 'open',
            target: describeDocumentTarget(beta),
        }, async () => {
            session.commitFile({originalPath: beta});
            return {presentation: Promise.resolve({status: 'presented'})};
        }).finished;
        mountWorkspace('tab-opened-1');

        await expect(opened).resolves.toBe(false);
        expect(describeTabs()).toEqual([
            null,
            null,
            'beta.pdf',
        ]);
    });
});
