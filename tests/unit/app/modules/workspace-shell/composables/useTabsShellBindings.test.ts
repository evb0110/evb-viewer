import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createRenderer,
    createSSRApp,
    defineComponent,
    nextTick,
    ref,
    watch,
} from 'vue';
import { renderToString } from '@vue/server-renderer';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    createKeyboardEventFixture,
    createWorkspaceAutomationStateSnapshot,
    createWorkspaceExposeFixture,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

const mocks = vi.hoisted(() => ({
    lifecycleOrder: [] as string[],
    useEventListener: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
    registerTabsMenuBindings: vi.fn(() => []),
    documentMenuCapability: {},
    settingsCapability: {},
    updatesCapability: {},
    djvuCapability: {},
    shouldPreferDesktopPlatform: vi.fn(() => false),
    waitForDesktopPlatformBridge: vi.fn(async () => true),
    claimPendingExternalOpenPaths: vi.fn(async (): Promise<string[]> => []),
    acknowledgePendingExternalOpenPaths: vi.fn(async () => {}),
    workspaceCheckpointClaimEnabled: false,
    claimWorkspaceCheckpoint: vi.fn(async () => null),
    notifyRendererReady: vi.fn(),
    getOrCaptureRendererBootstrapFailure: vi.fn((options: {error: unknown}) => ({
        failure: {error: options.error},
        title: 'Startup failure',
    })),
    setFatalRuntimeError: vi.fn(),
    getWorkspaceViewerChunkTargetsForPaths: vi.fn(() => [
        'chassis',
        'pdfjs',
        'native-pdf',
    ]),
    warmupDesktopViewerChunkForPaths: vi.fn(async () => []),
    cancelDesktopViewerWarmup: vi.fn(),
    scheduleDesktopViewerWarmup: vi.fn(),
    resolveStartupWorkProfile: vi.fn(() => ({
        tier: 'high',
        desktopViewerWarmupStrategy: 'eager',
        recentGeometryCandidateLimit: 4,
        recentGeometryConcurrency: 2,
    })),
}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/shouldHandleRendererMenuAccelerators', () => ({shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators}));
vi.mock('@app/modules/workspace-shell/menu/registerTabsMenuBindings', () => ({registerTabsMenuBindings: mocks.registerTabsMenuBindings}));
vi.mock('@app/utils/platform', () => ({
    shouldPreferDesktopPlatform: mocks.shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge: mocks.waitForDesktopPlatformBridge,
}));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentMenuCapability: () => mocks.documentMenuCapability,
}));
vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => mocks.settingsCapability}));
vi.mock('@app/utils/platformUpdates', () => ({getUpdatesCapability: () => mocks.updatesCapability}));
vi.mock('@app/utils/getDjvuCapability', () => ({getDjvuCapability: () => mocks.djvuCapability}));
vi.mock('@app/utils/startupWorkProfile', () => ({resolveStartupWorkProfile: mocks.resolveStartupWorkProfile}));
vi.mock('@app/modules/workspace-shell/host/warmupDesktopViewerChunks', () => ({
    getWorkspaceViewerChunkTargetsForPaths: mocks.getWorkspaceViewerChunkTargetsForPaths,
    warmupDesktopViewerChunkForPaths: mocks.warmupDesktopViewerChunkForPaths,
    scheduleDesktopViewerWarmup: mocks.scheduleDesktopViewerWarmup,
}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    claimPendingExternalOpenPaths: mocks.claimPendingExternalOpenPaths,
    acknowledgePendingExternalOpenPaths: mocks.acknowledgePendingExternalOpenPaths,
    ...(mocks.workspaceCheckpointClaimEnabled
        ? {claimWorkspaceCheckpoint: mocks.claimWorkspaceCheckpoint}
        : {}),
    notifyRendererReady: mocks.notifyRendererReady,
})}));
vi.mock('@app/utils/getOrCaptureRendererBootstrapFailure', () => ({getOrCaptureRendererBootstrapFailure: mocks.getOrCaptureRendererBootstrapFailure}));
vi.mock('@app/composables/useFatalRuntimeError', () => ({useFatalRuntimeError: () => ({setFatalRuntimeError: mocks.setFatalRuntimeError})}));

