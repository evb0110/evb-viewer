import {usePageOperations} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations';
import {createAgentOptions} from '@tests/unit/app/modules/workspace-shell/agent/createAgentOptions';
import {createDocumentWorkspaceAgent} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
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
import type {
    IWorkspaceExpose, IWorkspaceToolbarSnapshot,  
} from '@app/types/workspaceExpose';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
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

function createPane(id: string, tabIds: string[], activeTabId: string | null): IEditorPaneState {
    return {
        paneId: requirePaneId(id),
        tabIds: tabIds.map(tabId => requireTabId(tabId)),
        activeTabId: activeTabId === null ? null : requireTabId(activeTabId),
    };
}

// A tab controller holding the document a mounted workspace reported.
function createDocumentSession(tabId: string, options: {
    path: string;
    identity?: IDocumentRevisionInfo | null;
    isDjvu?: boolean;
    toolbar?: Partial<IWorkspaceToolbarSnapshot>;
    workspace?: IWorkspaceExpose | null;
}) {
    const session = createWorkspaceDocumentController({tabId});
    session.commitDocument({
        fileName: options.path.split('/').pop() ?? null,
        originalPath: requireDocumentRef(options.path),
        isDjvu: options.isDjvu ?? false,
        revisionInfo: options.identity === undefined
            ? createDocumentIdentity('revision-1', 1, options.path)
            : options.identity,
    });
    session.getView(tabId)?.publishToolbarSnapshot({
        ...createDefaultWorkspaceToolbarSnapshot(),
        hasPdf: true,
        currentPage: 1,
        totalPages: 3,
        ...options.toolbar,
    });
    if (options.workspace) {
        session.attachWorkspace(tabId, options.workspace);
    }
    return session;
}

