import { normalizeCropMargins } from '@contracts/shared';
import type { ICropMargins } from '@app/types/crop';
import type { IWorkspaceAgentCommandContext } from '@app/types/workspaceExpose';
import type {IUseDocumentWorkspaceAgentOptions} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import {getAgentNumberArrayInput} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    defineAgentActionHandler,
    type IAgentActionHandlerDefinition,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentActionRegistry';
import { normalizeAgentPageNumber } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';

interface ICreateDocumentAgentFilePageHistoryActionsOptions extends Pick<IUseDocumentWorkspaceAgentOptions,
    | 'canSave' | 'canUndo' | 'canRedo' | 'totalPages' | 'workingCopyPath' | 'originalPath'
    | 'handleRepairSave' | 'handleOptimizePdfForInteraction' | 'handleCropPages'
    | 'handleRemoveCrop' | 'handleUndo' | 'handleRedo'> {
    waitForAgentMutationStateSettled: () => Promise<void>;
    runPdfPageOperationAgentAction: (
        run: () => Promise<{completed: boolean} & object>,
        context?: IWorkspaceAgentCommandContext,
    ) => Promise<object>;
}

function parseAgentPageArrayInput(
    input: Record<string, unknown>,
    actionId: string,
    totalPages: number,
) {
    const pages = getAgentNumberArrayInput(input, 'pages');
    if (!pages || pages.length === 0) {
        throw new Error(`${actionId} requires input.pages with one or more one-based page numbers.`);
    }
    const normalizedPages = pages.map(page => normalizeAgentPageNumber(page, totalPages, actionId));
    return Array.from(new Set(normalizedPages));
}

function parseAgentCropMargins(input: Record<string, unknown>, actionId: string): ICropMargins {
    try {
        return normalizeCropMargins(input.margins);
    } catch {
        throw new Error(`${actionId} requires non-negative numeric crop margins: top, right, bottom, and left.`);
    }
}

function createMaintenanceResult(
    kind: 'repaired' | 'optimized',
    options: ICreateDocumentAgentFilePageHistoryActionsOptions,
) {
    return {
        [kind]: true,
        canSave: options.canSave.value,
        workingCopyPath: options.workingCopyPath.value,
        originalPath: options.originalPath.value,
    };
}

export function createDocumentAgentFilePageHistoryActions(
    options: ICreateDocumentAgentFilePageHistoryActionsOptions,
): ReadonlyArray<IAgentActionHandlerDefinition<unknown>> {
    const parseCropInput = (input: Record<string, unknown>, actionId: string) => ({
        pages: parseAgentPageArrayInput(input, actionId, options.totalPages.value),
        margins: parseAgentCropMargins(input, actionId),
    });
    const parseRemoveCropInput = (input: Record<string, unknown>, actionId: string) =>
        parseAgentPageArrayInput(input, actionId, options.totalPages.value);
    const parseEmptyInput = () => undefined;

    return [
        defineAgentActionHandler({
            ids: ['file.repair_save'],
            policy: {mutatesDocument: true},
            parse: parseEmptyInput,
            async run(_input, _actionId, context) {
                await options.waitForAgentMutationStateSettled();
                context?.assertCurrentDocument();
                const repairSucceeded = await options.handleRepairSave(context?.recordDocumentCommit);
                await options.waitForAgentMutationStateSettled();
                if (!repairSucceeded) {
                    throw new Error('Repair save did not complete.');
                }
                return createMaintenanceResult('repaired', options);
            },
        }),
        defineAgentActionHandler({
            ids: ['file.optimize_for_interaction'],
            policy: {mutatesDocument: true},
            parse: parseEmptyInput,
            async run(_input, _actionId, context) {
                await options.waitForAgentMutationStateSettled();
                context?.assertCurrentDocument();
                const optimizeSucceeded = await options.handleOptimizePdfForInteraction(context?.recordDocumentCommit);
                await options.waitForAgentMutationStateSettled();
                if (!optimizeSucceeded) {
                    throw new Error('PDF optimization did not complete.');
                }
                return createMaintenanceResult('optimized', options);
            },
        }),
        defineAgentActionHandler({
            ids: ['page_ops.crop'],
            policy: {mutatesDocument: true},
            parse: parseCropInput,
            async run(cropInput: ReturnType<typeof parseCropInput>, _actionId, context) {
                return options.runPdfPageOperationAgentAction(async () => {
                    return {
                        completed: await options.handleCropPages(cropInput.pages, cropInput.margins, ...(context?.recordDocumentCommit ? [context.recordDocumentCommit] : [])),
                        pages: cropInput.pages,
                        margins: cropInput.margins,
                        cropped: true,
                    };
                }, context);
            },
        }),
        defineAgentActionHandler({
            ids: ['page_ops.remove_crop'],
            policy: {mutatesDocument: true},
            parse: parseRemoveCropInput,
            async run(pages: number[], _actionId, context) {
                return options.runPdfPageOperationAgentAction(async () => {
                    return {
                        completed: await options.handleRemoveCrop(pages, ...(context?.recordDocumentCommit ? [context.recordDocumentCommit] : [])),
                        pages,
                        cropRemoved: true,
                    };
                }, context);
            },
        }),
        defineAgentActionHandler({
            ids: ['history.undo'],
            policy: {mutatesDocument: true},
            parse: parseEmptyInput,
            async run(_input, _actionId, context) {
                if (!options.canUndo.value) {
                    throw new Error('Undo is not currently available.');
                }
                context?.assertCurrentDocument();
                await options.handleUndo(context?.recordDocumentCommit);
                await options.waitForAgentMutationStateSettled();
                return {
                    canUndo: options.canUndo.value,
                    canRedo: options.canRedo.value,
                    canSave: options.canSave.value,
                };
            },
        }),
        defineAgentActionHandler({
            ids: ['history.redo'],
            policy: {mutatesDocument: true},
            parse: parseEmptyInput,
            async run(_input, _actionId, context) {
                if (!options.canRedo.value) {
                    throw new Error('Redo is not currently available.');
                }
                context?.assertCurrentDocument();
                await options.handleRedo(context?.recordDocumentCommit);
                await options.waitForAgentMutationStateSettled();
                return {
                    canUndo: options.canUndo.value,
                    canRedo: options.canRedo.value,
                    canSave: options.canSave.value,
                };
            },
        }),
    ];
}
