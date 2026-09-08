import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    DIAGNOSTICS_POLICY_ARGUMENT_PREFIX,
} from '@electron/platform-ipc/coreContract';
import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    type IHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';
import { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';

const agentEventChannels = AGENT_PLATFORM_FEATURE.eventChannels;
const documentsClientMock = vi.hoisted(() => ({
    openDocumentDialog: vi.fn(async () => null),
    openCombineDialog: vi.fn(async () => null),
    openFolderDialog: vi.fn(async () => null),
    openFolderDialogStructured: vi.fn(async () => ({
        ok: false,
        reason: 'unsupported',
    })),
    openImageDialog: vi.fn(async () => null),
    openDocumentDirect: vi.fn(async (path: string) => ({ path })),
    openDocumentDirectBatch: vi.fn(async (paths: string[]) => paths),
    savePdfAs: vi.fn(async () => null),
    savePdfDataAs: vi.fn(async () => ({
        path: null,
        validation: null,
    })),
    savePdfDialog: vi.fn(async () => null),
    saveDocxAs: vi.fn(async () => null),
    readFile: vi.fn(async () => new Uint8Array()),
    statFile: vi.fn(async () => ({size: 0})),
    getWorkingCopyBackingStatus: vi.fn(async () => null),
    onWorkingCopyBackingStatusChanged: vi.fn(() => () => {}),
    readFileRange: vi.fn(async () => new Uint8Array()),
    createManagedTempFileHandle: vi.fn(async () => ({
        path: '/tmp/managed.pdf',
        size: 0,
        sha256: '0'.repeat(64),
        leaseId: 'managed-lease',
    })),
    releaseManagedTempFileHandle: vi.fn(async () => true),
    getPdfOpeningGeometry: vi.fn(async () => ({
        pageNumber: 1 as const,
        pageCount: 1,
        width: 612,
        height: 792,
        rotation: 0 as const,
        size: 0,
        modifiedAt: 0,
    })),
    getPdfNativePageSizes: vi.fn(async () => []),
    cancelPdfNativePagePreview: vi.fn(async () => ({canceled: true})),
    renderPdfNativePagePreview: vi.fn(async () => ({
        bytes: new Uint8Array(),
        height: 0,
        width: 0,
    })),
    readFileChunks: vi.fn(async () => ({
        size: 0,
        bytesRead: 0,
        chunks: 0,
    })),
    readTextFile: vi.fn(async () => ''),
    fileExists: vi.fn(async () => false),
    getDocumentRevision: vi.fn(async () => ({
        version: 1,
        documentRef: '/tmp/working-copy.pdf',
        authority: 'electron-working-copy',
        token: 'drt1:1:1:test',
        contentRevision: 1,
        mintedAt: 1,
    })),
    onDocumentRevisionChanged: vi.fn(),
    analyzePdfConformance: vi.fn(async () => ({})),
    validatePdfData: vi.fn(async () => ({valid: true})),
    validatePdfPath: vi.fn(async () => ({valid: true})),
    openPdfInDefaultAppData: vi.fn(async () => ({success: true})),
    openPdfInDefaultAppPath: vi.fn(async () => ({success: true})),
    printPdfData: vi.fn(async () => ({success: true})),
    printPdfPath: vi.fn(async () => ({success: true})),
    writeFile: vi.fn(async () => true),
    replaceWorkingCopyFromPath: vi.fn(async () => true),
    writeDocxFile: vi.fn(async () => true),
    createWorkingCopyFromData: vi.fn(async () => '/tmp/working-copy.pdf'),
    createWorkingCopyFromPath: vi.fn(async () => '/tmp/working-copy.pdf'),
    saveFileStructured: vi.fn(async () => ({
        ok: true,
        externalWriteCommitted: true,
        workingCopyRefreshed: true,
        validation: null,
    })),
    resyncWorkingCopy: vi.fn(async () => ({success: true})),
    savePdfData: vi.fn(async () => ({valid: true})),
    savePdfDataChunks: vi.fn(async () => ({valid: true})),
    repairPdf: vi.fn(async () => ({valid: true})),
    optimizePdfForInteraction: vi.fn(async () => ({valid: true})),
    optimizePdfAsCopy: vi.fn(async () => ({success: true})),
    savePdfNoteTextUpdates: vi.fn(async () => ({success: true})),
    savePdfNoteChanges: vi.fn(async () => ({success: true})),
    savePdfNativeMutations: vi.fn(async () => ({success: true})),
    applyPdfNativeMutationsToWorkingCopy: vi.fn(async () => ({success: true})),
    commitStagedPdfNativeMutations: vi.fn(async () => ({success: true})),
    cleanupFile: vi.fn(async () => undefined),
    cleanupOcrTemp: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(async () => true),
    showItemInFolderStructured: vi.fn(async () => ({ok: true})),
    createCombinedPdfFromFiles: vi.fn(async () => new Uint8Array()),
    recentFiles: {
        get: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        removeIfMissing: vi.fn(async () => false),
        clear: vi.fn(async () => undefined),
    },
    setMenuDocumentState: vi.fn(async () => undefined),
    setMenuTabCount: vi.fn(async () => undefined),
    onPdfOptimizeProgress: vi.fn(),
    onMenuOpenPdf: vi.fn(),
    onMenuInsertImageFromFile: vi.fn(),
    onMenuPasteImageFromClipboard: vi.fn(),
    onMenuSave: vi.fn(),
    onMenuRepairSave: vi.fn(),
    onMenuOptimizePdfForInteraction: vi.fn(),
    onMenuSaveAs: vi.fn(),
    onMenuPrint: vi.fn(),
    onMenuPrintCurrentPage: vi.fn(),
    onMenuExportDocx: vi.fn(),
    onMenuExportImages: vi.fn(),
    onMenuExportMultiPageTiff: vi.fn(),
    onMenuZoomIn: vi.fn(),
    onMenuZoomOut: vi.fn(),
    onMenuActualSize: vi.fn(),
    onMenuFitWidth: vi.fn(),
    onMenuFitHeight: vi.fn(),
    onMenuToggleContinuousScroll: vi.fn(),
    onMenuViewModeSingle: vi.fn(),
    onMenuViewModeFacing: vi.fn(),
    onMenuViewModeFacingFirstSingle: vi.fn(),
    onMenuToggleAssistant: vi.fn(),
    onMenuUndo: vi.fn(),
    onMenuRedo: vi.fn(),
    onMenuSelectAll: vi.fn(),
    onMenuDeletePages: vi.fn(),
    onMenuExtractPages: vi.fn(),
    onMenuRotateCw: vi.fn(),
    onMenuRotateCcw: vi.fn(),
    onMenuInsertPages: vi.fn(),
    onMenuOpenRecentFile: vi.fn(),
    onMenuOpenExternalPaths: vi.fn(),
    onMenuClearRecentFiles: vi.fn(),
    onOpenDocumentDirectBatchProgress: vi.fn(),
}));
vi.mock('@electron/features/documents/createDocumentsPreloadClient', () => ({createDocumentsPreloadClient: () => documentsClientMock}));
vi.mock('@electron/preload/debugLogBuffer', () => ({ getDebugLogMessages: () => [] }));

let expectedDecodedEventWarningSpy: ReturnType<typeof vi.spyOn> | null = null;

function silenceExpectedDecodedEventWarnings() {
    expectedDecodedEventWarningSpy?.mockRestore();
    expectedDecodedEventWarningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return expectedDecodedEventWarningSpy;
}

type TIpcEventListener = (_event: unknown, payload: unknown) => void;

async function createApiHarness(options: {
    getPathForFile?: () => string;
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
} = {}) {
    const listeners = new Map<string, TIpcEventListener>();
    const ipcRenderer = {
        invoke: vi.fn(options.invoke ?? (async () => undefined)),
        on: vi.fn((channel: string, handler: TIpcEventListener) => {
            listeners.set(channel, handler);
        }),
        removeListener: vi.fn(),
        send: vi.fn(),
    };
    const { createElectronApi } = await import('@electron/preload/createElectronApi');
    const api = createElectronApi(
        ipcRenderer as never,
        {getPathForFile: options.getPathForFile ?? (() => '')},
    );
    return {
        api,
        ipcRenderer,
        listeners,
    };
}

describe('createElectronApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        expectedDecodedEventWarningSpy?.mockRestore();
        expectedDecodedEventWarningSpy = null;
    });

    it('provides a deterministic automation seam that defers direct document open', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        let release!: () => void;
        const waitForDocumentOpenDirect = vi.fn(() => new Promise<void>((resolve) => {
            release = resolve;
        }));
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
            {waitForDocumentOpenDirect},
        );

        const openPromise = api.documentOpen.openDocumentDirect(requireDocumentRef('/tmp/deferred.pdf'));
        await vi.waitFor(() => expect(waitForDocumentOpenDirect).toHaveBeenCalledWith('/tmp/deferred.pdf'));
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();

        release();
        await expect(openPromise).resolves.toEqual({path: '/tmp/deferred.pdf'});
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/deferred.pdf');
    });

    it('exposes page operations and image export on their own capabilities', async () => {
        const {api} = await createApiHarness();
        expect(typeof api.pageOps.rotate).toBe('function');
        expect(typeof api.imageExport.exportPdfToImages).toBe('function');
        expect(typeof api.system.getMemoryInfo).toBe('function');
    });

    it('forwards one renderer close decision and reports when no handler remains', async () => {
        const {
            api,
            ipcRenderer,
            listeners,
        } = await createApiHarness();
        if (!api.system.onWindowCloseRequest) {
            throw new Error('Expected the native window close hook to be available');
        }

        const callback = vi.fn(() => 'discard' as const);
        const unsubscribe = api.system.onWindowCloseRequest(callback);
        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.windowCloseRequest);
        if (!listener) {
            throw new Error('Expected native window close listener to be registered');
        }

        listener({}, {requestId: 'close-1'});
        await vi.waitFor(() => {
            expect(ipcRenderer.send).toHaveBeenCalledWith(
                CORE_IPC_SEND_CHANNELS.windowCloseResponse,
                {
                    decision: 'discard',
                    requestId: 'close-1',
                },
            );
        });
        expect(callback).toHaveBeenCalledWith({requestId: 'close-1'});

        unsubscribe();
        ipcRenderer.send.mockClear();
        listener({}, {requestId: 'close-2'});
        await vi.waitFor(() => {
            expect(ipcRenderer.send).toHaveBeenCalledWith(
                CORE_IPC_SEND_CHANNELS.windowCloseResponse,
                {
                    requestId: 'close-2',
                    status: 'unavailable',
                    reason: 'no-handler',
                },
            );
        });
    });

    it('reports a renderer close handler failure without converting it to cancel', async () => {
        const {
            api,
            ipcRenderer,
            listeners,
        } = await createApiHarness();
        if (!api.system.onWindowCloseRequest) {
            throw new Error('Expected the native window close hook to be available');
        }
        api.system.onWindowCloseRequest(() => {
            throw new Error('dialog unavailable');
        });

        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.windowCloseRequest);
        if (!listener) {
            throw new Error('Expected native window close listener to be registered');
        }
        listener({}, {requestId: 'close-error'});

        await vi.waitFor(() => {
            expect(ipcRenderer.send).toHaveBeenCalledWith(
                CORE_IPC_SEND_CHANNELS.windowCloseResponse,
                {
                    requestId: 'close-error',
                    status: 'unavailable',
                    reason: 'handler-error',
                },
            );
        });
    });

    it('forwards token-bound workspace checkpoint discard and resume calls', async () => {
        const {
            api,
            ipcRenderer,
        } = await createApiHarness({invoke: async channel =>
            channel === WINDOW_TABS_PLATFORM_FEATURE.invokeChannels.discardWorkspaceCheckpoint
                ? '7'
                : undefined});

        await expect(api.windowTabs.discardWorkspaceCheckpoint()).resolves.toBe('7');
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            WINDOW_TABS_PLATFORM_FEATURE.invokeChannels.discardWorkspaceCheckpoint,
        );
        await expect(api.windowTabs.resumeWorkspaceCheckpoint('7')).resolves.toBeUndefined();
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            WINDOW_TABS_PLATFORM_FEATURE.invokeChannels.resumeWorkspaceCheckpoint,
            '7',
        );
    });

    it('exposes decoded native DjVu page text and nested outline methods', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DJVU_PLATFORM_FEATURE.invokeChannels.getPageText) {
                    return 'Native page text';
                }
                if (channel === DJVU_PLATFORM_FEATURE.invokeChannels.getOutline) {
                    return [{
                        title: 'Chapter',
                        pageNumber: 1,
                        children: [{
                            title: 'Section',
                            pageNumber: 3,
                            children: [],
                        }],
                    }];
                }
                return undefined;
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const {createElectronApi} = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            {getPathForFile: () => ''},
        );
        const getPageText = api.djvu.getPageText;
        const getOutline = api.djvu.getOutline;
        if (!getPageText || !getOutline) {
            throw new Error('Native DjVu provider methods are missing from the preload');
        }

        await expect(getPageText(requireDocumentRef('/tmp/book.djvu'), 3)).resolves.toBe('Native page text');
        await expect(getOutline(requireDocumentRef('/tmp/book.djvu'))).resolves.toEqual([{
            title: 'Chapter',
            pageNumber: 1,
            children: [{
                title: 'Section',
                pageNumber: 3,
                children: [],
            }],
        }]);
    });

    it('includes reclaimable macOS memory in the available host headroom', async () => {
        const { decodeSystemMemoryInfo } = await import('@electron/preload/createElectronApi');

        expect(decodeSystemMemoryInfo({
            total: 37_748_736,
            free: 143_312,
            fileBacked: 12_784_048,
            purgeable: 358_608,
        })).toEqual({
            availableBytes: 13_604_831_232,
            totalBytes: 38_654_705_664,
            freeBytes: 146_751_488,
        });
    });

    it('falls back when a sandboxed preload cannot read system memory', async () => {
        const runtimeProcess = process as typeof process & {getSystemMemoryInfo?: () => never;};
        const originalDescriptor = Object.getOwnPropertyDescriptor(
            runtimeProcess,
            'getSystemMemoryInfo',
        );
        Object.defineProperty(runtimeProcess, 'getSystemMemoryInfo', {
            configurable: true,
            value: vi.fn(() => {
                throw new Error('Unable to retrieve system memory information');
            }),
        });
        try {
            const {api} = await createApiHarness();

            expect(api.system.getMemoryInfo()).toBeNull();
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(runtimeProcess, 'getSystemMemoryInfo', originalDescriptor);
            } else {
                Reflect.deleteProperty(runtimeProcess, 'getSystemMemoryInfo');
            }
        }
    });

    it('reads one valid host resource profile argument and rejects absent or malformed inputs', async () => {
        const { readHostResourceProfileArgument } = await import(
            '@electron/preload/readHostResourceProfileArgument'
        );
        const resourceProfile = {
            logicalCpus: 8,
            totalRamBytes: 16 * (1024 ** 3),
            safeMode: false,
            gpuStatus: {webgl: 'enabled'},
            detectedTier: 'high',
            performanceMode: 'auto',
            tier: 'high',
        } satisfies IHostResourceProfileSnapshot;
        const encodedProfile = Buffer
            .from(JSON.stringify(resourceProfile), 'utf8')
            .toString('base64url');
        const validArgument = `${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}${encodedProfile}`;

        expect(readHostResourceProfileArgument([
            'electron',
            validArgument,
        ])).toEqual(resourceProfile);
        expect(readHostResourceProfileArgument(['electron'])).toBeNull();
        expect(readHostResourceProfileArgument([
            validArgument,
            validArgument,
        ])).toBeNull();
        expect(readHostResourceProfileArgument([`${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}%%%`])).toBeNull();
        expect(readHostResourceProfileArgument([`${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}${Buffer
            .from(JSON.stringify({
                ...resourceProfile,
                tier: 'low',
            }), 'utf8')
            .toString('base64url')}`])).toBeNull();
    });

    it('decodes diagnostics startup policy arguments fail-closed', async () => {
        const { readDiagnosticsPolicyArgument } = await import('@electron/preload/readDiagnosticsPolicyArgument');
        const validArgument = `${DIAGNOSTICS_POLICY_ARGUMENT_PREFIX}${Buffer
            .from(JSON.stringify({mode: 'granted'}), 'utf8')
            .toString('base64url')}`;

        expect(readDiagnosticsPolicyArgument(['electron'])).toEqual({mode: 'unknown'});
        expect(readDiagnosticsPolicyArgument([
            validArgument,
            validArgument,
        ])).toEqual({mode: 'unknown'});
        expect(readDiagnosticsPolicyArgument([`${DIAGNOSTICS_POLICY_ARGUMENT_PREFIX}%%%`])).toEqual({mode: 'unknown'});
        expect(readDiagnosticsPolicyArgument([validArgument])).toEqual({mode: 'granted'});
        expect(Object.isFrozen(readDiagnosticsPolicyArgument([validArgument]))).toBe(true);
    });

    it('exposes only the closed diagnostics namespace members', async () => {
        const {
            ipcRenderer,
            listeners,
        } = await createApiHarness();
        const policy = Object.freeze({mode: 'granted' as const});
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const diagnosticsApi = createElectronApi(
            ipcRenderer as never,
            {getPathForFile: () => ''},
            {diagnosticsPolicy: policy},
        );
        const callback = vi.fn();

        expect(Object.keys(diagnosticsApi.diagnostics)).toEqual([
            'startupPolicy',
            'sendRecord',
            'onDebugLog',
        ]);
        expect(diagnosticsApi.diagnostics.startupPolicy).toBe(policy);
        expect(Object.isFrozen(diagnosticsApi.diagnostics.startupPolicy)).toBe(true);
        diagnosticsApi.diagnostics.sendRecord({} as never, 7);
        expect(ipcRenderer.send).toHaveBeenCalledWith(CORE_IPC_SEND_CHANNELS.rendererDiagnostic, {}, 7);

        diagnosticsApi.diagnostics.onDebugLog(callback);
        listeners.get(CORE_IPC_EVENT_CHANNELS.debugLog)?.({}, {
            source: 'main',
            message: 'closed',
            timestamp: '2026-09-03T00:00:00.000Z',
            level: 'ERROR',
            failureRef: {
                eventId: 'a'.repeat(32),
                code: 'UNCLASSIFIED_MAIN_ERROR',
                severity: 'error',
            },
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({failureRef: {
            eventId: 'a'.repeat(32),
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        }}));
    });

    it('keeps diagnostics inside electronAPI without a Sentry preload import or global bridge', () => {
        const preloadSource = readFileSync('electron/preload.ts', 'utf8');

        expect(preloadSource).not.toMatch(/from\s+['"]@sentry\//u);
        expect(preloadSource).not.toContain('contextBridge.exposeInMainWorld(\'diagnostics\'');
        expect(preloadSource).toContain('contextBridge.exposeInMainWorld(\'electronAPI\', electronApi)');
    });

    it('returns the preload resource profile synchronously with stable identity', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        const resourceProfile = {
            logicalCpus: 4,
            totalRamBytes: 12 * (1024 ** 3),
            safeMode: true,
            detectedTier: 'low',
            performanceMode: 'medium',
            tier: 'medium',
        } satisfies IHostResourceProfileSnapshot;
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
            {resourceProfile},
        );
        const absentApi = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );

        expect(api.host.getResourceProfile()).toBe(resourceProfile);
        expect(api.host.getResourceProfile()).toBe(resourceProfile);
        expect(absentApi.host.getResourceProfile()).toBeNull();
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('decodes settings debug-log events before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
        const {
            api,
            listeners,
        } = await createApiHarness();
        const callback = vi.fn();
        api.settings.onDebugLog(callback);
        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.debugLog);
        if (!listener) {
            throw new Error('Expected debug-log listener to be registered');
        }

        listener({}, {
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });
        listener({}, {
            source: 'main',
            message: 'bad level',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'TRACE',
        });

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${CORE_IPC_EVENT_CHANNELS.debugLog}`,
            expect.objectContaining({ level: 'TRACE' }),
        );
    });

    it('decodes agent renderer request events before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
        const {
            api,
            listeners,
        } = await createApiHarness();
        const snapshotCallback = vi.fn();
        const commandCallback = vi.fn();

        api.agent.onWorkspaceSnapshotRequest(snapshotCallback);
        api.agent.onCommandRequest(commandCallback);
        const snapshotListener = listeners.get(agentEventChannels.onWorkspaceSnapshotRequest);
        const commandListener = listeners.get(agentEventChannels.onCommandRequest);
        if (!snapshotListener || !commandListener) {
            throw new Error('Expected agent request listeners to be registered');
        }

        snapshotListener({}, {
            requestId: '',
            windowId: 1,
        });
        snapshotListener({}, {
            requestId: ' snapshot-1 ',
            windowId: 12,
            lastSeenRevision: 3,
        });
        commandListener({}, {
            requestId: 'command-bad',
            windowId: 12,
            command: {
                name: 'go_to_page',
                arguments: {page: '2'},
            },
        });
        commandListener({}, {
            requestId: ' command-1 ',
            windowId: 12,
            command: {
                name: 'run_action',
                arguments: {
                    id: 'ui.close_popups',
                    tabId: ' tab-1 ',
                    input: {ok: true},
                    dryRun: true,
                },
            },
        });

        expect(snapshotCallback).toHaveBeenCalledOnce();
        expect(snapshotCallback).toHaveBeenCalledWith({
            requestId: 'snapshot-1',
            windowId: 12,
            lastSeenRevision: 3,
        });
        expect(commandCallback).toHaveBeenCalledOnce();
        expect(commandCallback).toHaveBeenCalledWith({
            requestId: 'command-1',
            windowId: 12,
            command: {
                name: 'run_action',
                arguments: {
                    id: 'ui.close_popups',
                    tabId: 'tab-1',
                    input: {ok: true},
                    dryRun: true,
                },
            },
        });
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${agentEventChannels.onWorkspaceSnapshotRequest}`,
            expect.objectContaining({ requestId: '' }),
        );
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${agentEventChannels.onCommandRequest}`,
            expect.objectContaining({ requestId: 'command-bad' }),
        );
    });

    it('decodes assistant events before invoking callbacks', async () => {
        const binding = {
            scopeFingerprint: 'codex:document-1',
            sessionKey: 'codex:document-1',
            turnGeneration: 1,
            windowId: 1,
        };
        const warningSpy = silenceExpectedDecodedEventWarnings();
        const {
            api,
            listeners,
        } = await createApiHarness();
        const callback = vi.fn();

        api.agent.onAssistantEvent(callback);
        const listener = listeners.get(agentEventChannels.onAssistantEvent);
        if (!listener) {
            throw new Error('Expected assistant event listener to be registered');
        }

        listener({}, {
            type: 'state',
            state: {
                status: {provider: 'codex'},
                messages: [],
            },
        });
        listener({}, {
            type: 'message-delta',
            messageId: ' message-1 ',
            delta: 'hello',
            binding,
        });
        listener({}, {
            type: 'turn-progress',
            progress: 'Still working',
            binding,
        });

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenNthCalledWith(1, {
            type: 'message-delta',
            messageId: 'message-1',
            delta: 'hello',
            binding,
        });
        expect(callback).toHaveBeenNthCalledWith(2, {
            type: 'turn-progress',
            progress: 'Still working',
            binding,
        });
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${agentEventChannels.onAssistantEvent}`,
            expect.objectContaining({ type: 'state' }),
        );
    });

    it('decodes incoming tab transfers before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
        const {
            api,
            ipcRenderer,
            listeners,
        } = await createApiHarness();
        const callback = vi.fn();

        const unsubscribe = api.windowTabs.onIncomingTransfer(callback);
        const listener = listeners.get(WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onIncomingTransfer);
        if (!listener) {
            throw new Error('Expected incoming tab transfer listener to be registered');
        }

        listener({}, {
            transferId: 'transfer-bad',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: { kind: 'unsupported' },
        });
        listener({}, {
            transferId: ' transfer-1 ',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                snapshotPath: '/tmp/doc.snapshot.pdf',
                isDirty: true,
                currentPage: 2,
            },
        });
        unsubscribe();

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            transferId: 'transfer-1',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                snapshotPath: '/tmp/doc.snapshot.pdf',
                isDirty: true,
                currentPage: 2,
            },
        });
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
            WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onIncomingTransfer,
            listener,
        );
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${
                WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onIncomingTransfer
            }`,
            expect.objectContaining({ transferId: 'transfer-bad' }),
        );
    });

    it('decodes update, host, and window-action payloads while preserving unsubscribe handles', async () => {
        silenceExpectedDecodedEventWarnings();
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === UPDATES_PLATFORM_FEATURE.invokeChannels.getState) {
                    return {
                        phase: 'future-phase',
                        origin: 'manual',
                        version: null,
                        percent: null,
                        message: null,
                    };
                }
                if (channel === HOST_PLATFORM_FEATURE.invokeChannels.getEnvironment) {
                    return {
                        platform: 'linux',
                        osScaleFactor: 0,
                    };
                }
                return undefined;
            }),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(ipcRenderer as never, { getPathForFile: () => '' });
        const updateCallback = vi.fn();
        const environmentCallback = vi.fn();
        const actionCallback = vi.fn();
        const unsubscribers = [
            api.updates.onStatus(updateCallback),
            api.host.onEnvironmentChange(environmentCallback),
            api.windowTabs.onWindowAction(actionCallback),
        ];

        listeners.get(UPDATES_PLATFORM_FEATURE.eventChannels.onStatus)?.({}, {
            phase: 'future-phase',
            origin: 'manual',
            version: null,
            percent: null,
            message: null,
        });
        listeners.get(UPDATES_PLATFORM_FEATURE.eventChannels.onStatus)?.({}, {
            phase: 'downloaded',
            origin: 'auto',
            version: '2.0.0',
            percent: 100,
            message: null,
        });
        listeners.get(HOST_PLATFORM_FEATURE.eventChannels.onEnvironmentChange)?.({}, {
            platform: 'freebsd',
            osScaleFactor: 1,
        });
        listeners.get(HOST_PLATFORM_FEATURE.eventChannels.onEnvironmentChange)?.({}, {
            platform: 'darwin',
            osScaleFactor: 2,
        });
        listeners.get(WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onWindowAction)?.({}, {
            kind: 'move-tab-to-window',
            targetWindowId: -1,
        });
        listeners.get(WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onWindowAction)?.({}, {
            kind: 'move-tab-to-window',
            targetWindowId: 3,
            tabId: ' tab-1 ',
        });
        unsubscribers.forEach(unsubscribe => unsubscribe());

        expect(updateCallback).toHaveBeenCalledOnce();
        expect(environmentCallback).toHaveBeenCalledOnce();
        expect(actionCallback).toHaveBeenCalledWith({
            kind: 'move-tab-to-window',
            targetWindowId: 3,
            tabId: 'tab-1',
        });
        expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(3);
        await expect(api.updates.getState()).rejects.toThrow('Invalid IPC response for updates:getState');
        await expect(api.host.getEnvironment()).rejects.toThrow('Invalid IPC response for host:getEnvironment');
    });

    it('awaits renderer file-open authorization before single-file direct open', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        const invocations: string[] = [];
        const allowDeferred: { resolve?: (allowed: boolean) => void } = {};
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                invocations.push(channel);
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen) {
                    return new Promise<boolean>((resolve) => {
                        allowDeferred.resolve = resolve;
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/from-picker.pdf' },
        );

        expect(api.documentPicker.getPathForFile({} as File)).toBe('/tmp/from-picker.pdf');
        const openPromise = api.documentOpen.openDocumentDirect(requireDocumentRef('/tmp/from-picker.pdf'));
        for (let i = 0; i < 5 && !allowDeferred.resolve; i += 1) {
            await Promise.resolve();
        }
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();

        if (!allowDeferred.resolve) {
            throw new Error('Expected renderer file-open authorization to be pending');
        }
        allowDeferred.resolve(true);
        await expect(openPromise).resolves.toEqual({ path: '/tmp/from-picker.pdf' });
        expect(invocations).toContain(DOCUMENTS_CHANNELS.allowRendererFileOpen);
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/from-picker.pdf');
    });

    it('does not direct-open a picked file when renderer file-open authorization is denied', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000002' });
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen) {
                    return Promise.resolve(false);
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/denied-from-picker.pdf' },
        );

        expect(api.documentPicker.getPathForFile({} as File)).toBe('/tmp/denied-from-picker.pdf');

        await expect(api.documentOpen.openDocumentDirect(requireDocumentRef('/tmp/denied-from-picker.pdf'))).resolves.toBeNull();
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();
    });

    it('keeps the newest renderer file-open authorization pending for repeated picks of the same path', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000004');
        vi.stubGlobal('crypto', {randomUUID});
        const allowResolvers = new Map<string, (allowed: boolean) => void>();
        const ipcRenderer = {
            invoke: vi.fn((channel: string, payload?: { token?: string }) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen && payload?.token) {
                    return new Promise<boolean>((resolve) => {
                        allowResolvers.set(payload.token!, resolve);
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/repeated-picker.pdf' },
        );

        expect(api.documentPicker.getPathForFile({} as File)).toBe('/tmp/repeated-picker.pdf');
        expect(api.documentPicker.getPathForFile({} as File)).toBe('/tmp/repeated-picker.pdf');
        await flushMicrotasks();

        const openPromise = api.documentOpen.openDocumentDirect(requireDocumentRef('/tmp/repeated-picker.pdf'));
        allowResolvers.get('00000000-0000-4000-8000-000000000003')?.(true);
        await flushMicrotasks();
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();

        allowResolvers.get('00000000-0000-4000-8000-000000000004')?.(true);
        await expect(openPromise).resolves.toEqual({ path: '/tmp/repeated-picker.pdf' });
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/repeated-picker.pdf');
    });

    it('batches renderer file-open authorization for file arrays', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000005')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000006');
        vi.stubGlobal('crypto', {randomUUID});
        const allowDeferred: { resolve?: (allowed: boolean) => void } = {};
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenTokens) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpenBatch) {
                    return new Promise<boolean>((resolve) => {
                        allowDeferred.resolve = resolve;
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const getPathForFile = vi.fn((file: File) => (file as File & { path: string }).path);
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile },
        );

        const paths = api.documentPicker.getPathsForFiles([
            { path: '/tmp/batch-a.pdf' } as File & { path: string },
            { path: '/tmp/batch-b.pdf' } as File & { path: string },
        ]) ?? [];
        expect(paths).toEqual([
            '/tmp/batch-a.pdf',
            '/tmp/batch-b.pdf',
        ]);

        const openPromise = api.documentOpen.openDocumentDirectBatch(paths, requireRequestId('batch-open-1'));
        await flushMicrotasks();
        expect(documentsClientMock.openDocumentDirectBatch).not.toHaveBeenCalled();

        if (!allowDeferred.resolve) {
            throw new Error('Expected renderer file-open batch authorization to be pending');
        }
        allowDeferred.resolve(true);

        await expect(openPromise).resolves.toEqual(paths);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
            [
                '00000000-0000-4000-8000-000000000005',
                '00000000-0000-4000-8000-000000000006',
            ],
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.allowRendererFileOpenBatch,
            [
                {
                    filePath: '/tmp/batch-a.pdf',
                    token: '00000000-0000-4000-8000-000000000005',
                },
                {
                    filePath: '/tmp/batch-b.pdf',
                    token: '00000000-0000-4000-8000-000000000006',
                },
            ],
        );
        expect(documentsClientMock.openDocumentDirectBatch).toHaveBeenCalledWith(paths, 'batch-open-1');
    });

    it('does not batch direct-open picked files when renderer file-open batch authorization is denied', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000007')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000008');
        vi.stubGlobal('crypto', {randomUUID});
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenTokens) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpenBatch) {
                    return Promise.resolve(false);
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const getPathForFile = vi.fn((file: File) => (file as File & { path: string }).path);
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile },
        );

        const paths = api.documentPicker.getPathsForFiles([
            { path: '/tmp/denied-batch-a.pdf' } as File & { path: string },
            { path: '/tmp/denied-batch-b.pdf' } as File & { path: string },
        ]) ?? [];

        await expect(api.documentOpen.openDocumentDirectBatch(paths, requireRequestId('batch-open-denied'))).resolves.toBeNull();
        expect(documentsClientMock.openDocumentDirectBatch).not.toHaveBeenCalled();
    });
});

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}
