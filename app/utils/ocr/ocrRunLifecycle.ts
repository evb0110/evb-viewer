import type { TRequestId } from '@contracts/shared';

export class OcrRunCanceledError extends Error {
    constructor() {
        super('OCR canceled');
        this.name = 'OcrRunCanceledError';
    }
}

export type TOcrRunGuard = () => void;

export interface IOcrRunContext {
    runToken: symbol;
    runGeneration: number;
    ensureRunActive: TOcrRunGuard;
}

export interface IOcrRunLifecycle {
    beginRun: () => IOcrRunContext;
    isRunTokenActive: (runToken: symbol) => boolean;
    isRunActive: (runToken: symbol, runGeneration: number) => boolean;
    markRequestActive: (requestId: TRequestId) => void;
    clearActiveRequest: () => void;
    getActiveRequestId: () => TRequestId | null;
    cancelActiveRun: () => TRequestId | null;
    clearRunIfActive: (runToken: symbol) => boolean;
    beginCancelingRequest: (requestId: TRequestId) => void;
    markCancelOutcome: (requestId: TRequestId, outcome: 'confirmed' | 'unconfirmed') => boolean;
    finishCancelingRequest: (requestId: TRequestId) => boolean;
    getCancelingRequestId: () => TRequestId | null;
    isCancelOutcomeKnown: (requestId: TRequestId) => boolean;
    shouldApplyLateResult: (requestId: TRequestId) => boolean;
    shouldHandleLateCanceledResult: (requestId: TRequestId) => boolean;
}

export function createOcrRunLifecycle(): IOcrRunLifecycle {
    let cancelGeneration = 0;
    let activeRunToken: symbol | null = null;
    let activeRequestId: TRequestId | null = null;
    let cancelingRequestId: TRequestId | null = null;
    let cancelOutcome: 'pending' | 'confirmed' | 'unconfirmed' = 'pending';

    const isRunActive = (runToken: symbol, runGeneration: number) =>
        activeRunToken === runToken && runGeneration === cancelGeneration;

    const createRunGuard = (runToken: symbol, runGeneration: number): TOcrRunGuard => () => {
        if (!isRunActive(runToken, runGeneration)) {
            throw new OcrRunCanceledError();
        }
    };

    return {
        beginRun: () => {
            const runToken = Symbol('ocr-run');
            activeRunToken = runToken;
            const runGeneration = cancelGeneration;
            return {
                runToken,
                runGeneration,
                ensureRunActive: createRunGuard(runToken, runGeneration),
            };
        },
        isRunTokenActive: runToken => activeRunToken === runToken,
        isRunActive,
        markRequestActive: (requestId) => {
            activeRequestId = requestId;
        },
        clearActiveRequest: () => {
            activeRequestId = null;
        },
        getActiveRequestId: () => activeRequestId,
        cancelActiveRun: () => {
            const requestId = activeRequestId;
            cancelGeneration += 1;
            activeRunToken = null;
            return requestId;
        },
        clearRunIfActive: (runToken) => {
            if (activeRunToken !== runToken) {
                return false;
            }
            activeRunToken = null;
            activeRequestId = null;
            return true;
        },
        beginCancelingRequest: (requestId) => {
            cancelingRequestId = requestId;
            activeRequestId = requestId;
            cancelOutcome = 'pending';
        },
        markCancelOutcome: (requestId, outcome) => {
            if (cancelingRequestId !== requestId) {
                return false;
            }
            cancelOutcome = outcome;
            return true;
        },
        finishCancelingRequest: (requestId) => {
            if (cancelingRequestId !== requestId) {
                return false;
            }
            cancelingRequestId = null;
            activeRequestId = null;
            cancelOutcome = 'pending';
            return true;
        },
        getCancelingRequestId: () => cancelingRequestId,
        isCancelOutcomeKnown: requestId => (
            cancelingRequestId === requestId && cancelOutcome !== 'pending'
        ),
        shouldApplyLateResult: requestId => (
            cancelingRequestId === requestId && cancelOutcome === 'unconfirmed'
        ),
        shouldHandleLateCanceledResult: requestId => cancelingRequestId === requestId,
    };
}
