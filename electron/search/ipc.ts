import type { IpcMainInvokeEvent } from 'electron';
import {
    app,
    ipcMain,
    webContents,
} from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { createLogger } from '@electron/utils/logger';

interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface ISearchMatch {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: ISearchExcerpt;
}

interface ISearchRequest {
    pdfPath: string;
    query: string;
    requestId?: string;
    pageCount?: number;
}

interface ISearchResponse {
    results: ISearchMatch[];
    truncated: boolean;
}

interface ISearchWorkerRequest {
    requestId: string;
    pdfPath: string;
    query: string;
    pageCount?: number;
}

type TSearchWorkerInboundMessage =
    | {
        type: 'search';
        payload: ISearchWorkerRequest;
    }
    | {
        type: 'cancel';
        requestId: string;
    }
    | {type: 'reset-cache';};

type TSearchWorkerOutboundMessage =
    | {
        type: 'progress';
        requestId: string;
        processed: number;
        total: number;
    }
    | {
        type: 'complete';
        requestId: string;
        response: ISearchResponse;
    }
    | {
        type: 'cancelled';
        requestId: string;
    }
    | {
        type: 'error';
        requestId: string;
        error: string;
    };

interface IPendingSearchRequest {
    resolve: (response: ISearchResponse) => void;
    reject: (error: Error) => void;
}