function recommitIdentity(session: IWorkspaceDocumentController, path: string, identity: IDocumentRevisionInfo) {
    session.commitDocument({
        fileName: path.split('/').pop() ?? null,
        originalPath: requireDocumentRef(path),
        isDjvu: false,
        revisionInfo: identity,
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
    detachedWorkspace?: boolean;
    shouldWaitForDesktopBridge?: () => boolean;
    workspace?: IWorkspaceExpose;
    linkedWorkspace?: IWorkspaceExpose;
} = {}) {
    const panes = ref<IEditorPaneState[]>([createPane('pane-1', ['tab-1'], 'tab-1')]);
    const tabs = ref<ITab[]>([{id: 'tab-1'}]);
    const activePaneId = ref('pane-1');
    const activeTabId = ref('tab-1');
    const workspace = options.workspace ?? createWorkspace({
        hasPdf: true,
        currentPage: 1,
        totalPages: 3,
    });
    const firstIdentity = createDocumentIdentity('revision-1', 1);
    const session = createDocumentSession('tab-1', {
        path: '/tmp/document.pdf',
        identity: firstIdentity,
        workspace: options.detachedWorkspace ? null : workspace,
    });
    const documentSessionsByTabId = shallowRef<Record<string, IWorkspaceDocumentController>>({'tab-1': session});
    if (options.linkedWorkspace) {
        session.addView('tab-2');
        session.attachWorkspace('tab-2', options.linkedWorkspace);
        tabs.value.push({id: 'tab-2'});
        panes.value.push(createPane('pane-2', ['tab-2'], 'tab-2'));
        documentSessionsByTabId.value = {
            'tab-1': session,
            'tab-2': session,
        };
    }
    const commandCancelCallbacks: Array<(request: IAgentCommandCancelRequest) => void> = [];
    const commandCallbacks: Array<(request: IAgentCommandRequest) => void> = [];
    const snapshotCallbacks: Array<(request: IAgentWorkspaceSnapshotRequest) => void> = [];
    const commandResponses: IAgentCommandResponse[] = [];
    const responseWaiters = new Map<string, (response: IAgentCommandResponse) => void>();
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
            responseWaiters.get(response.requestId)?.(response);
            responseWaiters.delete(response.requestId);
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
            documentSessionsByTabId,
            shouldWaitForDesktopBridge: options.shouldWaitForDesktopBridge ?? (() => false),
            getPaneByTabId: options.getPaneByTabId
                ?? (tabId => panes.value.find(pane => pane.tabIds.some(candidate => candidate === tabId)) ?? null),
            activateTab: (paneId, tabId) => {
                activePaneId.value = paneId;
                activeTabId.value = tabId;
                options.activateTab?.();
            },
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
        activePaneId,
        activeTabId,
        commandResponses,
        firstIdentity,
        session,
        async submitCommand(request: IAgentCommandRequest) {
            const result = new Promise<IAgentCommandResponse>(resolve => responseWaiters.set(request.requestId, resolve));
            commandCallbacks[0]?.(request);
            return result;
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
            {id: 'tab-pdf'},
            {id: 'tab-djvu'},
            {id: 'tab-image'},
        ]);
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
        const pdfSession = createDocumentSession('tab-pdf', {
            path: '/tmp/Grammar.pdf',
            toolbar: {
                currentPage: 12,
                totalPages: 80,
            },
            workspace: createWorkspace({}),
        });
        const imageSession = createWorkspaceDocumentController({
            tabId: 'tab-image',
            assignment: {
                fileName: 'scan.png',
                originalPath: requireDocumentRef('/tmp/scan.png'),
                isDirty: false,
                isDjvu: false,
            },
        });
        const documentSessionsByTabId = shallowRef<Record<string, IWorkspaceDocumentController>>({
            'tab-pdf': pdfSession,
            'tab-djvu': createDocumentSession('tab-djvu', {
                path: '/tmp/Reader.djvu',
                identity: null,
                isDjvu: true,
                toolbar: {
                    hasPdf: false,
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                },
                workspace: createWorkspace({}),
            }),
            'tab-image': imageSession,
        });

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout,
            activePaneId: ref('pane-left'),
            activeTabId: ref('tab-pdf'),
            recentFiles,
            recentFilesResolved: ref(true),
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
                documentSessionKey: pdfSession.snapshot.value.identity.documentSessionKey,
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
        expect(pdfTab?.documentSessionKey).toBe(pdfSession.snapshot.value.identity.documentSessionKey);
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
        const tabs = ref<ITab[]>([{id: 'tab-empty'}]);
        const emptySession = createWorkspaceDocumentController({tabId: 'tab-empty'});
        emptySession.attachWorkspace('tab-empty', createWorkspace({}));
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Recent.djvu',
            originalPath: requireDocumentRef('/tmp/Recent.djvu'),
            timestamp: requireEpochMs(Date.UTC(2026, 5, 1)),
            fileSize: 1234,
        }]);

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId: ref('pane-start'),
            activeTabId: ref('tab-empty'),
            recentFiles,
            recentFilesResolved: ref(true),
            documentSessionsByTabId: shallowRef({'tab-empty': emptySession}),
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
        const harness = await mountAgentWorkspaceSnapshotHarness({workspace});

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
        const harness = await mountAgentWorkspaceSnapshotHarness({workspace});

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
            result: {commandTargetSessionId: harness.session.snapshot.value.sessionId},
        });
        expect(readAgentResource).toHaveBeenCalledWith(
            'evb://document/tab-1/state',
            expect.objectContaining({commandTarget: expect.objectContaining({
                kind: 'revision',
                tabId: 'tab-1',
                sessionId: harness.session.snapshot.value.sessionId,
            })}),
        );
        harness.app.unmount();
    });

    it('reports the revision a scoped command committed so its assistant turn can keep it', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const runAgentAction = vi.fn<IWorkspaceExpose['runAgentAction']>(async (_id, _input, _options, context) => {
            recommitIdentity(harnessRef.current!.session, '/tmp/document.pdf', createDocumentIdentity('revision-2', 2));
            context?.recordDocumentCommit?.(requireDocumentRevisionToken('revision-2'));
            context?.assertCurrentDocument({allowRevisionChange: true});
            return {saved: true};
        });
        const harness = await mountAgentWorkspaceSnapshotHarness({workspace: createWorkspace({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        }, {runAgentAction})});
        harnessRef.current = harness;
        const tabId = requireTabId('tab-1');
        const before = harness.session.createCommandTarget(tabId);
        const command = {
            name: 'run_action',
            arguments: {
                id: 'file.save',
                tabId,
            },
        } as const;

        const response = await harness.submitCommand({
            requestId: requireRequestId('command-own-save'),
            command,
            scope: {
                windowId: 1,
                tabId,
                documentRef: before.documentRef,
                documentInstanceId: before.documentInstanceId ?? null,
                documentIdentity: harness.session.snapshot.value.identity.revisionInfo,
                commandTarget: before,
            },
        });

        expect(response).toMatchObject({
            ok: true,
            result: {saved: true},
            successor: {
                commandTarget: harness.session.createCommandTarget(tabId),
                documentIdentity: {token: 'revision-2'},
            },
        });
        expect(response.successor?.commandTarget).not.toEqual(before);
        // It crosses IPC, which clones it.
        expect(() => structuredClone(response.successor)).not.toThrow();
        // A caller without a turn's scope has no turn to hand a successor to.
        harness.commandResponses.length = 0;
        const unscoped = await harness.submitCommand({
            requestId: requireRequestId('command-unscoped-save'),
            command,
        });
        expect(unscoped).toMatchObject({ok: true});
        expect(unscoped).not.toHaveProperty('successor');
        harness.app.unmount();
    });

    it.each([
        {
            recordOwnCommit: false,
            scenario: 'without a save receipt',
        },
        {
            recordOwnCommit: true,
            scenario: 'after its own save receipt is superseded',
        },
    ])('does not adopt a linked-view revision while file.save settles $scenario', async ({recordOwnCommit}) => {
        const entered = Promise.withResolvers<undefined>();
        const finish = Promise.withResolvers<undefined>();
        const sessionRef: {current?: IWorkspaceDocumentController;} = {};
        const runAgentAction: IWorkspaceExpose['runAgentAction'] = async (_id, _input, _options, context) => {
            if (recordOwnCommit) {
                const identity = createDocumentIdentity('revision-2', 2);
                recommitIdentity(sessionRef.current!, '/tmp/document.pdf', identity);
                context?.recordDocumentCommit?.(identity.token);
            }
            entered.resolve(undefined);
            await finish.promise;
            return {saved: true};
        };
        const linkedWorkspace = createWorkspace({hasPdf: true}, {runAgentAction: async () => {
            recommitIdentity(sessionRef.current!, '/tmp/document.pdf', createDocumentIdentity('reader-revision', 3));
            return {saved: true};
        }});
        const harness = await mountAgentWorkspaceSnapshotHarness({
            workspace: createWorkspace({hasPdf: true}, {runAgentAction}),
            linkedWorkspace,
        });
        const session = harness.session;
        sessionRef.current = session;
        const tabId = requireTabId('tab-1');
        const before = session.createCommandTarget(tabId);
        try {
            const responsePromise = harness.submitCommand({
                requestId: requireRequestId(`linked-reader-during-save-${recordOwnCommit}`),
                command: {
                    name: 'run_action',
                    arguments: {
                        id: 'file.save',
                        tabId,
                    },
                },
                scope: {
                    windowId: 1,
                    tabId,
                    commandTarget: before,
                    documentRef: before.documentRef,
                    documentIdentity: harness.firstIdentity,
                    documentInstanceId: before.documentInstanceId ?? null,
                },
            });
            await entered.promise;
            const savedTarget = recordOwnCommit ? session.createCommandTarget(tabId) : null;
            await linkedWorkspace.runAgentAction('file.save', {});
            finish.resolve(undefined);
            const response = await responsePromise;
            expect(response).toMatchObject({
                ok: true,
                result: {saved: true},
            });
            expect(session.snapshot.value.identity.revisionInfo?.token).toBe('reader-revision');
            expect(session.validateCommandTarget(before).ok).toBe(false);
            if (savedTarget) expect(session.validateCommandTarget(savedTarget).ok).toBe(false);
            expect(response.successor).toBeUndefined();
        } finally {
            finish.resolve(undefined);
            harness.app.unmount();
        }
    });

    it('rejects a command when the session target changes after activation', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const harness = await mountAgentWorkspaceSnapshotHarness({activateTab: () => {
            recommitIdentity(harnessRef.current!.session, '/tmp/replacement.pdf', createDocumentIdentity('revision-1', 1, '/tmp/replacement.pdf'));
        }});
        harnessRef.current = harness;

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
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const harness = await mountAgentWorkspaceSnapshotHarness({activateTab: () => {
            // Reopening the same file is a new document instance.
            const session = harnessRef.current!.session;
            void session.runOpen({
                kind: 'open',
                target: {originalPath: requireDocumentRef('/tmp/document.pdf')},
            }, async () => true);
            session.markPresented();
        }});
        harnessRef.current = harness;

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
            recommitIdentity(currentHarness.session, '/tmp/document.pdf', createDocumentIdentity('revision-2', 2));
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

        expect(response).toMatchObject({ok: false});
        expect(String(response.error)).toMatch(/stale-command-target|target document changed/u);
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when the target document identity changes after waiting for workspace', async () => {
        const readAgentResource = vi.fn(async () => ({ok: true}));
        const workspace = createWorkspace({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        }, {readAgentResource});
        // The tab's workspace is not mounted yet; while the command waits
        // for it, the document changes underneath.
        const harness = await mountAgentWorkspaceSnapshotHarness({
            workspace,
            detachedWorkspace: true,
        });

        const pendingResponse = harness.submitCommand({
            requestId: requireRequestId('command-wait-change'),
            command: {
                name: 'read_resource',
                arguments: {
                    tabId: requireTabId('tab-1'),
                    uri: 'evb://document/tab-1/state',
                },
            },
        });
        recommitIdentity(harness.session, '/tmp/document.pdf', createDocumentIdentity('revision-2', 2));
        harness.session.attachWorkspace('tab-1', workspace);
        const response = await pendingResponse;

        expect(response).toMatchObject({ok: false});
        expect(String(response.error)).toMatch(/stale-command-target|target document changed/u);
        expect(readAgentResource).not.toHaveBeenCalled();
        harness.app.unmount();
    });
});

