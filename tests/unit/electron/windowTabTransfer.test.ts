import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
} from '@app/types/window-tab-transfer';

vi.mock('@electron/window', () => ({
    createAppWindow: vi.fn(),
    getWindowById: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { WindowTabTransferBroker } = await import('@electron/window-tab-transfer');

interface ITestWindow {
    id: number;
    destroyed: boolean;
    sentTransfers: unknown[];
    isDestroyed: () => boolean;
    webContents: {send: (channel: string, payload: unknown) => void;};
}

function createTransferRequest(targetWindowId: number): IWindowTabTransferRequest {
    return {
        target: {
            kind: 'window',
            windowId: targetWindowId,
        },
        tab: {
            fileName: 'demo.pdf',
            originalPath: '/tmp/demo.pdf',
            isDirty: true,
            isDjvu: false,
        },
        payload: {kind: 'empty'},
    };
}

function createWindow(windowId: number): ITestWindow {
    const window: ITestWindow = {
        id: windowId,
        destroyed: false,
        sentTransfers: [],
        isDestroyed: () => window.destroyed,
        webContents: {send: (_channel, payload) => {
            window.sentTransfers.push(payload);
        }},
    };

    return window;
}

describe('WindowTabTransferBroker', () => {
    const windowsById = new Map<number, ITestWindow>();
    let nextCreatedWindowId = 100;

    const createTargetWindow = vi.fn(async () => {
        const targetWindow = createWindow(nextCreatedWindowId++);
        windowsById.set(targetWindow.id, targetWindow);
        return targetWindow;
    });

    const getWindowById = vi.fn((windowId: number) => windowsById.get(windowId) ?? null);

    const broker = new WindowTabTransferBroker({
        createTargetWindow,
        getWindowById,
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: handle => clearTimeout(handle),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        windowsById.clear();
        nextCreatedWindowId = 100;
        createTargetWindow.mockClear();
        getWindowById.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('delivers to an existing ready target and resolves on ack', async () => {
        const targetWindow = createWindow(2);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await Promise.resolve();

        expect(targetWindow.sentTransfers).toHaveLength(1);
        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };
        const acknowledged = broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });

        expect(acknowledged).toBe(true);

        const result = await transferPromise;
        expect(result).toMatchObject({
            transferId: sentPayload.transferId,
            success: true,
            targetWindowId: targetWindow.id,
        } satisfies Partial<IWindowTabTransferResult>);
    });

    it('queues delivery until target window is marked ready', async () => {
        const targetWindow = createWindow(3);
        windowsById.set(targetWindow.id, targetWindow);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await Promise.resolve();
        expect(targetWindow.sentTransfers).toHaveLength(0);

        broker.markWindowReady(targetWindow.id);

        await Promise.resolve();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };
        broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });

        const result = await transferPromise;
        expect(result.success).toBe(true);
    });

    it('returns timeout failure when target does not acknowledge', async () => {
        const targetWindow = createWindow(4);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, {
            ...createTransferRequest(targetWindow.id),
            timeoutMs: 250,
        });

        await Promise.resolve();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(251);

        const result = await transferPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out');
    });

    it('fails transfer if target window closes before ack', async () => {
        const targetWindow = createWindow(5);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await Promise.resolve();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        targetWindow.destroyed = true;
        windowsById.delete(targetWindow.id);
        broker.markWindowClosed(targetWindow.id);

        const result = await transferPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain('closed');
    });

    it('creates a new target window and routes transfer there', async () => {
        const transferPromise = broker.requestTransfer(1, {
            target: {kind: 'new-window'},
            tab: {
                fileName: 'new.pdf',
                originalPath: '/tmp/new.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {kind: 'empty'},
        });

        await Promise.resolve();
        await Promise.resolve();
        const createdWindow = windowsById.get(100);
        expect(createdWindow).toBeDefined();
        if (!createdWindow) {
            return;
        }

        expect(createdWindow.sentTransfers).toHaveLength(0);

        broker.markWindowReady(createdWindow.id);
        await Promise.resolve();
        await Promise.resolve();

        expect(createdWindow.sentTransfers).toHaveLength(1);
        const sentPayload = createdWindow.sentTransfers[0] as { transferId: string };

        broker.acknowledgeTransfer(createdWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });

        const result = await transferPromise;
        expect(result.success).toBe(true);
        expect(result.targetWindowId).toBe(createdWindow.id);
    });
});
