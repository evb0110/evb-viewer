// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePaneId } from '@contracts/editorPanes';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requireEpochMs } from '@contracts/timestamps';
import { requireRequestId } from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';
import {
    createApp,
    ref,
    shallowRef,
} from 'vue';
import type {
    IAgentCommandCancelRequest,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentWorkspaceSnapshotRequest,
} from '@contracts/agent';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IAgentCapability } from '@contracts/agentPlatformFeature';
import type { IElectronAPI } from '@contracts/electronApi';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';
import { useAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

interface IWindowWithElectronApi extends Window {electronAPI?: IElectronAPI;}
type TAgentHarnessCapability = Pick<IAgentCapability,
    | 'onCommandCancelRequest'
    | 'onCommandRequest'
    | 'onWorkspaceSnapshotRequest'
    | 'submitCommandResponse'
    | 'submitWorkspaceSnapshot'
>;

const initialElectronApi = (window as IWindowWithElectronApi).electronAPI;
type TWorkspaceDocumentRecordMap = Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>;

function createWorkspace(
    overrides: Partial<ReturnType<IWorkspaceExpose['getToolbarSnapshot']>>,
    workspaceOverrides: Partial<IWorkspaceExpose> = {},
) {
    return createWorkspaceExposeFixture({
        getToolbarSnapshot: () => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            ...overrides,
        }),
        handleGoToPage: vi.fn(),
        readAgentResource: vi.fn(async () => ({ok: true})),
        runAgentAction: vi.fn(async () => ({ok: true})),
        ...workspaceOverrides,
    });
}

function createDocumentIdentity(
    token = 'revision-1',
    contentRevision = 1,
    documentRef = '/tmp/document.pdf',
): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: requireDocumentRef(documentRef),
        authority: 'browser-document-store',
        contentRevision,
        mintedAt: requireEpochMs(contentRevision),
    };
}

function createSessionRecord(path = '/tmp/document.pdf') {
    return createWorkspaceDocumentRecord({
        tab: {
            fileName: path.split('/').pop() ?? null,
            originalPath: requireDocumentRef(path),
            isDirty: false,
            isDjvu: false,
        },
        documentIdentity: createDocumentIdentity('revision-1', 1, path),
        toolbarSnapshot: {
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        },
    });
}

function createPane(id: string, tabIds: string[], activeTabId: string | null): IEditorPaneState {
    return {
        paneId: requirePaneId(id),
        tabIds: tabIds.map(tabId => requireTabId(tabId)),
        activeTabId: activeTabId === null ? null : requireTabId(activeTabId),
    };
}

function createTab(id: string, fileName: string | null, originalPath: string | null): ITab {
    return {
        id,
        fileName,
        originalPath: originalPath === null ? null : requireDocumentRef(originalPath),
        isDirty: false,
        isDjvu: false,
    };
}

function createTestSession(path = '/tmp/document.pdf') {
    return createWorkspaceDocumentController({
        tabId: 'tab-1',
        sessionId: 'session-1',
        initialRecord: createSessionRecord(path),
    });
}

function createElectronApiFixture(agent: Partial<TAgentHarnessCapability>) {
    return createElectronPlatformApiFixture({agent});
}

async function flushAsyncWork() {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
}

async function waitForCommandResponse(responses: IAgentCommandResponse[]) {
    await waitForAssertion(() => {
        expect(responses[0]).toBeDefined();
    });
    return responses[0]!;
}

async function waitForAssertion(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await Promise.resolve();
        }
    }
    throw lastError;
}