describe('passive agent actions', () => {
    it.each([
        [
            'bookmarks.set_tree',
            {bookmarks: [{
                title: 'Proposed',
                page: 2,
            }]},
            true,
        ],
        [
            'bookmarks.preview_tree',
            {entries: [{
                level: 1,
                title: 'Proposed',
                page: 2,
            }]},
            false,
        ],
        [
            'toc.preview_tree',
            {entries: [{
                level: 1,
                title: 'Proposed',
                page: 2,
            }]},
            false,
        ],
        [
            'page_labels.preview',
            {ranges: [{
                startPage: 1,
                style: 'D',
                prefix: 'Preview-',
                startNumber: 1,
            }]},
            false,
        ],
        [
            'page_numbering.preview',
            {ranges: [{
                startPage: 1,
                style: 'D',
                prefix: 'Preview-',
                startNumber: 1,
            }]},
            false,
        ],
    ] as const)('keeps the selected tab and metadata unchanged for passive %s', async (id, input, dryRun) => {
        const options = createAgentOptions({
            tabId: 'tab-2',
            documentIdentity: ref(createDocumentIdentity()),
        });
        const agent = createDocumentWorkspaceAgent(options);
        const workspace = createWorkspace({hasPdf: true}, {runAgentAction: agent.runAgentAction});
        const h = await mountAgentWorkspaceSnapshotHarness({linkedWorkspace: workspace});
        try {
            const before = JSON.stringify({
                bookmarks: options.bookmarkItems.value,
                labels: options.pageLabelRanges.value,
            });
            const response = await h.submitCommand({
                requestId: requireRequestId('passive-action'),
                command: {
                    name: 'run_action',
                    arguments: {
                        tabId: requireTabId('tab-2'),
                        id,
                        input,
                        dryRun,
                    },
                },
            });
            expect(response.ok, response.error).toBe(true);
            expect(response.result).toMatchObject({
                activeTabId: 'tab-1',
                activePaneId: 'pane-1',
                targetTabId: 'tab-2',
            });
            expect(h.activeTabId.value).toBe('tab-1');
            expect(h.workspace.getToolbarSnapshot()).toMatchObject({
                currentPage: 1,
                totalPages: 3,
            });
            expect(JSON.stringify({
                bookmarks: options.bookmarkItems.value,
                labels: options.pageLabelRanges.value,
            })).toBe(before);
            expect(options.bookmarksDirty.value).toBe(false);
            expect(options.pageLabelsDirty.value).toBe(false);
        } finally {
            h.app.unmount();
        }
    });

    it.each([
        'action',
        'resource',
    ] as const)('reports a cold passive %s without activation or deferred execution', async kind => {
        const workspace = createWorkspace({hasPdf: true});
        const h = await mountAgentWorkspaceSnapshotHarness({linkedWorkspace: workspace});
        h.session.detachWorkspace('tab-2', workspace);
        try {
            const response = await h.submitCommand({
                requestId: requireRequestId('cold-passive'),
                command: kind === 'action'
                    ? {
                        name: 'run_action',
                        arguments: {
                            tabId: requireTabId('tab-2'),
                            id: 'bookmarks.preview_tree',
                            input: {entries: []},
                        },
                    }
                    : {
                        name: 'read_resource',
                        arguments: {
                            tabId: requireTabId('tab-2'),
                            uri: 'evb://tabs/tab-2/bookmarks',
                        },
                    },
            });
            expect(response.ok).toBe(false);
            expect(response.error).toContain('not available without activating it');
            expect(h.activeTabId.value).toBe('tab-1');
            h.session.attachWorkspace('tab-2', workspace);
            await flushAsyncWork();
            expect(h.activeTabId.value).toBe('tab-1');
            expect(h.commandResponses).toEqual([response]);
        } finally {
            h.app.unmount();
        }
    });
});

