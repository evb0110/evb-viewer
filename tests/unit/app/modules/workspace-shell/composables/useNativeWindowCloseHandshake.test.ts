import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    ISystemCapability,
    TWindowCloseDecision,
    TWindowCloseRequestHandler,
} from '@contracts/systemPlatformFeature';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { useNativeWindowCloseHandshake } from '@app/modules/workspace-shell/composables/useNativeWindowCloseHandshake';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireRequestId } from '@contracts/shared';

const scopes: Array<ReturnType<typeof effectScope>> = [];

function createTab(id: string): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: requireDocumentRef(`/documents/${id}.pdf`),
        documentInstanceId: `${id}-instance` as Exclude<ITab['documentInstanceId'], undefined>,
        isDirty: true,
        isDjvu: false,
    };
}

function createSession(dirty: boolean, saveResult = true, initiallyUnmounted = false) {
    const snapshot = ref({dirty});
    const handleSave = vi.fn(async () => {
        if (saveResult) {
            snapshot.value = {dirty: false};
        }
        return saveResult;
    });
    const workspace: IWorkspaceExpose = {
        getAutomationStateSnapshot: () => ({dirtyState: {fileDirty: snapshot.value.dirty}}),
        handleSave,
    } as never;
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(initiallyUnmounted ? null : workspace);
    let resolveWorkspace: ((value: IWorkspaceExpose | null) => void) | null = null;
    const session: IWorkspaceDocumentController = {
        createCommandTarget: vi.fn(() => ({}) as never),
        mountedWorkspace,
        snapshot,
        waitForWorkspace: vi.fn(async () => mountedWorkspace.value ?? new Promise<IWorkspaceExpose | null>(resolve => {
            resolveWorkspace = resolve;
        })),
    } as never;
    return {
        handleSave,
        resolveWorkspace: (value: IWorkspaceExpose | null = workspace) => {
            mountedWorkspace.value = value;
            resolveWorkspace?.(value);
        },
        session,
    };
}