async function mountAgentWorkspaceSnapshotHarness(options: {
    activateTab?: () => void;
    agent?: TAgentHarnessCapability;
    getPaneByTabId?: (tabId: string) => IEditorPaneState | null;
    installElectronApi?: boolean;
    session?: IWorkspaceDocumentController;
    shouldWaitForDesktopBridge?: () => boolean;
    waitForWorkspace?: () => Promise<IWorkspaceExpose | null>;
    workspace?: IWorkspaceExpose;
} = {}) {
    const panes = ref<IEditorPaneState[]>([createPane('pane-1', ['tab-1'], 'tab-1')]);
    const tabs = ref<ITab[]>([createTab('tab-1', 'Document.pdf', '/tmp/document.pdf')]);
    const activePaneId = ref('pane-1');
    const activeTabId = ref('tab-1');
    const workspace = options.workspace ?? createWorkspace({
        hasPdf: true,
        currentPage: 1,
        totalPages: 3,
    });
    const firstIdentity = createDocumentIdentity('revision-1', 1);
    const initialRecord = createWorkspaceDocumentRecord({
        tab: tabs.value[0],
        documentIdentity: firstIdentity,
        toolbarSnapshot: {
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        },
    });
    const documentRecordsByTabId = ref<TWorkspaceDocumentRecordMap>({'tab-1': initialRecord});
    const commandCancelCallbacks: Array<(request: IAgentCommandCancelRequest) => void> = [];
    const commandCallbacks: Array<(request: IAgentCommandRequest) => void> = [];
    const snapshotCallbacks: Array<(request: IAgentWorkspaceSnapshotRequest) => void> = [];
    const commandResponses: IAgentCommandResponse[] = [];
    const agent = options.agent ?? ({
        onWorkspaceSnapshotRequest: vi.fn((callback) => {
            snapshotCallbacks.push(callback);
            return vi.fn();
        }),
        submitWorkspaceSnapshot: vi.fn<IAgentCapability['submitWorkspaceSnapshot']>(async (_response) => ({accepted: true})),
        onCommandRequest: vi.fn((callback) => {
            commandCallbacks.push(callback);
            return vi.fn();
        }),
        onCommandCancelRequest: vi.fn((callback) => {
            commandCancelCallbacks.push(callback);
            return vi.fn();
        }),
        submitCommandResponse: vi.fn(async (response) => {
            commandResponses.push(response);
            return {accepted: true};
        }),
    } satisfies TAgentHarnessCapability);
    if (options.installElectronApi !== false) {
        (window as IWindowWithElectronApi).electronAPI = createElectronApiFixture(agent);
    }

    const app = createApp({ setup() {
        useAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId,
            activeTabId,
            workspaceRefs: ref(new Map([[
                'tab-1',
                workspace,
            ]])),
            documentRecordsByTabId,
            ...(options.session === undefined
                ? {}
                : {documentSessionsByTabId: shallowRef({'tab-1': options.session} satisfies Record<string, IWorkspaceDocumentController>)}),
            shouldWaitForDesktopBridge: options.shouldWaitForDesktopBridge ?? (() => false),
            getPaneByTabId: options.getPaneByTabId
                ?? (tabId => panes.value.find(pane => pane.tabIds.some(candidate => candidate === tabId)) ?? null),
            activateTab: (paneId, tabId) => {
                activePaneId.value = paneId;
                activeTabId.value = tabId;
                options.activateTab?.();
            },
            waitForWorkspace: options.waitForWorkspace ?? (async () => workspace),
        });
        return () => null;
    } });
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    await flushAsyncWork();

    return {
        agent,
        app,
        commandResponses,
        documentRecordsByTabId,
        firstIdentity,
        async submitCommand(request: IAgentCommandRequest) {
            commandCallbacks[0]?.(request);
            return waitForCommandResponse(commandResponses);
        },
        submitCommandCancel(request: IAgentCommandCancelRequest) {
            commandCancelCallbacks[0]?.(request);
        },
        async submitSnapshot(request: IAgentWorkspaceSnapshotRequest) {
            snapshotCallbacks[0]?.(request);
            await flushAsyncWork();
        },
        workspace,
    };
}