function createOptions() {
    const toolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
    const workspace = createWorkspaceExposeFixture({
        getAutomationStateSnapshot: vi.fn(() => createWorkspaceAutomationStateSnapshot({workingCopyPath: requireDocumentRef('/tmp/active.pdf')})),
        getToolbarSnapshot: vi.fn(() => toolbarSnapshot),
        handleSaveAs: vi.fn(),
        handleRepairSave: vi.fn(),
        handleExportDocx: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
    });
    const activeWorkspace = ref<IWorkspaceExpose>(workspace);

    return {
        tabs: ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]),
        workspaceRefs: ref(new Map<string, IWorkspaceExpose>([[
            'tab-1',
            activeWorkspace.value,
        ]])),
        documentRecordsByTabId: ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({'tab-1': createWorkspaceDocumentRecord({ toolbarSnapshot })}),
        isStartupOpenClaimPending: ref(true),
        activeTabId: ref('tab-1'),
        activeWorkspace,
        createTab: vi.fn(() => ({id: 'tab-2'})),
        activateTab: vi.fn(),
        handleCloseTab: vi.fn(),
        handleFallbackToolbarOpenFile: vi.fn(),
        openPathInAppropriateTab: vi.fn(),
        openPathsInAppropriateTab: vi.fn(),
        beginOpenPathsInAppropriateTab: vi.fn(),
        restoreWorkspaceCheckpointGraph: vi.fn(),
        openPathInReservedTab: vi.fn(),
        clearRecentFiles: vi.fn(),
        loadRecentFiles: vi.fn(),
        openSettings: vi.fn(),
        checkForUpdates: vi.fn(),
        splitEditor: vi.fn(),
        focusPane: vi.fn(),
        moveActiveTab: vi.fn(),
        copyActiveTab: vi.fn(),
        handleWindowTabsAction: vi.fn(),
        toggleAssistant: vi.fn(),
        workspace,
    };
}

function createWorkspaceForAutomation(snapshot: Partial<IWorkspaceToolbarSnapshot>) {
    return createWorkspaceExposeFixture({
        getAutomationStateSnapshot: vi.fn(() => createWorkspaceAutomationStateSnapshot({workingCopyPath: requireDocumentRef(`/tmp/page-${snapshot.currentPage ?? 1}.pdf`)})),
        getToolbarSnapshot: vi.fn(() => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            ...snapshot,
        })),
        handleUndo: vi.fn(),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
    });
}

let capturedKeydown: ((event: KeyboardEvent) => void) | undefined;

class CustomEventStub<T = unknown> {
    readonly detail: T | null;
    readonly type: string;

    constructor(type: string, init?: CustomEventInit<T>) {
        this.type = type;
        this.detail = init?.detail ?? null;
    }
}

async function mountBindings(options: ReturnType<typeof createOptions>) {
    const { useTabsShellBindings } = await import('@app/modules/workspace-shell/composables/useTabsShellBindings');
    const app = createSSRApp(defineComponent({setup() {
        useTabsShellBindings(options);
        return () => null;
    }}));

    await renderToString(app);

    return () => {};
}

async function mountBindingsClient(options: ReturnType<typeof createOptions>) {
    const { useTabsShellBindings } = await import('@app/modules/workspace-shell/composables/useTabsShellBindings');
    const renderer = createRenderer<Record<string, unknown>, Record<string, unknown>>({
        createElement: type => ({type}),
        createText: text => ({text}),
        createComment: text => ({text}),
        setText: () => {},
        setElementText: () => {},
        patchProp: () => {},
        insert: () => {},
        remove: () => {},
        parentNode: () => null,
        nextSibling: () => null,
    });
    const app = renderer.createApp(defineComponent({setup() {
        useTabsShellBindings(options);
        return () => null;
    }}));
    const root = {};
    app.mount(root);
    await nextTick();

    return () => app.unmount();
}

async function flushMountedStartupClaim() {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
}

