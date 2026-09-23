import { EventEmitter } from 'node:events';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import type { DiagnosticEventId } from '@contracts/diagnostics/diagnosticEventId';
import {requireEpochMs} from '@contracts/timestamps';
import {CORE_IPC_SEND_CHANNELS} from '@electron/platform-ipc/coreContract';
import { registerRendererDiagnosticBridge } from '@electron/platform-ipc/registerRendererDiagnosticBridge';
import { createMainFailureReporter } from '@electron/features/diagnostics/public';

const record: DiagnosticRecord<'UNCLASSIFIED_RENDERER_ERROR'> = {
    schemaVersion: 1,
    eventId: 'a'.repeat(32) as DiagnosticEventId,
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    severity: 'error',
    runtime: 'electron-renderer',
    operation: 'renderer-error',
    occurredAt: requireEpochMs(1_757_000_000_000),
    frames: [{
        module: 'app/utils/failureReporter.ts',
        function: 'capture',
        line: 1,
        column: 1,
    }],
    context: {phase: 'operation'},
};

function createEvent(senderId = 7) {
    const sender = Object.assign(new EventEmitter(), {id: senderId});
    return {
        event: {
            sender,
            senderFrame: null,
        } as never,
        sender,
    };
}

describe('renderer diagnostic bridge', () => {
    it('accepts only trusted closed renderer records and never broadcasts a debug log', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: vi.fn(() => true),
            registerListener: (channel, handler) => {
                expect(channel).toBe(CORE_IPC_SEND_CHANNELS.rendererDiagnostic);
                listener = handler;
            },
        });
        const {event} = createEvent();
        listener?.(event, record);

        expect(captureRecord).toHaveBeenCalledWith(record, 0);
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 1,
            rateDropped: 0,
            schemaDropped: 0,
            untrustedDropped: 0,
        });
    });

    it('accepts a closed browser worker parent record forwarded by an Electron renderer', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: () => true,
            registerListener: (_channel, handler) => { listener = handler; },
        });
        const workerParentRecord: DiagnosticRecord<'UNCLASSIFIED_RENDERER_ERROR'> = {
            ...record,
            runtime: 'browser-worker-parent',
        };

        listener?.(createEvent().event, workerParentRecord);

        expect(captureRecord).toHaveBeenCalledWith(workerParentRecord, 0);
    });

    it('counts untrusted, oversized, malformed, unknown-code, and unknown-context records as rejected', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const trusted = vi.fn((sender: {id: number}) => sender.id !== 1);
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: trusted as never,
            rateBurst: 10,
            registerListener: (_channel, handler) => { listener = handler; },
        });
        listener?.(createEvent(1).event, record);
        listener?.(createEvent(2).event, {
            ...record,
            padding: 'x'.repeat(20_000),
        });
        listener?.(createEvent(3).event, {
            ...record,
            code: 'UNKNOWN_CODE',
        });
        listener?.(createEvent(4).event, {
            ...record,
            context: {unknown: true},
        });

        expect(captureRecord).not.toHaveBeenCalled();
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 0,
            rateDropped: 0,
            schemaDropped: 3,
            untrustedDropped: 1,
        });
    });

    it('rate-limits each sender independently and cleans up the sender state', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: () => true,
            now: () => 1_000,
            rateBurst: 1,
            ratePerSecond: 1,
            registerListener: (_channel, handler) => { listener = handler; },
        });
        const first = createEvent(7);
        listener?.(first.event, record);
        listener?.(first.event, record);
        listener?.(createEvent(8).event, record);

        expect(captureRecord).toHaveBeenCalledTimes(2);
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 2,
            rateDropped: 1,
            schemaDropped: 0,
            untrustedDropped: 0,
        });
        first.sender.emit('destroyed');
        expect(first.sender.listenerCount('destroyed')).toBe(0);
        listener?.(first.event, record);
        expect(captureRecord).toHaveBeenCalledTimes(3);
    });

    it('rejects malformed summary counts and survives malformed events or a throwing clock', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown, suppressedCount?: unknown) => void) | undefined;
        const captureRecord = vi.fn();
        const bridge = registerRendererDiagnosticBridge({
            captureRecord,
            isTrustedSender: () => true,
            now: () => { throw new Error('clock failed'); },
            registerListener: (_channel, handler) => { listener = handler; },
        });

        expect(() => listener?.(createEvent().event, record, 10_001)).not.toThrow();
        expect(() => listener?.(null as never, record)).not.toThrow();
        expect(() => listener?.(createEvent().event, record, 3)).not.toThrow();

        expect(captureRecord).toHaveBeenCalledWith(record, 3);
        expect(bridge.getHealthSnapshot()).toEqual({
            accepted: 1,
            rateDropped: 0,
            schemaDropped: 1,
            untrustedDropped: 1,
        });
    });

    it('carries a renderer summary through the main reporter and caps the combined total', () => {
        let listener: ((event: Electron.IpcMainEvent, payload: unknown, suppressedCount?: unknown) => void) | undefined;
        let now = 0;
        const send = vi.fn();
        const mainReporter = createMainFailureReporter({
            burstLimit: 1,
            burstWindowMs: 10,
            now: () => now,
            preference: 'granted',
            transport: {send},
        });
        registerRendererDiagnosticBridge({
            captureRecord: (received, suppressedCount) => mainReporter.captureRecord(received, suppressedCount),
            isTrustedSender: () => true,
            registerListener: (_channel, handler) => { listener = handler; },
        });

        listener?.(createEvent(7).event, record, 0);
        listener?.(createEvent(7).event, {
            ...record,
            eventId: 'b'.repeat(32) as DiagnosticEventId,
        }, 10_000);
        now = 10;
        listener?.(createEvent(7).event, {
            ...record,
            eventId: 'c'.repeat(32) as DiagnosticEventId,
        }, 10_000);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]).toEqual([
            expect.objectContaining({eventId: 'c'.repeat(32)}),
            10_000,
        ]);
        expect(mainReporter.getHealthSnapshot()).toMatchObject({
            accepted: 2,
            burstSuppressed: 10_001,
        });
    });
});
