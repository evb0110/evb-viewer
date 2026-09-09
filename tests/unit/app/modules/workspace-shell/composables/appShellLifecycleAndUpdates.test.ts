// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/utils/traceRendererStartup';

import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IUpdateDialogState} from '@app/composables/useAppUpdates';
import {useAppShellLifecycle} from '@app/modules/workspace-shell/composables/useAppShellLifecycle';
import {useAppShellUpdatesDialog} from '@app/modules/workspace-shell/composables/useAppShellUpdatesDialog';
import {createDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {requireEpochMs} from '@contracts/timestamps';

const mocks = vi.hoisted(() => ({
    logError: vi.fn(),
    onIncomingTransfer: vi.fn(),
    traceRendererStartup: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {error: mocks.logError}}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({onIncomingTransfer: mocks.onIncomingTransfer})}));
vi.mock('@app/utils/traceRendererStartup', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    traceRendererStartup: mocks.traceRendererStartup,
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('useTypedI18n', () => ({t: (key: string, params?: Record<string, string | number>) => (
        params === undefined ? key : `${key}:${JSON.stringify(params)}`
    )}));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('app shell lifecycle', () => {
    it('installs and tears down transfer handling while closing dismissed dialogs', async () => {
        const incomingTransferCleanup = vi.fn();
        let incomingTransfer: ((transfer: {transferId: string}) => void) | undefined;
        mocks.onIncomingTransfer.mockImplementation((callback: typeof incomingTransfer) => {
            incomingTransfer = callback;
            return incomingTransferCleanup;
        });
        const cleanupEmptyPanes = vi.fn();
        const ensureUpdatesInitialized = vi.fn(async () => undefined);
        const cleanupDirectionalTabs = vi.fn();
        const cleanupExternalFileDrop = vi.fn();
        const resolveDirtyTabCloseDialog = vi.fn();
        const closeUpdatesDialog = vi.fn();
        const handleIncomingTabTransfer = vi.fn(async (_transfer: {transferId: string}) => {
            throw new Error('local transfer detail');
        });
        const dirtyTabCloseDialogOpen = ref(true);
        const updatesDialogOpen = ref(true);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            useAppShellLifecycle({
                dirtyTabCloseDialogOpen,
                updatesDialogOpen,
                cleanupEmptyPanes,
                ensureUpdatesInitialized,
                handleIncomingTabTransfer,
                cleanupDirectionalTabs,
                cleanupExternalFileDrop,
                resolveDirtyTabCloseDialog,
                closeUpdatesDialog,
            });
            return () => h('main');
        }}));
        app.mount(host);

        expect(cleanupEmptyPanes).toHaveBeenCalledOnce();
        expect(ensureUpdatesInitialized).toHaveBeenCalledOnce();
        expect(mocks.onIncomingTransfer).toHaveBeenCalledOnce();

        incomingTransfer?.({transferId: 'transfer-1'});
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.logError).toHaveBeenCalledWith(
            'tabs',
            'Incoming tab transfer handler rejected',
            expect.objectContaining({transferId: 'transfer-1'}),
            {
                code: 'RENDERER_TAB_TRANSFER_OPERATION_FAILED',
                context: {},
            },
        );

        dirtyTabCloseDialogOpen.value = false;
        updatesDialogOpen.value = false;
        await nextTick();
        expect(resolveDirtyTabCloseDialog).toHaveBeenCalledWith(false);
        expect(closeUpdatesDialog).toHaveBeenCalledOnce();

        app.unmount();
        host.remove();
        expect(cleanupDirectionalTabs).toHaveBeenCalledOnce();
        expect(incomingTransferCleanup).toHaveBeenCalledOnce();
        expect(cleanupExternalFileDrop).toHaveBeenCalledOnce();
    });
});

describe('app shell update dialog bindings', () => {
    it('derives failure copy and forwards every user action', () => {
        const closeUpdatesDialog = vi.fn();
        const deferUpdate = vi.fn(async () => undefined);
        const downloadUpdate = vi.fn(async () => undefined);
        const skipUpdateVersion = vi.fn(async () => undefined);
        const installUpdateNow = vi.fn(async () => undefined);
        const updatesDialog = ref<IUpdateDialogState>({
            open: true,
            kind: 'status',
            phase: 'error',
            version: '2.0.0',
            percent: null,
            message: 'Update failed',
            failure: {failure: {
                eventId: createDiagnosticEventId(),
                code: 'UPDATE_OPERATION_FAILED',
                occurredAt: requireEpochMs(1),
                severity: 'error',
            }},
        });
        const bindings = useAppShellUpdatesDialog({
            updatesDialog,
            updatesDialogVersion: computed(() => updatesDialog.value.version),
            closeUpdatesDialog,
            deferUpdate,
            downloadUpdate,
            skipUpdateVersion,
            installUpdateNow,
        });

        expect(bindings.updatesDialogTitle.value).toBe('updates.errorTitle');
        expect(bindings.updatesDialogDescription.value).toContain('Update failed');
        expect(bindings.updatesDialogFailurePresentation.value).toMatchObject({
            title: 'updates.errorTitle',
            description: expect.stringContaining('Update failed'),
            failure: {code: 'UPDATE_OPERATION_FAILED'},
        });

        bindings.handleDeferUpdate();
        bindings.handleDownloadUpdate();
        bindings.handleSkipUpdate();
        bindings.handleInstallUpdate();

        expect(closeUpdatesDialog).toHaveBeenCalledTimes(2);
        expect(deferUpdate).toHaveBeenCalledOnce();
        expect(downloadUpdate).toHaveBeenCalledOnce();
        expect(skipUpdateVersion).toHaveBeenCalledOnce();
        expect(installUpdateNow).toHaveBeenCalledOnce();

        updatesDialog.value = {
            ...updatesDialog.value,
            kind: 'available',
            phase: 'available',
            failure: null,
        };
        expect(bindings.updatesDialogTitle.value).toBe('updates.availableTitle');
        expect(bindings.updatesDialogDescription.value).toContain('2.0.0');
        expect(bindings.updatesDialogFailurePresentation.value).toBeNull();
    });
});
