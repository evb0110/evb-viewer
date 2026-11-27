import {getAgentNumberInput} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';

export function requireAgentPdfPageCount(totalPages: number, actionId: string) {
    if (totalPages <= 0) {
        throw new Error(`${actionId} requires an open PDF document.`);
    }
    return totalPages;
}

export function normalizeAgentPageNumber(value: number | null | undefined, totalPages: number, actionId: string) {
    const pageCount = requireAgentPdfPageCount(totalPages, actionId);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} requires a valid one-based page number.`);
    }
    const page = Math.trunc(value);
    if (page < 1 || page > pageCount) {
        throw new Error(`${actionId} page ${page} is outside the document.`);
    }
    return page;
}

export function getAgentPageNumberInput(input: Record<string, unknown>, totalPages: number, actionId: string) {
    return normalizeAgentPageNumber(getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'), totalPages, actionId);
}

export function getAgentOptionalPageNumberInput(input: Record<string, unknown>, totalPages: number, currentPage: number, actionId: string) {
    return normalizeAgentPageNumber(
        getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage,
        totalPages,
        actionId,
    );
}
