/* eslint-disable @stylistic/array-bracket-newline, @stylistic/array-element-newline, @stylistic/object-curly-newline, @stylistic/object-property-newline */
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';

interface ITestProgress {
    requestId: string;
    phase: 'active' | 'complete';
    value: number;
}

describe('createIpcProgressPump replay', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('replays latest active progress state to a late subscriber', () => {
        const primarySend = vi.fn();
        const lateSend = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => ({send: primarySend}),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
            intervalMs: 100,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'active',
            value: 1,
        });
        pump.enqueue({
            requestId: 'operation-a',
            phase: 'active',
            value: 2,
        });
        pump.enqueue({
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });

        pump.replay({send: lateSend});

        expect(lateSend).toHaveBeenCalledTimes(2);
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'active',
            value: 2,
        });
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        lateSend.mockClear();

        pump.replay({send: lateSend});

        expect(lateSend).toHaveBeenCalledTimes(2);
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });
        pump.clear();
    });

    it('retains terminal progress for the configured replay TTL', () => {
        vi.useFakeTimers();
        const primarySend = vi.fn();
        const lateSend = vi.fn();
        const onIdle = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => ({send: primarySend}),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
            terminalRetentionMs: 30_000,
            onIdle,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        pump.clear();

        pump.replay({send: lateSend});
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });

        lateSend.mockClear();
        vi.advanceTimersByTime(30_000);
        pump.replay({send: lateSend});

        expect(lateSend).not.toHaveBeenCalled();
        expect(onIdle).toHaveBeenCalled();
    });

    it('does not double-deliver live progress when the primary target later subscribes for replay', () => {
        const primarySend = vi.fn();
        const replaySend = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => ({
                key: 'sender:1',
                send: primarySend,
            }),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
            intervalMs: 100,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'active',
            value: 1,
        });
        expect(primarySend).toHaveBeenCalledTimes(1);

        pump.replay({
            key: 'sender:1',
            send: replaySend,
        });
        expect(replaySend).toHaveBeenCalledTimes(1);

        primarySend.mockClear();
        replaySend.mockClear();

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });

        expect(primarySend).toHaveBeenCalledTimes(1);
        expect(primarySend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        expect(replaySend).not.toHaveBeenCalled();
    });

    it('sends live progress only to the target it was published for', () => {
        const ownerSend = vi.fn();
        const otherSend = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => null,
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
        });

        pump.replay({key: 'sender:2', send: otherSend});
        pump.enqueue({requestId: 'operation-a', phase: 'active', value: 1}, {key: 'sender:1', send: ownerSend});
        pump.enqueue({requestId: 'operation-a', phase: 'complete', value: 100}, {key: 'sender:1', send: ownerSend});

        expect(ownerSend.mock.calls).toEqual([
            ['test:progress', {requestId: 'operation-a', phase: 'active', value: 1}],
            ['test:progress', {requestId: 'operation-a', phase: 'complete', value: 100}],
        ]);
        expect(otherSend).not.toHaveBeenCalled();
    });

    it('delegates replay retention to an external owner', () => {
        const replaySend = vi.fn();
        let replay = [{requestId: 'external', phase: 'active', value: 7}] satisfies ITestProgress[];
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress', getTarget: () => null,
            getKey: progress => progress.requestId,
            replayMode: {kind: 'external', getReplayPayloads: () => replay},
        });
        pump.enqueue({requestId: 'not-retained-internally', phase: 'active', value: 1});
        pump.replay({send: replaySend});
        expect(replaySend.mock.calls).toEqual([['test:progress', replay[0]]]);
        replaySend.mockClear(); replay = [];
        pump.replay({send: replaySend});
        expect(replaySend).not.toHaveBeenCalled();
    });
});
