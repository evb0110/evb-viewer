import {describe, expect, it, vi} from 'vitest';
import {withTimeout} from 'es-toolkit/promise';
import {isTimeoutError} from '@contracts/isTimeoutError';

describe('isTimeoutError', () => {
    it('recognizes the current es-toolkit timeout error shape', async () => {
        vi.useFakeTimers();

        try {
            const promise = withTimeout(() => new Promise<void>(() => undefined), 10).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(10);
            const error = await promise;

            expect(isTimeoutError(error)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('recognizes the legacy Error-based timeout shape', () => {
        const error = new Error('Timed out');
        error.name = 'TimeoutError';

        expect(isTimeoutError(error)).toBe(true);
    });

    it('does not classify unrelated errors as timeouts', () => {
        expect(isTimeoutError(new Error('The operation failed'))).toBe(false);
        expect(isTimeoutError(null)).toBe(false);
    });
});
