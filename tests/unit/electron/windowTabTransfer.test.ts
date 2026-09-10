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
} from '@contracts/windowTabs';
import {requireDocumentRef} from '@contracts/documentRef';

vi.mock('@electron/window', () => ({
    createAppWindow: vi.fn(),
    getWindowById: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { WindowTabTransferBroker } = await import('@electron/windowTabTransfer');

interface IWindowTabTransferTestWindow {
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
            originalPath: requireDocumentRef('/tmp/demo.pdf'),
            isDirty: true,
            isDjvu: false,
        },
        payload: {kind: 'empty'},
    };
}

function createWindow(windowId: number): IWindowTabTransferTestWindow {
    const window: IWindowTabTransferTestWindow = {
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

async function flushTransferTasks(cycles = 2) {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

describe('WindowTabTransferBroker', () => {
    const windowsById = new Map<number, IWindowTabTransferTestWindow>();
    let nextCreatedWindowId = 100;

    const createTargetWindow = vi.fn(async () => {
        const targetWindow = createWindow(nextCreatedWindowId++);
        windowsById.set(targetWindow.id, targetWindow);
        return targetWindow;
    });

    const getWindowById = vi.fn((windowId: number) => windowsById.get(windowId) ?? null);

    let broker: InstanceType<typeof WindowTabTransferBroker>;

    beforeEach(() => {
        vi.useFakeTimers();
        windowsById.clear();
        nextCreatedWindowId = 100;
        createTargetWindow.mockClear();
        getWindowById.mockClear();
        broker = new WindowTabTransferBroker({
            createTargetWindow,
            getWindowById,
            setTimer: (callback, ms) => setTimeout(callback, ms),
            clearTimer: handle => clearTimeout(handle),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('delivers to an existing ready target and resolves on ack', async () => {
        const targetWindow = createWindow(2);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await flushTransferTasks();

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

    it('keeps a PDF snapshot transfer provisional until the target ACK commits it', async () => {
        const targetWindow = createWindow(22);
        windowsById.set(targetWindow.id, targetWindow);
        const prepare = vi.fn(() => true);
        const commit = vi.fn(() => true);
        const revoke = vi.fn();
        broker = new WindowTabTransferBroker({
            createTargetWindow,
            getWindowById,
            setTimer: (callback, ms) => setTimeout(callback, ms),
            clearTimer: handle => clearTimeout(handle),
            preparePdfSnapshotTransfer: prepare,
            commitPdfSnapshotTransfer: commit,
            revokePdfSnapshotTransfer: revoke,
        });
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(11, {
            ...createTransferRequest(targetWindow.id),
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'demo.pdf',
                originalPath: requireDocumentRef('/tmp/demo.pdf'),
                snapshotPath: requireDocumentRef('/tmp/demo-snapshot.pdf'),
                isDirty: true,
            },
        });
        await flushTransferTasks();
        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };

        expect(prepare).toHaveBeenCalledWith('/tmp/demo-snapshot.pdf', 11, targetWindow.id);
        broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });
        await expect(transferPromise).resolves.toMatchObject({success: true});
        expect(commit).toHaveBeenCalledWith('/tmp/demo-snapshot.pdf', 11, targetWindow.id);
        expect(revoke).not.toHaveBeenCalled();
    });

    it('revokes provisional PDF snapshot access when the target rejects the transfer', async () => {
        const targetWindow = createWindow(23);
        windowsById.set(targetWindow.id, targetWindow);
        const prepare = vi.fn(() => true);
        const revoke = vi.fn();
        broker = new WindowTabTransferBroker({
            createTargetWindow,
            getWindowById,
            setTimer: (callback, ms) => setTimeout(callback, ms),
            clearTimer: handle => clearTimeout(handle),
            preparePdfSnapshotTransfer: prepare,
            revokePdfSnapshotTransfer: revoke,
        });
        broker.markWindowReady(targetWindow.id);
        const transferPromise = broker.requestTransfer(12, {
            ...createTransferRequest(targetWindow.id),
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'demo.pdf',
                originalPath: requireDocumentRef('/tmp/demo.pdf'),
                snapshotPath: requireDocumentRef('/tmp/demo-snapshot.pdf'),
                isDirty: true,
            },
        });
        await flushTransferTasks();
        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };
        broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: false,
        });
        await expect(transferPromise).resolves.toMatchObject({success: false});
        expect(revoke).toHaveBeenCalledWith('/tmp/demo-snapshot.pdf', 12, targetWindow.id);
    });

    it('queues delivery until target window is marked ready', async () => {
        const targetWindow = createWindow(3);
        windowsById.set(targetWindow.id, targetWindow);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(0);

        broker.markWindowReady(targetWindow.id);

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };
        broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });

        const result = await transferPromise;
        expect(result.success).toBe(true);
    });

    it('queues new transfers after a target window is marked not ready', async () => {
        const targetWindow = createWindow(33);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);
        broker.markWindowNotReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, createTransferRequest(targetWindow.id));

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(0);

        broker.markWindowReady(targetWindow.id);
        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        const sentPayload = targetWindow.sentTransfers[0] as { transferId: string };
        broker.acknowledgeTransfer(targetWindow.id, {
            transferId: sentPayload.transferId,
            success: true,
        });

        await expect(transferPromise).resolves.toMatchObject({
            success: true,
            targetWindowId: targetWindow.id,
        });
    });

    it('rejects transfers when one target has too many pending transfers', async () => {
        const targetWindow = createWindow(34);
        windowsById.set(targetWindow.id, targetWindow);
        const pendingTransferPromises: Array<Promise<IWindowTabTransferResult>> = [];

        for (let sourceWindowId = 1; sourceWindowId <= 32; sourceWindowId += 1) {
            pendingTransferPromises.push(broker.requestTransfer(
                sourceWindowId,
                createTransferRequest(targetWindow.id),
            ));
            await Promise.resolve();
        }

        await expect(broker.requestTransfer(99, createTransferRequest(targetWindow.id)))
            .resolves
            .toMatchObject({
                success: false,
                error: 'Too many pending tab transfers.',
            });

        broker.markWindowClosed(targetWindow.id);
        await expect(Promise.all(pendingTransferPromises)).resolves.toHaveLength(32);
    });

    it('returns timeout failure when target does not acknowledge', async () => {
        const targetWindow = createWindow(4);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, {
            ...createTransferRequest(targetWindow.id),
            timeoutMs: 250,
        });

        await flushTransferTasks();
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

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        targetWindow.destroyed = true;
        windowsById.delete(targetWindow.id);
        broker.markWindowClosed(targetWindow.id);

        const result = await transferPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain('closed');
    });

    it('fails delivered transfers when the target window becomes not ready before ack', async () => {
        const targetWindow = createWindow(6);
        windowsById.set(targetWindow.id, targetWindow);
        broker.markWindowReady(targetWindow.id);

        const transferPromise = broker.requestTransfer(1, {
            ...createTransferRequest(targetWindow.id),
            timeoutMs: 12_000,
        });

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(1);

        broker.markWindowNotReady(targetWindow.id);

        const result = await transferPromise;
        expect(result).toMatchObject({
            success: false,
            targetWindowId: targetWindow.id,
            error: 'Target window became unavailable before transfer acknowledgement.',
        });
    });

    it('fails queued transfers when the source window closes before target readiness', async () => {
        const targetWindow = createWindow(55);
        windowsById.set(targetWindow.id, targetWindow);

        const transferPromise = broker.requestTransfer(9, createTransferRequest(targetWindow.id));

        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(0);

        broker.markWindowClosed(9);
        const result = await transferPromise;

        expect(result).toMatchObject({
            success: false,
            targetWindowId: targetWindow.id,
            error: 'Source window closed before transfer completion.',
        });

        broker.markWindowReady(targetWindow.id);
        await flushTransferTasks();
        expect(targetWindow.sentTransfers).toHaveLength(0);
    });

    it('creates a new target window and routes transfer there', async () => {
        const transferPromise = broker.requestTransfer(1, {
            target: {kind: 'new-window'},
            tab: {
                fileName: 'new.pdf',
                originalPath: requireDocumentRef('/tmp/new.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            payload: {kind: 'empty'},
        });

        await flushTransferTasks();
        const createdWindow = windowsById.get(100);
        expect(createdWindow).toBeDefined();
        if (!createdWindow) {
            return;
        }

        expect(createdWindow.sentTransfers).toHaveLength(0);

        broker.markWindowReady(createdWindow.id);
        await flushTransferTasks();

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
