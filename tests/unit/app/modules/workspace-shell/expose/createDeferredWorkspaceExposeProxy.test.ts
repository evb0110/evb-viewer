import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import { createDeferredWorkspaceExposeProxy } from '@app/modules/workspace-shell/expose/createDeferredWorkspaceExposeProxy';
import {cast} from '@tests/helpers/cast';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {WorkspaceExposeCommandUnavailableError} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import type { TSplitPayload } from '@contracts/windowTabs';

interface IEnqueueDocumentOpenCall {
    intent: IDocumentOpenIntent;
    run: (signal: AbortSignal) => Promise<unknown>;
}

type TDeferredWorkspaceExposeTestDeps = Parameters<typeof createDeferredWorkspaceExposeProxy>[0] & {enqueueDocumentOpenCalls: IEnqueueDocumentOpenCall[];};

function createWorkspace(overrides: Partial<IWorkspaceExpose> = {}) {
    return createWorkspaceExposeFixture(overrides);
}

function createDeps(workspace: IWorkspaceExpose | null): TDeferredWorkspaceExposeTestDeps {
    const log = vi.fn();
    const enqueueDocumentOpenCalls: IEnqueueDocumentOpenCall[] = [];
    const enqueueDocumentOpen: TDeferredWorkspaceExposeTestDeps['enqueueDocumentOpen'] = async <T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) => {
        enqueueDocumentOpenCalls.push({
            intent,
            run,
        });
        return run(new AbortController().signal);
    };
    return {
        enqueueDocumentOpen,
        enqueueDocumentOpenCalls,
        getMounted: () => workspace,
        log,
        withLoadedWorkspace: vi.fn(async (_action, run) => (
            workspace ? run(workspace) : null
        )),
        withLoadedWorkspaceRequired: vi.fn(async (_action, run) => {
            if (!workspace) {
                throw new Error('Workspace is not available.');
            }
            return run(workspace);
        }),
        withWorkspace: vi.fn(async (_action, run) => (
            workspace ? await run(workspace) !== false : false
        )),
    };
}

function createOpenResult(path: string): TOpenFileResult {
    return {
        kind: 'pdf',
        originalPath: requireDocumentRef(path),
        workingPath: requireDocumentRef(path),
    };
}

function createSession(path = '/tmp/a.pdf') {
    return createWorkspaceDocumentController({
        tabId: 'tab-1',
        sessionId: 'session-1',
        initialRecord: createWorkspaceDocumentRecord({tab: {
            fileName: path.split('/').pop() ?? null,
            originalPath: requireDocumentRef(path),
            isDirty: false,
            isDjvu: false,
        }}),
        createTransactionId: input => `transaction-${input.nextTransactionIndex}`,
    });
}

function replaceSessionDocument(
    session: ReturnType<typeof createWorkspaceDocumentController>,
    path: string,
) {
    session.applyWorkspaceRecord(createWorkspaceDocumentRecord({tab: {
        fileName: path.split('/').pop() ?? null,
        originalPath: requireDocumentRef(path),
        isDirty: false,
        isDjvu: false,
    }}), 'workspace');
}