function createHarness(options: {
    decision?: TWindowCloseDecision;
    flushSettings?: () => Promise<boolean>;
    sessions: Record<string, IWorkspaceDocumentController>;
    tabs: ITab[];
}) {
    type TCloseHandler = TWindowCloseRequestHandler;
    let closeHandler: TCloseHandler | null = null;
    const unsubscribe = vi.fn(() => {
        closeHandler = null;
    });
    const onWindowCloseRequest = vi.fn((callback: TCloseHandler) => {
        closeHandler = callback;
        return unsubscribe;
    });
    const systemCapability: Pick<ISystemCapability, 'onWindowCloseRequest'> = {onWindowCloseRequest};
    const requestDirtyCloseConfirmation = vi.fn(async () => options.decision ?? 'cancel');
    const tabs = ref(options.tabs);
    const documentSessionsByTabId = shallowRef(options.sessions);
    const scope = effectScope();
    scopes.push(scope);
    scope.run(() => useNativeWindowCloseHandshake({
        documentSessionsByTabId,
        ...(options.flushSettings ? {flushSettings: options.flushSettings} : {}),
        requestDirtyCloseConfirmation,
        systemCapability,
        tabs,
    }));
    const registeredCloseHandler = closeHandler as TCloseHandler | null;
    if (!registeredCloseHandler) {
        throw new Error('Expected the native close handler to be registered');
    }
    return {
        closeHandler: registeredCloseHandler,
        onWindowCloseRequest,
        requestDirtyCloseConfirmation,
        unsubscribe,
    };
}

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe('useNativeWindowCloseHandshake', () => {
    it('flushes pending ordinary settings before approving a clean close', async () => {
        const flushSettings = vi.fn(async () => true);
        const tab = {
            ...createTab('clean-settings'),
            isDirty: false,
        };
        const {session} = createSession(false);
        const harness = createHarness({
            flushSettings,
            sessions: {clean: session},
            tabs: [tab],
        });

        await expect(harness.closeHandler({requestId: requireRequestId('close-settings')})).resolves.toBe('save');
        expect(flushSettings).toHaveBeenCalledOnce();
    });

    it('withholds close when ordinary settings cannot flush', async () => {
        const flushSettings = vi.fn(async () => false);
        const tab = {
            ...createTab('failed-settings'),
            isDirty: false,
        };
        const {session} = createSession(false);
        const harness = createHarness({
            flushSettings,
            sessions: {clean: session},
            tabs: [tab],
        });

        await expect(harness.closeHandler({requestId: requireRequestId('close-settings-failed')})).resolves.toBe('cancel');
        expect(flushSettings).toHaveBeenCalledOnce();
    });

    it('allows a clean workspace to close without opening the dirty dialog', async () => {
        const tab = {
            ...createTab('clean'),
            isDirty: false,
        };
        const {session} = createSession(false);
        const harness = createHarness({
            sessions: {clean: session},
            tabs: [tab],
        });

        await expect(harness.closeHandler({requestId: requireRequestId('close-1')})).resolves.toBe('save');
        expect(harness.requestDirtyCloseConfirmation).not.toHaveBeenCalled();
    });

    it('saves every dirty mounted workspace after the renderer chooses save', async () => {
        const first = createSession(true);
        const second = createSession(true);
        const harness = createHarness({
            decision: 'save',
            sessions: {
                first: first.session,
                second: second.session,
            },
            tabs: [
                createTab('first'),
                createTab('second'),
            ],
        });

        await expect(harness.closeHandler({requestId: requireRequestId('close-2')})).resolves.toBe('save');
        expect(harness.requestDirtyCloseConfirmation).toHaveBeenCalledOnce();
        expect(first.handleSave).toHaveBeenCalledOnce();
        expect(second.handleSave).toHaveBeenCalledOnce();
    });

    it.each([
        'discard',
        'cancel',
    ] as const)('returns %s without saving', async decision => {
        const dirty = createSession(true);
        const harness = createHarness({
            decision,
            sessions: {dirty: dirty.session},
            tabs: [createTab('dirty')],
        });

        await expect(harness.closeHandler({requestId: requireRequestId(`close-${decision}`)})).resolves.toBe(decision);
        expect(dirty.handleSave).not.toHaveBeenCalled();
    });

    it('cancels when a dirty workspace cannot be saved', async () => {
        const dirty = createSession(true, false);
        const harness = createHarness({
            decision: 'save',
            sessions: {dirty: dirty.session},
            tabs: [createTab('dirty')],
        });

        await expect(harness.closeHandler({requestId: requireRequestId('close-failed-save')})).resolves.toBe('cancel');
        expect(dirty.handleSave).toHaveBeenCalledOnce();
    });

    it('waits for a dirty workspace that mounts during the close handshake', async () => {
        const dirty = createSession(true, true, true);
        const harness = createHarness({
            decision: 'save',
            sessions: {dirty: dirty.session},
            tabs: [createTab('dirty')],
        });

        const close = harness.closeHandler({requestId: requireRequestId('close-late-workspace')});
        await vi.waitFor(() => expect(dirty.session.waitForWorkspace).toHaveBeenCalledOnce());
        dirty.resolveWorkspace();

        await expect(close).resolves.toBe('save');
        expect(dirty.handleSave).toHaveBeenCalledOnce();
    });

    it('fails closed when the dirty workspace never mounts', async () => {
        const dirty = createSession(true, true, true);
        const harness = createHarness({
            decision: 'save',
            sessions: {dirty: dirty.session},
            tabs: [createTab('dirty')],
        });

        const close = harness.closeHandler({requestId: requireRequestId('close-missing-workspace')});
        await vi.waitFor(() => expect(dirty.session.waitForWorkspace).toHaveBeenCalledOnce());
        dirty.resolveWorkspace(null);

        await expect(close).resolves.toBe('cancel');
        expect(dirty.handleSave).not.toHaveBeenCalled();
    });

    it('unsubscribes the close handler with the renderer scope', () => {
        const {session} = createSession(false);
        const harness = createHarness({
            sessions: {clean: session},
            tabs: [{
                ...createTab('clean'),
                isDirty: false,
            }],
        });

        expect(harness.onWindowCloseRequest).toHaveBeenCalledOnce();
        scopes[0]?.stop();

        expect(harness.unsubscribe).toHaveBeenCalledOnce();
    });
});