describe('agent page-edit revision successors', () => {
    it.each([
        false,
        true,
    ])('keeps only its own rotation receipt, superseded=%s', async (superseded) => {
        const holder: {session?: IWorkspaceDocumentController} = {};
        const identity = ref<IDocumentRevisionInfo | null>(createDocumentIdentity());
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useState', () => ref([]));
        const workingCopyPath = ref(requireDocumentRef('/tmp/document.pdf'));
        const revisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const pageOps = usePageOperations({
            workingCopyPath,
            documentRevisionToken: revisionToken,
            ensureHistoryBaselineForMutation: async () => true,
            reloadWorkingCopyIntoHistory: async () => {
                identity.value = createDocumentIdentity('revision-2', 2);
                recommitIdentity(holder.session!, '/tmp/document.pdf', identity.value);
                return true;
            },
            clearOcrCache: () => {},
            resetSearchCache: () => {},
        });
        const agent = createDocumentWorkspaceAgent(createAgentOptions({
            documentIdentity: identity,
            selectedThumbnailPages: ref([1]),
            handlePageRotate: async (pages, angle, receipt) => {
                const result = await pageOps.rotatePages(pages, 3, angle, receipt);
                if (superseded) {
                    identity.value = createDocumentIdentity('reader-revision', 3);
                    recommitIdentity(holder.session!, '/tmp/document.pdf', identity.value);
                }
                return result;
            },
        }));
        const harness = await mountAgentWorkspaceSnapshotHarness({workspace: createWorkspace({hasPdf: true}, {runAgentAction: agent.runAgentAction})});
        holder.session = harness.session;
        const electronApi = (window as IWindowWithElectronApi).electronAPI!;
        vi.spyOn(electronApi.pageOps, 'rotate').mockResolvedValue({
            success: true,
            documentRevision: createDocumentIdentity('revision-2', 2),
        });
        const tabId = requireTabId('tab-1');
        const target = harness.session.createCommandTarget(tabId);
        const scope = {
            windowId: 1,
            tabId,
            commandTarget: target,
            documentRef: target.documentRef,
            documentIdentity: harness.firstIdentity,
            documentInstanceId: target.documentInstanceId ?? null,
        };
        try {
            const response = await harness.submitCommand({
                requestId: requireRequestId('review-rotate'),
                command: {
                    name: 'run_action',
                    arguments: {
                        id: 'page_ops.rotate_cw_selected',
                        tabId,
                    },
                },
                scope,
            });
            harness.commandResponses.length = 0;
            const nextScope = response.successor ? {
                ...scope,
                ...response.successor,
            } : scope;
            const next = await harness.submitCommand({
                requestId: requireRequestId('review-next-command'),
                command: {
                    name: 'read_resource',
                    arguments: {
                        uri: 'evb://document/tab-1/state',
                        tabId,
                    },
                },
                scope: nextScope,
            });
            expect(response.ok).toBe(true);
            if (superseded) {
                expect(response.successor).toBeUndefined();
                expect(next).toMatchObject({
                    ok: false,
                    error: 'stale-command-target',
                });
            } else {
                expect(response.successor?.documentIdentity?.token).toBe('revision-2');
                expect(next.ok).toBe(true);
            }
        } finally { harness.app.unmount(); vi.unstubAllGlobals(); }
    });
});