describe('createDeferredWorkspaceExposeProxy', () => {
    it('lets the shell toolbar persist latest navigation before deferred workspace mount', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        const deps = createDeps(null);
        deps.overrides = {handleGoToPage: (page) => {
            openSurface.requestNavigation(page);
        }};
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        for (let page = 2; page <= 6; page += 1) {
            proxy.handleGoToPage(page);
        }

        expect(openSurface.viewportSession.value.requestedPage).toBe(6);
        expect(deps.withLoadedWorkspace).not.toHaveBeenCalled();
    });

    it('forwards targeted navigation options through a mounted deferred workspace', () => {
        const handleGoToPage = vi.fn();
        const workspace = createWorkspace({handleGoToPage});
        const proxy = createDeferredWorkspaceExposeProxy(createDeps(workspace));
        const options = {
            navigationSource: 'annotation' as const,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        };

        proxy.handleGoToPage(25, options);

        expect(handleGoToPage).toHaveBeenCalledWith(25, options);
    });

    it('forwards mount-wait methods and returns their result', async () => {
        const workspace = createWorkspace({handleSave: vi.fn(async () => true)});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleSave()).resolves.toBe(true);

        expect(deps.withLoadedWorkspace).toHaveBeenCalledWith('handleSave', expect.any(Function));
        expect(workspace.handleSave).toHaveBeenCalledOnce();
    });

    it('preserves the image placement result through the deferred workspace command', async () => {
        const workspace = createWorkspace({handlePasteImageFromClipboard: cast<IWorkspaceExpose['handlePasteImageFromClipboard']>(vi.fn(async () => true))});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handlePasteImageFromClipboard()).resolves.toBe(true);
        expect(workspace.handlePasteImageFromClipboard).toHaveBeenCalledOnce();
    });

    it('returns safe defaults when mount-wait methods have no workspace', async () => {
        const deps = createDeps(null);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleSave()).resolves.toBe(false);
    });

    it('routes assistant actions through the mount-wait workspace path', async () => {
        const runAgentAction = vi.fn(async () => ({
            ok: true,
            actionId: 'file.save',
        }));
        const workspace = createWorkspace({runAgentAction});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('file.save', {tabId: 'tab-1'})).resolves.toEqual({
            ok: true,
            actionId: 'file.save',
        });

        expect(deps.withLoadedWorkspaceRequired).toHaveBeenCalledWith('runAgentAction', expect.any(Function));
        expect(runAgentAction).toHaveBeenCalledWith('file.save', {tabId: 'tab-1'}, undefined, undefined);
    });

    it('preserves toolbar snapshot and document-open settle defaults', async () => {
        const depsWithoutWorkspace = createDeps(null);
        const proxyWithoutWorkspace = createDeferredWorkspaceExposeProxy(depsWithoutWorkspace);

        expect(proxyWithoutWorkspace.getToolbarSnapshot()).toEqual(createDefaultWorkspaceToolbarSnapshot());
        await expect(proxyWithoutWorkspace.waitForDocumentOpenSettled()).resolves.toBeUndefined();

        const waitForDocumentOpenSettled = vi.fn(async () => {});
        const toolbarSnapshot = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            isDjvuMode: true,
            totalPages: 120,
        };
        const workspace = createWorkspace({
            getToolbarSnapshot: vi.fn(() => toolbarSnapshot),
            waitForDocumentOpenSettled,
        });
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        expect(proxy.getToolbarSnapshot()).toEqual(toolbarSnapshot);
        await proxy.waitForDocumentOpenSettled();

        expect(deps.withLoadedWorkspace).toHaveBeenCalledWith('waitForDocumentOpenSettled', expect.any(Function));
        expect(waitForDocumentOpenSettled).toHaveBeenCalledOnce();
    });

    it('returns an MCP-safe assistant action error when no workspace can mount', async () => {
        const deps = createDeps(null);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('file.save', {tabId: 'tab-1'})).resolves.toEqual({
            ok: false,
            actionId: 'file.save',
            error: 'Workspace is not available.',
        });
    });

    it('returns the real assistant action error when the inner workspace rejects', async () => {
        const workspace = createWorkspace({runAgentAction: vi.fn(async () => {
            throw new Error('Bookmark plan is invalid.');
        })});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('bookmarks.apply_plan', {})).resolves.toEqual({
            ok: false,
            actionId: 'bookmarks.apply_plan',
            error: 'Bookmark plan is invalid.',
        });
    });

    it('queues document-open methods and invokes the inner workspace call', async () => {
        const workspace = createWorkspace({handleOpenFileWithResult: vi.fn(async () => true)});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleOpenFileWithResult(createOpenResult('/tmp/a.pdf'))).resolves.toBe(true);

        expect(deps.enqueueDocumentOpenCalls).toHaveLength(1);
        expect(deps.enqueueDocumentOpenCalls[0]?.intent).toEqual(expect.objectContaining({action: 'handleOpenFileWithResult'}));
        expect(deps.enqueueDocumentOpenCalls[0]?.run).toEqual(expect.any(Function));
        expect(workspace.handleOpenFileWithResult).toHaveBeenCalledOnce();
    });

    it('attaches the current session command target to queued document opens', async () => {
        const workspace = createWorkspace({handleOpenFileWithResult: vi.fn(async () => true)});
        const session = createSession();
        const deps = createDeps(workspace);
        deps.documentSession = session;
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await proxy.handleOpenFileWithResult(createOpenResult('/tmp/b.pdf'));

        expect(deps.enqueueDocumentOpenCalls).toHaveLength(1);
        expect(deps.enqueueDocumentOpenCalls[0]?.intent).toEqual(expect.objectContaining({
            action: 'handleOpenFileWithResult',
            commandTarget: expect.objectContaining({
                kind: 'revision',
                tabId: 'tab-1',
                sessionId: 'session-1',
                documentRef: '/tmp/a.pdf',
            }),
        }));
        expect(deps.enqueueDocumentOpenCalls[0]?.run).toEqual(expect.any(Function));
    });

    it('drops mount-wait commands whose captured target goes stale before workspace invocation', async () => {
        const handleSave = vi.fn(async () => true);
        const workspace = createWorkspace({handleSave});
        const session = createSession();
        const deps = createDeps(workspace);
        deps.documentSession = session;
        deps.withLoadedWorkspace = vi.fn(async (_action, run) => {
            replaceSessionDocument(session, '/tmp/b.pdf');
            return run(workspace);
        });
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleSave()).resolves.toBe(false);

        expect(handleSave).not.toHaveBeenCalled();
        expect(deps.log).toHaveBeenCalledWith('handleSave', expect.any(Error));
    });

    it('returns stale-command-target for assistant commands with stale session context', async () => {
        const runAgentAction = vi.fn(async () => ({ok: true}));
        const workspace = createWorkspace({runAgentAction});
        const session = createSession();
        const commandTarget = session.createCommandTarget();
        replaceSessionDocument(session, '/tmp/b.pdf');
        const deps = createDeps(workspace);
        deps.documentSession = session;
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('file.save', {}, undefined, {
            signal: new AbortController().signal,
            documentIdentity: null,
            documentInstanceId: null,
            commandTarget,
            assertCurrentDocument: vi.fn(),
        })).resolves.toEqual({
            ok: false,
            actionId: 'file.save',
            error: 'stale-command-target',
        });

        expect(runAgentAction).not.toHaveBeenCalled();
    });

    it('logs and returns false for direct method failures', async () => {
        const error = new Error('boom');
        const handleCombineImages = vi.fn(async () => {
            throw error;
        });
        const workspace = createWorkspace({handleCombineImages});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleCombineImages()).resolves.toBe(false);

        expect(deps.log).toHaveBeenCalledWith('handleCombineImages', error);
    });

    it('logs a typed unavailable error for direct commands before mount', async () => {
        const deps = createDeps(null);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleCombineImages()).resolves.toBe(false);

        expect(deps.log).toHaveBeenCalledWith(
            'handleCombineImages',
            expect.any(WorkspaceExposeCommandUnavailableError),
        );
    });

    it('propagates failed and successful split restore outcomes through the deferred proxy', async () => {
        const payload: TSplitPayload = {
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/scan.djvu'),
        };
        const restoreSplitPayload = vi.fn()
            .mockResolvedValueOnce({
                status: 'failed' as const,
                error: 'restore failed',
            })
            .mockResolvedValueOnce({
                status: 'opened' as const,
                result: {
                    kind: 'djvu' as const,
                    workingPath: '' as const,
                    originalPath: payload.sourcePath,
                },
            });
        const proxy = createDeferredWorkspaceExposeProxy(createDeps(createWorkspace({restoreSplitPayload})));

        await expect(proxy.restoreSplitPayload(payload)).resolves.toEqual({
            status: 'failed',
            error: 'restore failed',
        });
        await expect(proxy.restoreSplitPayload(payload)).resolves.toMatchObject({status: 'opened'});
    });
});