afterEach(() => {
    const windowWithElectronApi = window as IWindowWithElectronApi;
    if (initialElectronApi === undefined) {
        delete windowWithElectronApi.electronAPI;
    } else {
        windowWithElectronApi.electronAPI = initialElectronApi;
    }
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('buildAgentWorkspaceSnapshot', () => {
    it('serializes panes, tabs, layout, and document preparation recommendations', () => {
        const panes = ref<IEditorPaneState[]>([
            createPane('pane-left', [
                'tab-pdf',
                'tab-djvu',
            ], 'tab-pdf'),
            createPane('pane-right', ['tab-image'], 'tab-image'),
        ]);
        const tabs = ref<ITab[]>([
            createTab('tab-pdf', 'Grammar.pdf', '/tmp/Grammar.pdf'),
            {
                ...createTab('tab-djvu', 'Reader.djvu', '/tmp/Reader.djvu'),
                isDjvu: true,
            },
            createTab('tab-image', 'scan.png', '/tmp/scan.png'),
        ]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([
            [
                'tab-pdf',
                createWorkspace({
                    hasPdf: true,
                    currentPage: 12,
                    totalPages: 80,
                }),
            ],
            [
                'tab-djvu',
                createWorkspace({
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                }),
            ],
        ]));
        const layout = ref<TEditorLayoutNode | null>({
            type: 'split',
            id: 'split-root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-left'),
            },
            second: {
                type: 'leaf',
                paneId: requirePaneId('pane-right'),
            },
        } as const);
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Previous.pdf',
            originalPath: requireDocumentRef('/tmp/Previous.pdf'),
            timestamp: requireEpochMs(Date.UTC(2026, 4, 31)),
        }]);
        const documentRecordsByTabId = ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({
            'tab-pdf': createWorkspaceDocumentRecord({toolbarSnapshot: {
                hasPdf: true,
                currentPage: 12,
                totalPages: 80,
            }}),
            'tab-djvu': createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Reader.djvu',
                    originalPath: requireDocumentRef('/tmp/Reader.djvu'),
                    isDirty: false,
                    isDjvu: true,
                },
                toolbarSnapshot: {
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                },
            }),
        });
        const pdfSession = createWorkspaceDocumentController({
            tabId: 'tab-pdf',
            sessionId: 'session-pdf',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Grammar.pdf',
                    originalPath: requireDocumentRef('/tmp/Grammar.pdf'),
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentIdentity('revision-1', 1, '/tmp/Grammar.pdf'),
                toolbarSnapshot: {
                    hasPdf: true,
                    currentPage: 12,
                    totalPages: 80,
                },
            }),
            createDocumentSessionKey: () => 'document-session-key-pdf',
        });
        const documentSessionsByTabId = ref<Record<string, IWorkspaceDocumentController>>({'tab-pdf': pdfSession});

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout,
            activePaneId: ref('pane-left'),
            activeTabId: ref('tab-pdf'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            documentRecordsByTabId,
            documentSessionsByTabId,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.some(candidate => candidate === tabId)) ?? null,
        });

        expect(snapshot.activePaneId).toBe('pane-left');
        expect(snapshot.summary).toMatchObject({
            mode: 'open-document',
            documentCount: 3,
            recentFileCount: 1,
            recentFilesResolved: true,
            activeDocument: {
                tabId: 'tab-pdf',
                kind: 'pdf',
                originalPath: '/tmp/Grammar.pdf',
                documentSessionKey: 'document-session-key-pdf',
            },
        });
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Previous.pdf',
            originalPath: '/tmp/Previous.pdf',
            kind: 'pdf',
            openedAt: '2026-05-31T00:00:00.000Z',
        }]);
        expect(snapshot.panes).toEqual([
            {
                paneId: 'pane-left',
                tabIds: [
                    'tab-pdf',
                    'tab-djvu',
                ],
                activeTabId: 'tab-pdf',
            },
            {
                paneId: 'pane-right',
                tabIds: ['tab-image'],
                activeTabId: 'tab-image',
            },
        ]);

        const pdfTab = snapshot.tabs.find(tab => tab.tabId === 'tab-pdf');
        expect(pdfTab?.kind).toBe('pdf');
        expect(pdfTab?.documentSessionKey).toBe('document-session-key-pdf');
        expect(pdfTab?.currentPage).toBe(12);
        expect(pdfTab?.readiness.ocr?.status).toBe('unknown');
        expect(pdfTab?.readiness.recommendations.map(item => item.id)).toEqual([]);

        const djvuTab = snapshot.tabs.find(tab => tab.tabId === 'tab-djvu');
        expect(djvuTab?.kind).toBe('djvu');
        expect(djvuTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);

        const imageTab = snapshot.tabs.find(tab => tab.tabId === 'tab-image');
        expect(imageTab?.kind).toBe('image');
        expect(imageTab?.workspaceAttached).toBe(false);
        expect(imageTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);
    });

    it('distinguishes an empty attached tab from an open document and exposes recent files as metadata', () => {
        const panes = ref<IEditorPaneState[]>([createPane('pane-start', ['tab-empty'], 'tab-empty')]);
        const tabs = ref<ITab[]>([createTab('tab-empty', null, null)]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([[
            'tab-empty',
            createWorkspace({}),
        ]]));
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Recent.djvu',
            originalPath: requireDocumentRef('/tmp/Recent.djvu'),
            timestamp: requireEpochMs(Date.UTC(2026, 5, 1)),
            fileSize: 1234,
        }]);
        const documentRecordsByTabId = ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({'tab-empty': createWorkspaceDocumentRecord()});

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId: ref('pane-start'),
            activeTabId: ref('tab-empty'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            documentRecordsByTabId,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.some(candidate => candidate === tabId)) ?? null,
        });

        expect(snapshot.summary).toEqual({
            mode: 'empty-workspace',
            activeDocument: null,
            documentCount: 0,
            recentFileCount: 1,
            recentFilesResolved: true,
        });
        expect(snapshot.tabs).toEqual([expect.objectContaining({
            tabId: 'tab-empty',
            kind: 'empty',
            workspaceAttached: true,
            readiness: expect.objectContaining({ status: 'empty' }),
        })]);
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Recent.djvu',
            originalPath: '/tmp/Recent.djvu',
            kind: 'djvu',
            openedAt: '2026-06-01T00:00:00.000Z',
            fileSize: 1234,
        }]);
    });
});

