import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    guardAsync,
    runDetached,
    runGuardedTask,
} from '@app/utils/asyncGuard';

const loggerSpies = vi.hoisted(() => ({
    error: vi.fn(),
    debug: vi.fn(),
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: loggerSpies }));

describe('asyncGuard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('logs rejected promises', async () => {
        guardAsync(Promise.reject(new Error('boom')), {
            category: 'background-diagnostic',
            scope: 'test-scope',
            message: 'Failed to run task',
        });

        await Promise.resolve();

        expect(loggerSpies.error).not.toHaveBeenCalled();
        expect(loggerSpies.warn).toHaveBeenCalledTimes(1);
        expect(loggerSpies.warn).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({
                category: 'background-diagnostic',
                error: expect.objectContaining({ message: 'boom' }),
            }),
        );
    });

    it('logs synchronous throws in runGuardedTask', () => {
        runGuardedTask(
            () => {
                throw new Error('sync boom');
            },
            {
                category: 'background-diagnostic',
                scope: 'test-scope',
                message: 'Failed to run task',
            },
        );

        expect(loggerSpies.error).not.toHaveBeenCalled();
        expect(loggerSpies.warn).toHaveBeenCalledTimes(1);
        expect(loggerSpies.warn).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({
                category: 'background-diagnostic',
                error: expect.objectContaining({ message: 'sync boom' }),
            }),
        );
    });

    it('contains failures from intentionally detached tasks', async () => {
        await runDetached(
            () => Promise.reject(new Error('detached boom')),
            {
                category: 'background-diagnostic',
                scope: 'detached-test',
                message: 'Detached task failed',
            },
        );

        await Promise.resolve();

        expect(loggerSpies.error).not.toHaveBeenCalled();
        expect(loggerSpies.warn).toHaveBeenCalledWith(
            'detached-test',
            'Detached task failed',
            expect.objectContaining({error: expect.objectContaining({message: 'detached boom'})}),
        );
    });

    it('runs onError callback before logging', async () => {
        const onError = vi.fn();
        const observed: string[] = [];
        onError.mockImplementation(() => {
            observed.push('onError');
        });
        loggerSpies.error.mockImplementation(() => {
            observed.push('logger');
        });

        guardAsync(Promise.reject(new Error('boom')), {
            category: 'user-visible-operation',
            scope: 'test-scope',
            message: 'Failed to run task',
            onError,
        });

        await Promise.resolve();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({category: 'user-visible-operation'}),
            {code: 'RENDERER_ASYNC_GUARD_FAILED'},
        );
        expect(onError.mock.invocationCallOrder[0]).toBeLessThan(loggerSpies.error.mock.invocationCallOrder[0]!);
        expect(observed).toEqual([
            'onError',
            'logger',
        ]);
    });

    it('logs expected cancellations at debug level', async () => {
        const error = new DOMException('Aborted', 'AbortError');

        guardAsync(Promise.reject(error), {
            category: 'background-diagnostic',
            scope: 'test-scope',
            message: 'Task was canceled',
        });

        await Promise.resolve();

        expect(loggerSpies.error).not.toHaveBeenCalled();
        expect(loggerSpies.debug).toHaveBeenCalledWith(
            'test-scope',
            'Task was canceled',
            expect.objectContaining({
                category: 'background-diagnostic',
                canceled: true,
                error,
            }),
        );
    });
});
