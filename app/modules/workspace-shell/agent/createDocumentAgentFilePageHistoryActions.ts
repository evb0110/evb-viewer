import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { ICropMargins } from '@app/types/crop';
import { normalizeCropMargins } from '@contracts/shared';
import type { IWorkspaceAgentCommandContext } from '@app/types/workspaceExpose';
import {getAgentNumberArrayInput} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    defineAgentActionHandler,
    type IAgentActionHandlerDefinition,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentActionRegistry';
import { normalizeAgentPageNumber } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';

interface ICreateDocumentAgentFilePageHistoryActionsOptions {
    canSave: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    totalPages: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    handleRepairSave: () => Promise<boolean>;
    handleOptimizePdfForInteraction: () => Promise<boolean>;
    handleCropPages: (pages: number[], margins: ICropMargins) => Promise<boolean>;
    handleRemoveCrop: (pages: number[]) => Promise<boolean>;
    handleUndo: () => Promise<unknown> | unknown;
    handleRedo: () => Promise<unknown> | unknown;
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
                const repairSucceeded = await options.handleRepairSave();
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
                const optimizeSucceeded = await options.handleOptimizePdfForInteraction();
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
                        completed: await options.handleCropPages(cropInput.pages, cropInput.margins),
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
                        completed: await options.handleRemoveCrop(pages),
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
                await options.handleUndo();
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
                await options.handleRedo();
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
