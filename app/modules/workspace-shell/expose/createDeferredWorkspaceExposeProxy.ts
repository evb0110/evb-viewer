import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TSplitPayload } from '@contracts/windowTabs';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceAgentCommandContext,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import {
    createWorkspaceExposeCommandHandlers,
    createWorkspaceExposeCommandRunner,
    createWorkspaceExposeFromCommandHandlers,
    invokeWorkspaceExposeCommand,
    WorkspaceExposeCommandUnavailableError,
    type IWorkspaceExposeCommandDescriptor,
    type TWorkspaceExposeCommandHandlerMap,
    type TWorkspaceExposeCommandRunner,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import { getErrorMessage } from '@app/utils/error';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

interface ICreateDeferredWorkspaceExposeProxyDeps {
    documentSession?: IWorkspaceDocumentController | null | undefined;
    enqueueDocumentOpen: <T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) => Promise<T | false>;
    getMounted: () => IWorkspaceExpose | null;
    log: (action: string, error: unknown) => void;
    openPath?: ((path: TDocumentRef, action: string) => Promise<boolean>) | undefined;
    overrides?: Partial<IWorkspaceExpose> | undefined;
    withLoadedWorkspace: <T>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) => Promise<T | null | undefined>;
    withLoadedWorkspaceRequired: <T>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) => Promise<T>;
    withWorkspace: (
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<boolean | undefined> | boolean | undefined,
        signal?: AbortSignal,
    ) => Promise<boolean>;
}