describe('useAgentWorkspaceSnapshot bridge registration', () => {
    it('submits a structured-cloneable snapshot response from reactive workspace records', async () => {
        const harness = await mountAgentWorkspaceSnapshotHarness();
        const cloneFailures: unknown[] = [];
        vi.mocked(harness.agent.submitWorkspaceSnapshot).mockImplementationOnce(async (response) => {
            try {
                structuredClone(response);
            } catch (error) {
                cloneFailures.push(error);
            }
            return {accepted: true};
        });

        await harness.submitSnapshot({
            requestId: requireRequestId('structured-cloneable-snapshot'),
            windowId: 42,
        });

        expect(cloneFailures).toEqual([]);
        expect(harness.agent.submitWorkspaceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'structured-cloneable-snapshot',
            windowId: 42,
            ok: true,
            snapshot: expect.objectContaining({activeTabId: 'tab-1'}),
        }));

        harness.app.unmount();
    });

    it('waits for the Electron bridge when Electron preload appears after browser runtime classification', async () => {
        vi.useFakeTimers();
        vi.spyOn(window.navigator, 'userAgent', 'get')
            .mockReturnValue('Mozilla/5.0 AppleWebKit/537.36 Electron/42.3.3 Safari/537.36');
        const harness = await mountAgentWorkspaceSnapshotHarness({
            installElectronApi: false,
            shouldWaitForDesktopBridge: () => false,
        });

        expect(harness.agent.onWorkspaceSnapshotRequest).not.toHaveBeenCalled();
        expect(harness.agent.onCommandRequest).not.toHaveBeenCalled();

        (window as IWindowWithElectronApi).electronAPI = createElectronApiFixture(harness.agent);

        await vi.advanceTimersByTimeAsync(250);
        await waitForAssertion(() => {
            expect(harness.agent.onWorkspaceSnapshotRequest).toHaveBeenCalledTimes(1);
            expect(harness.agent.onCommandRequest).toHaveBeenCalledTimes(1);
        });

        await harness.submitSnapshot({
            requestId: requireRequestId('delayed-electron-bridge-snapshot'),
            windowId: 42,
        });

        expect(harness.agent.submitWorkspaceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'delayed-electron-bridge-snapshot',
            windowId: 42,
            ok: true,
        }));

        harness.app.unmount();
    });

    it('waits for the Electron bridge instead of binding browser no-op agent listeners', async () => {
        vi.useFakeTimers();
        const harness = await mountAgentWorkspaceSnapshotHarness({
            installElectronApi: false,
            shouldWaitForDesktopBridge: () => true,
        });

        expect(harness.agent.onWorkspaceSnapshotRequest).not.toHaveBeenCalled();
        expect(harness.agent.onCommandRequest).not.toHaveBeenCalled();

        (window as IWindowWithElectronApi).electronAPI = createElectronApiFixture(harness.agent);

        await vi.advanceTimersByTimeAsync(250);
        await waitForAssertion(() => {
            expect(harness.agent.onWorkspaceSnapshotRequest).toHaveBeenCalledTimes(1);
            expect(harness.agent.onCommandRequest).toHaveBeenCalledTimes(1);
        });

        harness.app.unmount();
    });

    it('submits an explicit snapshot error response when snapshot creation fails', async () => {
        const explodeWhenResolvingPane = () => {
            throw new Error('snapshot exploded');
        };
        const harness = await mountAgentWorkspaceSnapshotHarness({getPaneByTabId: explodeWhenResolvingPane});

        await harness.submitSnapshot({
            requestId: requireRequestId('snapshot-error'),
            windowId: 42,
        });

        expect(harness.agent.submitWorkspaceSnapshot).toHaveBeenCalledWith({
            requestId: 'snapshot-error',
            windowId: 42,
            ok: false,
            error: 'snapshot exploded',
        });

        harness.app.unmount();
    });
});

