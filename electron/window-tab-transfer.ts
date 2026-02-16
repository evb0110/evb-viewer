import { randomUUID } from 'crypto';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
} from '@app/types/window-tab-transfer';
import {
    createAppWindow,
    getWindowById,
} from '@electron/window';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('window-tab-transfer');
const INCOMING_TRANSFER_CHANNEL = 'tabs:incomingTransfer';
const DEFAULT_TRANSFER_TIMEOUT_MS = 12_000;

interface ITransferTargetWindow {
    id: number;
    isDestroyed: () => boolean;
    webContents: {send: (channel: string, ...args: unknown[]) => void;};
}

interface IWindowTabTransferBrokerDeps {
    createTargetWindow: () => Promise<ITransferTargetWindow>;
    getWindowById: (windowId: number) => ITransferTargetWindow | null;
    setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

interface IPendingTransfer {
    transferId: string;
    targetWindowId: number;
    resolve: (result: IWindowTabTransferResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
    payload: IWindowTabIncomingTransfer;
}

function normalizeTimeout(timeoutMs: number | undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return DEFAULT_TRANSFER_TIMEOUT_MS;
    }
    return Math.max(1, Math.floor(timeoutMs));
}

export class WindowTabTransferBroker {
    private readonly pendingTransfers = new Map<string, IPendingTransfer>();

    private readonly queuedTransfersByWindow = new Map<number, string[]>();

    private readonly readyWindowIds = new Set<number>();

    constructor(private readonly deps: IWindowTabTransferBrokerDeps) {}

    async requestTransfer(sourceWindowId: number, request: IWindowTabTransferRequest): Promise<IWindowTabTransferResult> {
        const targetWindow = await this.resolveTargetWindow(request);
        const targetWindowId = targetWindow?.id ?? (request.target.kind === 'window' ? request.target.windowId : -1);

        if (!targetWindow || targetWindow.isDestroyed()) {
            return {
                transferId: '',
                success: false,
                targetWindowId,
                error: 'Target window is not available.',
            };
        }

        const transferId = randomUUID();
        const payload: IWindowTabIncomingTransfer = {
            transferId,
            sourceWindowId,
            targetWindowId: targetWindow.id,
            tab: request.tab,
            payload: request.payload,
        };

        return new Promise<IWindowTabTransferResult>((resolve) => {
            const timeoutHandle = this.deps.setTimer(() => {
                this.finishTransfer(transferId, {
                    success: false,
                    error: 'Transfer timed out while waiting for target acknowledgement.',
                });
            }, normalizeTimeout(request.timeoutMs));

            this.pendingTransfers.set(transferId, {
                transferId,
                targetWindowId: targetWindow.id,
                resolve,
                timeoutHandle,
                payload,
            });

            if (this.readyWindowIds.has(targetWindow.id)) {
                this.dispatchTransfer(transferId);
                return;
            }

            const queued = this.queuedTransfersByWindow.get(targetWindow.id) ?? [];
            queued.push(transferId);
            this.queuedTransfersByWindow.set(targetWindow.id, queued);
        });
    }

    acknowledgeTransfer(windowId: number, ack: IWindowTabTransferAck) {
        const pending = this.pendingTransfers.get(ack.transferId);
        if (!pending) {
            return false;
        }

        if (pending.targetWindowId !== windowId) {
            logger.warn(`Ignoring transfer ack from unexpected window ${windowId} for transfer ${ack.transferId}`);
            return false;
        }

        this.finishTransfer(ack.transferId, {
            success: ack.success,
            ...(ack.success ? {} : {error: ack.error ?? 'Target renderer failed to restore transferred tab.'}),
        });
        return true;
    }

    markWindowReady(windowId: number) {
        this.readyWindowIds.add(windowId);

        const queued = this.queuedTransfersByWindow.get(windowId);
        if (!queued || queued.length === 0) {
            return;
        }

        this.queuedTransfersByWindow.delete(windowId);
        for (const transferId of queued) {
            this.dispatchTransfer(transferId);
        }
    }

    markWindowClosed(windowId: number) {
        this.readyWindowIds.delete(windowId);

        const queued = this.queuedTransfersByWindow.get(windowId) ?? [];
        this.queuedTransfersByWindow.delete(windowId);

        for (const transferId of queued) {
            this.finishTransfer(transferId, {
                success: false,
                error: 'Target window closed before transfer delivery.',
            });
        }

        const pendingForWindow = Array.from(this.pendingTransfers.values())
            .filter(transfer => transfer.targetWindowId === windowId)
            .map(transfer => transfer.transferId);

        for (const transferId of pendingForWindow) {
            this.finishTransfer(transferId, {
                success: false,
                error: 'Target window closed before transfer acknowledgement.',
            });
        }
    }

    private async resolveTargetWindow(request: IWindowTabTransferRequest) {
        if (request.target.kind === 'new-window') {
            return this.deps.createTargetWindow();
        }

        return this.deps.getWindowById(request.target.windowId);
    }

    private dispatchTransfer(transferId: string) {
        const pending = this.pendingTransfers.get(transferId);
        if (!pending) {
            return;
        }

        const targetWindow = this.deps.getWindowById(pending.targetWindowId);
        if (!targetWindow || targetWindow.isDestroyed()) {
            this.finishTransfer(transferId, {
                success: false,
                error: 'Target window is not available.',
            });
            return;
        }

        try {
            targetWindow.webContents.send(INCOMING_TRANSFER_CHANNEL, pending.payload);
        } catch (error) {
            this.finishTransfer(transferId, {
                success: false,
                error: `Failed to deliver transfer to target renderer: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    private finishTransfer(
        transferId: string,
        result: {
            success: boolean;
            error?: string;
        },
    ) {
        const pending = this.pendingTransfers.get(transferId);
        if (!pending) {
            return;
        }

        this.pendingTransfers.delete(transferId);
        this.removeQueuedTransferReference(pending.targetWindowId, transferId);
        this.deps.clearTimer(pending.timeoutHandle);

        pending.resolve({
            transferId,
            success: result.success,
            targetWindowId: pending.targetWindowId,
            ...(result.error ? {error: result.error} : {}),
        });
    }

    private removeQueuedTransferReference(windowId: number, transferId: string) {
        const queued = this.queuedTransfersByWindow.get(windowId);
        if (!queued) {
            return;
        }

        const next = queued.filter(candidate => candidate !== transferId);
        if (next.length === 0) {
            this.queuedTransfersByWindow.delete(windowId);
            return;
        }

        this.queuedTransfersByWindow.set(windowId, next);
    }
}

const browserWindowTransferBroker = new WindowTabTransferBroker({
    createTargetWindow: async () => createAppWindow(),
    getWindowById: windowId => getWindowById(windowId),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle),
});

export function requestWindowTabTransfer(sourceWindowId: number, request: IWindowTabTransferRequest) {
    return browserWindowTransferBroker.requestTransfer(sourceWindowId, request);
}

export function acknowledgeWindowTabTransfer(windowId: number, ack: IWindowTabTransferAck) {
    return browserWindowTransferBroker.acknowledgeTransfer(windowId, ack);
}

export function markWindowTabTransferReady(windowId: number) {
    browserWindowTransferBroker.markWindowReady(windowId);
}

export function markWindowTabTransferWindowClosed(windowId: number) {
    browserWindowTransferBroker.markWindowClosed(windowId);
}