export function createDeferredWorkspaceExposeProxy(
    deps: ICreateDeferredWorkspaceExposeProxyDeps,
): IWorkspaceExpose {
    function createCommandTarget() {
        return deps.documentSession?.createCommandTarget() ?? null;
    }

    function validateCommandTarget(
        action: TWorkspaceExposeMethod,
        target: TWorkspaceCommandTarget | null,
    ) {
        if (!target) {
            return true;
        }

        const validation = deps.documentSession?.validateCommandTarget(target) ?? {
            ok: false,
            reason: 'session-missing',
        };
        if (validation.ok) {
            return true;
        }

        deps.log(action, new Error(`Stale workspace command target: ${validation.reason}`));
        return false;
    }

    async function withTargetedLoadedWorkspace<T>(
        action: TWorkspaceExposeMethod,
        target: TWorkspaceCommandTarget | null,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
        staleResult: T,
    ) {
        if (!validateCommandTarget(action, target)) {
            return staleResult;
        }

        const result = await deps.withLoadedWorkspace(action, (workspace) => {
            if (!validateCommandTarget(action, target)) {
                return staleResult;
            }

            return run(workspace);
        });
        return result ?? staleResult;
    }

    function mountWaitBoolean(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<boolean> | boolean,
    ) {
        return async (...args: unknown[]) => {
            const target = createCommandTarget();
            return await withTargetedLoadedWorkspace(
                action,
                target,
                workspace => run(workspace, args),
                false,
            ) === true;
        };
    }

    function mountWaitVoid(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<void> | void,
    ) {
        return async (...args: unknown[]) => {
            const target = createCommandTarget();
            await withTargetedLoadedWorkspace(
                action,
                target,
                workspace => run(workspace, args),
                undefined,
            );
        };
    }

    function mountWaitSyncVoid(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => void,
    ) {
        return (...args: unknown[]) => {
            const target = createCommandTarget();
            void withTargetedLoadedWorkspace(
                action,
                target,
                (workspace) => {
                    run(workspace, args);
                },
                undefined,
            );
        };
    }

    async function directBoolean(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<boolean> | boolean,
        args: readonly unknown[] = [],
    ) {
        const target = createCommandTarget();
        if (!validateCommandTarget(action, target)) {
            return false;
        }
        const workspace = deps.getMounted();
        if (!workspace) {
            deps.log(action, new WorkspaceExposeCommandUnavailableError(action));
            return false;
        }
        try {
            if (!validateCommandTarget(action, target)) {
                return false;
            }
            return await run(workspace, args);
        } catch (error) {
            deps.log(action, error);
            return false;
        }
    }

    async function openQueued<T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) {
        const commandTarget = createCommandTarget();
        return deps.enqueueDocumentOpen({
            ...intent,
            ...(commandTarget ? {commandTarget} : {}),
        }, run);
    }

    function createAgentCommandContext(
        context: IWorkspaceAgentCommandContext | undefined,
        target: TWorkspaceCommandTarget | null,
    ): IWorkspaceAgentCommandContext | undefined {
        if (!context) {
            return undefined;
        }

        return {
            ...context,
            ...(target ? {commandTarget: target} : {}),
        };
    }

    function createDeferredStrategyHandler(
        descriptor: IWorkspaceExposeCommandDescriptor,
    ): TWorkspaceExposeCommandRunner | null {
        const { name } = descriptor;
        if (descriptor.deferred === 'mountWaitBoolean') {
            return mountWaitBoolean(name, async (workspace, args) => (
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, args)) === true
            ));
        }

        if (descriptor.deferred === 'mountWaitVoid') {
            return mountWaitVoid(name, async (workspace, args) => {
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, args));
            });
        }

        if (descriptor.deferred === 'mountWaitSyncVoid') {
            return mountWaitSyncVoid(name, (workspace, args) => {
                void invokeWorkspaceExposeCommand(workspace, name, args);
            });
        }

        if (descriptor.deferred === 'directBoolean') {
            return async (...args: unknown[]) => directBoolean(name, async (workspace, commandArgs) => (
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, commandArgs)) === true
            ), args);
        }

        return null;
    }

    const customHandlers: Partial<TWorkspaceExposeCommandHandlerMap> = {
        captureCanonicalAnnotationRecovery: () => {
            const workspace = deps.getMounted();
            return workspace
                ? invokeWorkspaceExposeCommand(workspace, 'captureCanonicalAnnotationRecovery')
                : null;
        },
        restoreCanonicalAnnotationRecovery: (value: unknown) => {
            const workspace = deps.getMounted();
            if (!workspace) {
                throw new WorkspaceExposeCommandUnavailableError('restoreCanonicalAnnotationRecovery');
            }
            return invokeWorkspaceExposeCommand(workspace, 'restoreCanonicalAnnotationRecovery', [value]);
        },
        createRecoverySnapshotBytes: async () => {
            const target = createCommandTarget();
            return withTargetedLoadedWorkspace(
                'createRecoverySnapshotBytes',
                target,
                workspace => invokeWorkspaceExposeCommand(workspace, 'createRecoverySnapshotBytes'),
                null,
            );
        },
        handleOpenFileFromUi: () => Promise.resolve(false),
        handleOpenFileDirectWithPersist: async (path: TDocumentRef) => openQueued({
            action: 'handleOpenFileDirectWithPersist',
            target: buildPendingTabDocumentHint(path),
        }, async (signal) => {
            if (deps.openPath) {
                if (signal.aborted) {
                    return false;
                }
                return deps.openPath(path, 'handleOpenFileDirectWithPersist');
            }

            return deps.withWorkspace(
                'handleOpenFileDirectWithPersist',
                workspace => workspace.handleOpenFileDirectWithPersist(path),
                signal,
            );
        }),
        handleOpenFileDirectBatchWithPersist: async (paths: TDocumentRef[]) => openQueued({
            action: 'handleOpenFileDirectBatchWithPersist',
            target: null,
        }, async signal => deps.withWorkspace(
            'handleOpenFileDirectBatchWithPersist',
            workspace => workspace.handleOpenFileDirectBatchWithPersist(paths),
            signal,
        )),
        handleOpenFileWithResult: async (result: TOpenFileResult) => {
            const isRecoveryOpen = result.kind === 'pdf' && result.recoveryDirtyBaseline === true;
            const action = isRecoveryOpen
                ? 'restoreCheckpointFileWithResult'
                : 'handleOpenFileWithResult';
            return openQueued({
                action,
                preparedOpeningGeometry: result.kind === 'pdf' ? result.openingGeometry : undefined,
                ...(isRecoveryOpen ? {preserveDirtyOnFailure: true} : {}),
                target: buildPendingTabDocumentHint(result),
            }, async signal => deps.withWorkspace(
                action,
                workspace => workspace.handleOpenFileWithResult(result),
                signal,
            ));
        },
        handleCloseFileFromUi: async (options) => {
            const target = createCommandTarget();
            return await withTargetedLoadedWorkspace(
                'handleCloseFileFromUi',
                target,
                workspace => workspace.handleCloseFileFromUi(options),
                false,
            ) === true;
        },
        captureSplitPayload: () => deps.getMounted()?.captureSplitPayload() ?? Promise.resolve({kind: 'empty'} satisfies TSplitPayload),
        restoreSplitPayload: async (payload: TSplitPayload): Promise<TDocumentOpenOutcome> => {
            if (!deps.getMounted() && payload.kind === 'empty') {
                return {status: 'cancelled'};
            }

            const restorePayload = async (signal?: AbortSignal): Promise<TDocumentOpenOutcome> => {
                if (signal?.aborted) {
                    return {status: 'cancelled'};
                }
                const outcome = await deps.withLoadedWorkspace(
                    'restoreSplitPayload',
                    workspace => workspace.restoreSplitPayload(payload),
                );
                return outcome ?? {status: 'cancelled'};
            };

            if (payload.kind === 'empty') {
                return restorePayload();
            }

            const outcome = await openQueued({
                action: 'restoreSplitPayload',
                target: null,
            }, restorePayload);
            return outcome === false ? {status: 'cancelled'} : outcome;
        },
        runAgentAction: async (actionId, input, options, context) => {
            const target = context?.commandTarget ?? createCommandTarget();
            if (!validateCommandTarget('runAgentAction', target)) {
                return {
                    ok: false,
                    actionId,
                    error: 'stale-command-target',
                };
            }

            try {
                return await deps.withLoadedWorkspaceRequired(
                    'runAgentAction',
                    (workspace) => {
                        if (!validateCommandTarget('runAgentAction', target)) {
                            return {
                                ok: false,
                                actionId,
                                error: 'stale-command-target',
                            };
                        }

                        return workspace.runAgentAction(
                            actionId,
                            input,
                            options,
                            createAgentCommandContext(context, target),
                        );
                    },
                );
            } catch (error) {
                return {
                    ok: false,
                    actionId,
                    error: getErrorMessage(error),
                };
            }
        },
        readAgentResource: async (uri, context) => {
            const target = context?.commandTarget ?? createCommandTarget();
            if (!validateCommandTarget('readAgentResource', target)) {
                return {
                    ok: false,
                    uri,
                    error: 'stale-command-target',
                };
            }

            try {
                return await deps.withLoadedWorkspaceRequired(
                    'readAgentResource',
                    (workspace) => {
                        if (!validateCommandTarget('readAgentResource', target)) {
                            return {
                                ok: false,
                                uri,
                                error: 'stale-command-target',
                            };
                        }

                        return workspace.readAgentResource(uri, createAgentCommandContext(context, target));
                    },
                );
            } catch (error) {
                return {
                    ok: false,
                    uri,
                    error: getErrorMessage(error),
                };
            }
        },
        getAutomationStateSnapshot: () => deps.getMounted()?.getAutomationStateSnapshot() ?? {
            // An unmounted workspace holds no bytes, so it can prove no
            // revision identity. Callers that fence on identity must treat
            // this as a mismatch rather than as an unrestricted document.
            documentIdentity: null,
            annotationComments: [],
            annotationCommentsStatus: 'loading',
            annotationInventory: null,
            annotationDirty: false,
            originalPath: null,
            sortedAnnotationNoteWindows: [],
            workingCopyPath: null,
        },
        handleOcrComplete: async (payload) => {
            const target = createCommandTarget();
            await withTargetedLoadedWorkspace(
                'handleOcrComplete',
                target,
                workspace => invokeWorkspaceExposeCommand(workspace, 'handleOcrComplete', [payload]),
                undefined,
            );
        },
        scrollToPage: (page: number) => {
            const target = createCommandTarget();
            void withTargetedLoadedWorkspace(
                'scrollToPage',
                target,
                workspace => invokeWorkspaceExposeCommand(workspace, 'scrollToPage', [page]),
                undefined,
            );
        },
        getAllShapes: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getAllShapes') : [];
        },
        getDeletedEmbeddedShapeAnnotationIds: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getDeletedEmbeddedShapeAnnotationIds') : [];
        },
        getDeletedEmbeddedShapeStableKeys: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getDeletedEmbeddedShapeStableKeys') : [];
        },
        highlightSelection: async () => {
            const target = createCommandTarget();
            const result = await withTargetedLoadedWorkspace(
                'highlightSelection',
                target,
                workspace => invokeWorkspaceExposeCommand(workspace, 'highlightSelection'),
                false,
            );
            return result === true;
        },
        commentAtPoint: async (pageNumber, pageX, pageY, options) => {
            const target = createCommandTarget();
            const result = await withTargetedLoadedWorkspace(
                'commentAtPoint',
                target,
                workspace => invokeWorkspaceExposeCommand(workspace, 'commentAtPoint', [
                    pageNumber,
                    pageX,
                    pageY,
                    options,
                ]),
                false,
            );
            return result === true;
        },
        getToolbarSnapshot: () => deps.getMounted()?.getToolbarSnapshot() ?? createDefaultWorkspaceToolbarSnapshot(),
    };

    const commandHandlers = createWorkspaceExposeCommandHandlers((descriptor) => {
        if (descriptor.deferred === 'custom') {
            const handler = customHandlers[descriptor.name];
            return handler ? createWorkspaceExposeCommandRunner(handler) : null;
        }

        return createDeferredStrategyHandler(descriptor);
    });

    return createWorkspaceExposeFromCommandHandlers(false, commandHandlers, deps.overrides);
}