interface ISenderSearchState {
    worker: Worker;
    activeRequestId: string | null;
    pendingByRequestId: Map<string, IPendingSearchRequest>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('search-ipc');
const senderSearchStates = new Map<number, ISenderSearchState>();
const registeredSenderCleanup = new Set<number>();

function getWorkerPath(): string {
    const defaultPath = join(__dirname, 'search-worker.js');
    if (!app?.isPackaged) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function sendSearchProgress(
    senderId: number,
    progress: {
        requestId: string;
        processed: number;
        total: number;
    },
) {
    const sender = webContents.fromId(senderId);
    if (!sender || sender.isDestroyed()) {
        return;
    }

    try {
        sender.send('pdf:search:progress', progress);
    } catch (err) {
        log.debug(`Failed to send search progress: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function resolvePendingRequest(
    state: ISenderSearchState,
    requestId: string,
    response: ISearchResponse,
) {
    const pending = state.pendingByRequestId.get(requestId);
    if (!pending) {
        return;
    }

    state.pendingByRequestId.delete(requestId);
    pending.resolve(response);
}

function rejectPendingRequest(
    state: ISenderSearchState,
    requestId: string,
    error: Error,
) {
    const pending = state.pendingByRequestId.get(requestId);
    if (!pending) {
        return;
    }

    state.pendingByRequestId.delete(requestId);
    pending.reject(error);
}

function cleanupSenderState(
    senderId: number,
    options?: {
        terminateWorker?: boolean;
        reason?: string;
    },
) {
    const state = senderSearchStates.get(senderId);
    if (!state) {
        return;
    }

    senderSearchStates.delete(senderId);

    const reason = options?.reason ?? 'Search worker stopped';
    for (const pending of state.pendingByRequestId.values()) {
        pending.reject(new Error(reason));
    }
    state.pendingByRequestId.clear();
    state.activeRequestId = null;

    if (options?.terminateWorker !== false) {
        void state.worker.terminate().catch(() => {
            // Ignore worker cleanup errors
        });
    }
}

function cancelRequest(state: ISenderSearchState, requestId: string) {
    try {
        state.worker.postMessage({
            type: 'cancel',
            requestId,
        } satisfies TSearchWorkerInboundMessage);
    } catch {
        // Ignore send errors while cancelling
    }

    resolvePendingRequest(state, requestId, {
        results: [],
        truncated: false,
    });

    if (state.activeRequestId === requestId) {
        state.activeRequestId = null;
    }
}

function registerSenderCleanup(event: IpcMainInvokeEvent, senderId: number) {
    if (registeredSenderCleanup.has(senderId)) {
        return;
    }

    registeredSenderCleanup.add(senderId);
    event.sender.once('destroyed', () => {
        cleanupSenderState(senderId, {
            terminateWorker: true,
            reason: 'Renderer closed',
        });
        registeredSenderCleanup.delete(senderId);
    });
}

function handleWorkerMessage(senderId: number, message: TSearchWorkerOutboundMessage) {
    const state = senderSearchStates.get(senderId);
    if (!state) {
        return;
    }

    if (message.type === 'progress') {
        sendSearchProgress(senderId, {
            requestId: message.requestId,
            processed: message.processed,
            total: message.total,
        });
        return;
    }

    if (message.type === 'complete') {
        if (state.activeRequestId === message.requestId) {
            state.activeRequestId = null;
        }
        resolvePendingRequest(state, message.requestId, message.response);
        return;
    }

    if (message.type === 'cancelled') {
        if (state.activeRequestId === message.requestId) {
            state.activeRequestId = null;
        }
        resolvePendingRequest(state, message.requestId, {
            results: [],
            truncated: false,
        });
        return;
    }

    if (state.activeRequestId === message.requestId) {
        state.activeRequestId = null;
    }

    rejectPendingRequest(state, message.requestId, new Error(message.error));
}

function createSenderSearchState(senderId: number): ISenderSearchState {
    const workerPath = getWorkerPath();
    const worker = new Worker(workerPath);
    const state: ISenderSearchState = {
        worker,
        activeRequestId: null,
        pendingByRequestId: new Map(),
    };

    worker.on('message', (message: TSearchWorkerOutboundMessage) => {
        handleWorkerMessage(senderId, message);
    });

    worker.on('error', (error: Error) => {
        log.error(`Search worker error for sender ${senderId}: ${error.message}`);
        cleanupSenderState(senderId, {
            terminateWorker: true,
            reason: `Search worker error: ${error.message}`,
        });
    });

    worker.on('exit', (code) => {
        const reason = code === 0
            ? 'Search worker exited'
            : `Search worker exited unexpectedly with code ${code}`;
        cleanupSenderState(senderId, {
            terminateWorker: false,
            reason,
        });
    });

    return state;
}

function ensureSenderState(event: IpcMainInvokeEvent, senderId: number) {
    registerSenderCleanup(event, senderId);

    let state = senderSearchStates.get(senderId);
    if (state) {
        return state;
    }

    state = createSenderSearchState(senderId);
    senderSearchStates.set(senderId, state);
    return state;
}

async function handlePdfSearch(
    event: IpcMainInvokeEvent,
    request: ISearchRequest,
): Promise<ISearchResponse> {
    const {
        pdfPath,
        query,
        pageCount,
    } = request;

    if (!query || query.trim().length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const senderId = event.sender.id;
    const state = ensureSenderState(event, senderId);
    const requestId = request.requestId?.trim()
        || `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (state.activeRequestId && state.activeRequestId !== requestId) {
        cancelRequest(state, state.activeRequestId);
    }

    state.activeRequestId = requestId;

    return new Promise<ISearchResponse>((resolve, reject) => {
        state.pendingByRequestId.set(requestId, {
            resolve,
            reject,
        });

        try {
            state.worker.postMessage({
                type: 'search',
                payload: {
                    requestId,
                    pdfPath,
                    query,
                    pageCount,
                },
            } satisfies TSearchWorkerInboundMessage);
        } catch (error) {
            state.pendingByRequestId.delete(requestId);
            if (state.activeRequestId === requestId) {
                state.activeRequestId = null;
            }
            reject(new Error(error instanceof Error ? error.message : String(error)));
        }
    });
}

function handlePdfSearchCancel(
    event: IpcMainInvokeEvent,
    requestId?: string,
) {
    const senderId = event.sender.id;
    const state = senderSearchStates.get(senderId);
    if (!state) {
        return { canceled: false };
    }

    const targetRequestId = requestId?.trim() || state.activeRequestId;
    if (!targetRequestId) {
        return { canceled: false };
    }

    cancelRequest(state, targetRequestId);
    return { canceled: true };
}

export function registerSearchHandlers() {
    ipcMain.handle('pdf:search', handlePdfSearch);
    ipcMain.handle('pdf:search:cancel', handlePdfSearchCancel);
    ipcMain.handle('pdf:search:resetCache', () => {
        for (const state of senderSearchStates.values()) {
            try {
                state.worker.postMessage({type: 'reset-cache'} satisfies TSearchWorkerInboundMessage);
            } catch {
                // Ignore cache-reset failures
            }
        }
        return true;
    });
}