describe('useTabsShellBindings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.lifecycleOrder.length = 0;
        capturedKeydown = undefined;
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('CustomEvent', CustomEventStub);
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        mocks.shouldPreferDesktopPlatform.mockReturnValue(false);
        mocks.waitForDesktopPlatformBridge.mockResolvedValue(true);
        mocks.claimPendingExternalOpenPaths.mockResolvedValue([]);
        mocks.acknowledgePendingExternalOpenPaths.mockResolvedValue(undefined);
        mocks.workspaceCheckpointClaimEnabled = false;
        mocks.claimWorkspaceCheckpoint.mockResolvedValue(null);
        mocks.getOrCaptureRendererBootstrapFailure.mockImplementation((options: {error: unknown}) => ({
            failure: {error: options.error},
            title: 'Startup failure',
        }));
        mocks.acknowledgePendingExternalOpenPaths.mockImplementation(async () => {
            mocks.lifecycleOrder.push('acknowledge');
        });
        mocks.notifyRendererReady.mockImplementation(() => {
            mocks.lifecycleOrder.push('notify');
        });
        mocks.warmupDesktopViewerChunkForPaths.mockImplementation(async () => {
            mocks.lifecycleOrder.push('matching-settled');
            return [];
        });
        mocks.scheduleDesktopViewerWarmup.mockImplementation(() => {
            mocks.lifecycleOrder.push('schedule-all');
            return {
                completion: Promise.resolve(),
                cancel: mocks.cancelDesktopViewerWarmup,
            };
        });
        mocks.useEventListener.mockImplementation((_target, event, listener) => {
            if (event === 'keydown') {
                capturedKeydown = listener;
            }
            return vi.fn();
        });
        if (typeof window !== 'undefined') {
            delete window.__allowRendererFileOpenForAutomation;
            delete window.__evbTestApi;
            delete window.__handleSave;
            delete window.__openFileDirect;
        }
    });

    it('keeps the stable automation API absent when automation hooks are unavailable', async () => {
        const options = createOptions();

        const unmount = await mountBindingsClient(options);

        expect(window.__evbTestApi).toBeUndefined();
        expect(window.__openFileDirect).not.toBe(options.openPathInAppropriateTab);
        await expect(window.__openFileDirect?.(requireDocumentRef('/tmp/sample.pdf'))).resolves.toBeUndefined();
        unmount();
    });

    it('installs and cleans up the stable test API in automation mode', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        options.openPathInAppropriateTab = vi.fn(async () => true);

        const unmount = await mountBindingsClient(options);
        const { emitAutomationEvent } = await import('@app/modules/workspace-shell/automation/automationReadinessEvents');
        const observedEvents: string[] = [];
        const stopObserving = window.__evbTestApi?.onAutomationEvent(event => {
            observedEvents.push(event.type);
        });
        const eventPromise = window.__evbTestApi?.waitForAutomationEvent('navigation-idle', event => event.detail.page === 3, 1_000);
        emitAutomationEvent('navigation-idle', {page: 3});

        await expect(window.__evbTestApi?.openFile(requireDocumentRef('/tmp/sample.pdf'))).resolves.toBe(true);
        expect(options.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/sample.pdf');
        expect(window.__evbTestApi?.getActiveTabId()).toBe('tab-1');
        expect(window.__evbTestApi?.isStartupOpenClaimPending()).toBe(false);
        expect(window.__evbTestApi?.getActiveToolbarSnapshot()?.currentPage).toBe(1);
        await window.__evbTestApi?.splitEditor('right');
        expect(options.splitEditor).toHaveBeenCalledWith('right');
        await expect(eventPromise).resolves.toMatchObject({
            detail: {page: 3},
            type: 'navigation-idle',
        });
        expect(window.__evbTestApi?.getAutomationEvents().at(-1)).toMatchObject({type: 'navigation-idle'});
        expect(observedEvents).toContain('navigation-idle');
        stopObserving?.();
        await expect(window.__evbTestApi?.waitForActiveDocumentOpenSettled()).resolves.toBe(true);

        unmount();

        expect(window.__evbTestApi).toBeUndefined();
        expect(window.__openFileDirect).toBeTypeOf('function');
        await expect(window.__openFileDirect?.(requireDocumentRef('/tmp/sample.pdf'))).resolves.toBe(false);
    });

    it('keeps direct-open dispatcher stable across shell binding remounts', async () => {
        const firstOptions = createOptions();
        firstOptions.openPathInAppropriateTab = vi.fn(async () => true);

        const unmountFirst = await mountBindingsClient(firstOptions);
        const dispatcher = window.__openFileDirect;

        expect(dispatcher).toBeTypeOf('function');
        await expect(dispatcher?.(requireDocumentRef('/tmp/first.pdf'))).resolves.toBe(true);
        expect(firstOptions.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/first.pdf');

        unmountFirst();

        expect(window.__openFileDirect).toBe(dispatcher);
        await expect(window.__openFileDirect?.(requireDocumentRef('/tmp/unbound.pdf'))).resolves.toBe(false);

        const secondOptions = createOptions();
        secondOptions.openPathInAppropriateTab = vi.fn(async () => true);
        const unmountSecond = await mountBindingsClient(secondOptions);

        expect(window.__openFileDirect).toBe(dispatcher);
        await expect(window.__openFileDirect?.(requireDocumentRef('/tmp/second.pdf'))).resolves.toBe(true);
        expect(secondOptions.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/second.pdf');

        unmountSecond();
    });

    it('reads the current active workspace through the automation API after tab changes', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        const secondWorkspace = createWorkspaceForAutomation({ currentPage: 7 });

        const unmount = await mountBindingsClient(options);
        const installedApi = window.__evbTestApi;

        expect(installedApi?.getActiveToolbarSnapshot()?.currentPage).toBe(1);

        options.tabs.value.push({
            id: 'tab-2',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
        options.activeTabId.value = 'tab-2';
        options.activeWorkspace.value = secondWorkspace;
        options.workspaceRefs.value.set('tab-2', secondWorkspace);
        options.documentRecordsByTabId.value = {
            ...options.documentRecordsByTabId.value,
            'tab-2': createWorkspaceDocumentRecord({toolbarSnapshot: {
                hasPdf: true,
                currentPage: 7,
                totalPages: 10,
            }}),
        };
        await nextTick();

        expect(installedApi?.getActiveTabId()).toBe('tab-2');
        expect(installedApi?.getActiveToolbarSnapshot()?.currentPage).toBe(7);
        await expect(installedApi?.callActiveWorkspaceCommand('handleUndo')).resolves.toEqual({
            called: true,
            value: null,
        });
        expect(secondWorkspace.handleUndo).toHaveBeenCalledOnce();
        await expect(installedApi?.callActiveWorkspaceCommand('workingCopyPath')).resolves.toEqual({
            called: false,
            value: null,
        });
        expect(installedApi?.readActiveWorkspaceStateValues(['workingCopyPath'])).toEqual({ workingCopyPath: '/tmp/page-7.pdf' });

        unmount();
    });

    it('returns synchronous automation commands before Vue flushes their reactive effects', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        const zoom = ref(1);
        const zoomEffect = vi.fn();
        watch(zoom, zoomEffect);
        options.activeWorkspace.value.setCustomZoomFromDisplay = vi.fn((value: number) => {
            zoom.value = value;
        });

        const unmount = await mountBindingsClient(options);
        const installedApi = window.__evbTestApi;
        const syncResult = installedApi?.callActiveWorkspaceSyncCommand(
            'setCustomZoomFromDisplay',
            [2],
        );

        expect(syncResult).toEqual({
            called: true,
            value: null,
        });
        expect(syncResult).not.toBeInstanceOf(Promise);
        expect(zoomEffect).not.toHaveBeenCalled();

        await nextTick();
        expect(zoomEffect).toHaveBeenCalledOnce();

        zoomEffect.mockClear();
        const normalizedResult = installedApi?.callActiveWorkspaceCommand(
            'setCustomZoomFromDisplay',
            [3],
        );
        expect(normalizedResult).toBeInstanceOf(Promise);
        expect(zoomEffect).not.toHaveBeenCalled();
        await normalizedResult;
        expect(zoomEffect).toHaveBeenCalledOnce();

        unmount();
    });

    it('prefers the mounted workspace revision over a lagging persisted toolbar snapshot', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        options.activeWorkspace.value.getToolbarSnapshot = vi.fn(() => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            currentPage: 18,
            effectiveZoom: 4.72,
            totalPages: 501,
        }));

        const unmount = await mountBindingsClient(options);

        expect(window.__evbTestApi?.getActiveToolbarSnapshot()).toMatchObject({
            currentPage: 18,
            effectiveZoom: 4.72,
            totalPages: 501,
        });
        expect(options.documentRecordsByTabId.value['tab-1']?.toolbarSnapshot).toMatchObject({
            currentPage: 1,
            effectiveZoom: 1,
        });

        unmount();
    });

    it('settles startup open claim after mounted startup work', async () => {
        const options = createOptions();
        options.isStartupOpenClaimPending.value = false;

        const unmount = await mountBindingsClient(options);

        await flushMountedStartupClaim();
        expect(options.isStartupOpenClaimPending.value).toBe(false);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        unmount();
    });

    it('waits for claimed startup external paths before notifying renderer readiness', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        let resolveMatchingWarmup: (() => void) | undefined;
        let resolveStartupOpen: (() => void) | undefined;
        mocks.warmupDesktopViewerChunkForPaths.mockImplementationOnce(() => new Promise((resolve) => {
            resolveMatchingWarmup = () => {
                mocks.lifecycleOrder.push('matching-settled');
                resolve([]);
            };
        }));
        options.beginOpenPathsInAppropriateTab = vi.fn(() => new Promise<string[]>((resolve) => {
            mocks.lifecycleOrder.push('open-started');
            resolveStartupOpen = () => resolve([]);
        }));
        mocks.claimPendingExternalOpenPaths.mockResolvedValue(['/tmp/startup.pdf']);

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(mocks.warmupDesktopViewerChunkForPaths).toHaveBeenCalledWith({
            isDesktopRuntime: false,
            paths: ['/tmp/startup.pdf'],
        });
        expect(options.beginOpenPathsInAppropriateTab).not.toHaveBeenCalled();
        expect(mocks.notifyRendererReady).not.toHaveBeenCalled();

        resolveMatchingWarmup?.();
        await flushMountedStartupClaim();

        expect(options.beginOpenPathsInAppropriateTab).toHaveBeenCalledWith(['/tmp/startup.pdf']);
        expect(options.isStartupOpenClaimPending.value).toBe(true);
        expect(window.__evbTestApi?.isStartupOpenClaimPending()).toBe(true);
        expect(mocks.notifyRendererReady).not.toHaveBeenCalled();
        expect(mocks.acknowledgePendingExternalOpenPaths).not.toHaveBeenCalled();

        resolveStartupOpen?.();
        await flushMountedStartupClaim();

        expect(mocks.acknowledgePendingExternalOpenPaths).toHaveBeenCalledWith([]);
        expect(options.isStartupOpenClaimPending.value).toBe(false);
        expect(window.__evbTestApi?.isStartupOpenClaimPending()).toBe(false);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        expect(mocks.scheduleDesktopViewerWarmup).toHaveBeenCalledOnce();
        expect(mocks.lifecycleOrder).toEqual([
            'matching-settled',
            'open-started',
            'acknowledge',
            'notify',
            'schedule-all',
        ]);
        unmount();
    });

    it('acknowledges failed startup external paths before renderer readiness', async () => {
        const options = createOptions();
        options.beginOpenPathsInAppropriateTab = vi.fn(async () => ['/tmp/missing.pdf']);
        mocks.claimPendingExternalOpenPaths.mockResolvedValue(['/tmp/missing.pdf']);

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(mocks.acknowledgePendingExternalOpenPaths).toHaveBeenCalledWith(['/tmp/missing.pdf']);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        expect(mocks.lifecycleOrder.indexOf('acknowledge')).toBeLessThan(mocks.lifecycleOrder.indexOf('notify'));
        expect(mocks.lifecycleOrder.indexOf('notify')).toBeLessThan(mocks.lifecycleOrder.indexOf('schedule-all'));
        unmount();
    });

    it('does not invoke matching warmup when startup has no paths', async () => {
        const options = createOptions();

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(mocks.warmupDesktopViewerChunkForPaths).not.toHaveBeenCalled();
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        expect(mocks.scheduleDesktopViewerWarmup).toHaveBeenCalledOnce();
        unmount();
    });

    it('notifies and schedules once when startup preparation fails', async () => {
        const options = createOptions();
        mocks.workspaceCheckpointClaimEnabled = true;
        mocks.claimWorkspaceCheckpoint.mockRejectedValueOnce(new Error('checkpoint claim failed'));

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(mocks.getOrCaptureRendererBootstrapFailure).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({message: 'checkpoint claim failed'}),
            key: 'workspace-startup',
        }));
        expect(mocks.setFatalRuntimeError).toHaveBeenCalledWith(
            'startup',
            expect.objectContaining({title: 'Startup failure'}),
        );
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        expect(mocks.scheduleDesktopViewerWarmup).toHaveBeenCalledOnce();
        expect(mocks.lifecycleOrder).toEqual([
            'notify',
            'schedule-all',
        ]);
        unmount();
        expect(mocks.cancelDesktopViewerWarmup).toHaveBeenCalledOnce();
    });

    it('routes web renderer menu shortcuts that have no native browser menu', async () => {
        const options = createOptions();
        const unmount = await mountBindings(options);

        const cases = [
            {
                key: 'o',
                shiftKey: false,
                run: options.handleFallbackToolbarOpenFile,
            },
            {
                key: 's',
                shiftKey: true,
                run: options.workspace.handleSaveAs,
            },
            {
                key: 'e',
                shiftKey: true,
                run: options.workspace.handleExportDocx,
            },
            {
                key: 'z',
                shiftKey: false,
                run: options.workspace.handleUndo,
            },
            {
                key: 'z',
                shiftKey: true,
                run: options.workspace.handleRedo,
            },
            {
                key: 'y',
                shiftKey: false,
                run: options.workspace.handleRedo,
            },
        ];

        for (const shortcut of cases) {
            const preventDefault = vi.fn();
            const stopPropagation = vi.fn();
            const stopImmediatePropagation = vi.fn();
            capturedKeydown?.(createKeyboardEventFixture({
                key: shortcut.key,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                shiftKey: shortcut.shiftKey,
                target: null,
                preventDefault,
                stopPropagation,
                stopImmediatePropagation,
            }));

            expect(preventDefault).toHaveBeenCalledOnce();
            expect(stopPropagation).toHaveBeenCalledOnce();
            expect(stopImmediatePropagation).toHaveBeenCalledOnce();
            expect(shortcut.run).toHaveBeenCalled();
        }

        unmount();
    });

    it('logs rejected renderer document shortcuts without leaking the rejection', async () => {
        const options = createOptions();
        options.handleFallbackToolbarOpenFile = vi.fn(async () => {
            throw new Error('picker failed');
        });
        const unmount = await mountBindings(options);
        const { BrowserLogger } = await import('@app/utils/browserLogger');
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(
            () => ({}) as ReturnType<typeof BrowserLogger.error>,
        );

        capturedKeydown?.(createKeyboardEventFixture({
            key: 'o',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        }));
        await Promise.resolve();

        expect(options.handleFallbackToolbarOpenFile).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
            'tabs-shell',
            'Renderer document shortcut failed: open-file',
            {
                category: 'user-visible-operation',
                error: expect.any(Error),
            },
            {
                code: 'RENDERER_ASYNC_GUARD_FAILED',
                context: {category: 'user-visible-operation'},
            },
        );

        unmount();
        errorSpy.mockRestore();
    });

    it('keeps text editing undo and redo in editable controls', async () => {
        const options = createOptions();
        const unmount = await mountBindings(options);

        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        const preventDefault = vi.fn();
        capturedKeydown?.(createKeyboardEventFixture({
            key: 'z',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(options.workspace.handleUndo).not.toHaveBeenCalled();
        unmount();
    });
});