describe('useAgentWorkspaceSnapshot command guards', () => {
    it('aborts an in-flight command when main requests cancellation', async () => {
        let observedSignal: AbortSignal | null = null;
        const runAgentActionImpl: IWorkspaceExpose['runAgentAction'] = async (_id, _input, _options, context) =>
            new Promise<Record<string, unknown>>((_resolve, reject) => {
                observedSignal = context?.signal ?? null;
                context?.signal.addEventListener('abort', () => {
                    reject(context.signal.reason ?? new Error('Agent command was aborted.'));
                }, {once: true});
            });
        const runAgentAction = vi.fn(runAgentActionImpl);
        const workspace = createWorkspace({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        }, {runAgentAction});
        const session = createTestSession();
        session.attachWorkspace(workspace);
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            workspace,
        });

        const responsePromise = harness.submitCommand({
            requestId: requireRequestId('command-cancelled'),
            command: {
                name: 'run_action',
                arguments: {
                    id: 'document.save',
                    tabId: requireTabId('tab-1'),
                },
            },
        });
        await waitForAssertion(() => {
            expect(workspace.runAgentAction).toHaveBeenCalledTimes(1);
        });

        harness.submitCommandCancel({requestId: requireRequestId('command-cancelled')});

        await expect(responsePromise).resolves.toMatchObject({
            ok: false,
            error: 'Agent command was aborted.',
        });
        const signal = observedSignal as AbortSignal | null;
        expect(signal).not.toBeNull();
        expect(signal?.aborted).toBe(true);
        harness.app.unmount();
    });

    it('passes session command targets into workspace agent contexts', async () => {
        const readAgentResource = vi.fn(async (_uri, context) => ({
            ok: true,
            commandTargetSessionId: context?.commandTarget?.sessionId,
        }));
        const workspace = createWorkspace({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        }, {readAgentResource});
        const session = createTestSession();
        session.attachWorkspace(workspace);
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            workspace,
        });

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-session-context'),
            command: {
                name: 'read_resource',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    uri: 'evb://document/tab-1/state',
                },
            },
        });

        expect(response).toMatchObject({
            ok: true,
            result: {commandTargetSessionId: 'session-1'},
        });
        expect(readAgentResource).toHaveBeenCalledWith(
            'evb://document/tab-1/state',
            expect.objectContaining({commandTarget: expect.objectContaining({
                kind: 'revision',
                tabId: 'tab-1',
                sessionId: 'session-1',
            })}),
        );
        harness.app.unmount();
    });

    it('rejects a command when the session target changes after activation', async () => {
        const session = createTestSession();
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            activateTab: () => {
                session.applyWorkspaceRecord(createSessionRecord('/tmp/replacement.pdf'), 'workspace');
            },
        });

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-session-activation-change'),
            command: {
                name: 'go_to_page',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    page: 2,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'stale-command-target',
        });
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when a same-revision reopen changes only the document instance', async () => {
        let nextInstanceId = 0;
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createDocumentInstanceId: () => {
                nextInstanceId += 1;
                return requireDocumentInstanceId(`instance-${nextInstanceId}`);
            },
            initialRecord: createSessionRecord('/tmp/document.pdf'),
        });
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            activateTab: () => {
                const reopen = session.beginTransaction({
                    kind: 'open',
                    documentRef: requireDocumentRef('/tmp/document.pdf'),
                });
                session.applyWorkspaceRecord(createSessionRecord('/tmp/document.pdf'), 'workspace');
                session.finishTransaction(reopen.id, 'committed');
            },
        });

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-session-instance-change'),
            command: {
                name: 'go_to_page',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    page: 2,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'stale-command-target',
        });
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when the target document identity changes after activation', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const harness = await mountAgentWorkspaceSnapshotHarness({ activateTab: () => {
            const currentHarness = harnessRef.current;
            if (!currentHarness) {
                throw new Error('Expected mounted harness before activation.');
            }
            currentHarness.documentRecordsByTabId.value['tab-1'] = createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Document.pdf',
                    originalPath: requireDocumentRef('/tmp/document.pdf'),
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentIdentity('revision-2', 2),
                toolbarSnapshot: {
                    hasPdf: true,
                    currentPage: 1,
                    totalPages: 3,
                },
            });
        } });
        harnessRef.current = harness;

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-activate-change'),
            command: {
                name: 'go_to_page',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    page: 2,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'Agent command target document changed.',
        });
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when the target document identity changes after waiting for workspace', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const readAgentResource = vi.fn(async () => ({ok: true}));
        const harness = await mountAgentWorkspaceSnapshotHarness({
            workspace: createWorkspace({
                hasPdf: true,
                currentPage: 1,
                totalPages: 3,
            }, {readAgentResource}),
            waitForWorkspace: async () => {
                const currentHarness = harnessRef.current;
                if (!currentHarness) {
                    throw new Error('Expected mounted harness before workspace wait.');
                }
                currentHarness.documentRecordsByTabId.value['tab-1'] = createWorkspaceDocumentRecord({
                    tab: {
                        fileName: 'Document.pdf',
                        originalPath: requireDocumentRef('/tmp/document.pdf'),
                        isDirty: false,
                        isDjvu: false,
                    },
                    documentIdentity: createDocumentIdentity('revision-2', 2),
                    toolbarSnapshot: {
                        hasPdf: true,
                        currentPage: 1,
                        totalPages: 3,
                    },
                });
                return currentHarness.workspace;
            },
        });
        harnessRef.current = harness;

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-wait-change'),
            command: {
                name: 'read_resource',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    uri: 'evb://document/tab-1/state',
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'Agent command target document changed.',
        });
        expect(readAgentResource).not.toHaveBeenCalled();
        harness.app.unmount();
    });
});
