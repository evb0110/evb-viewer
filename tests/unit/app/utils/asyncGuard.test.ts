import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    guardAsync,
    runGuardedTask,
} from '@app/utils/async-guard';

const loggerSpies = vi.hoisted(() => ({
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@app/utils/browser-logger', () => ({ BrowserLogger: loggerSpies }));

describe('async-guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('logs rejected promises', async () => {
        guardAsync(Promise.reject(new Error('boom')), {
            scope: 'test-scope',
            message: 'Failed to run task',
        });

        await Promise.resolve();

        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({ message: 'boom' }),
        );
    });

    it('logs synchronous throws in runGuardedTask', () => {
        runGuardedTask(
            () => {
                throw new Error('sync boom');
            },
            {
                scope: 'test-scope',
                message: 'Failed to run task',
            },
        );

        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({ message: 'sync boom' }),
        );
    });

    it('runs onError callback before logging', async () => {
        const onError = vi.fn();
        guardAsync(Promise.reject(new Error('boom')), {
            scope: 'test-scope',
            message: 'Failed to run task',
            onError,
        });

        await Promise.resolve();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
    });
});
