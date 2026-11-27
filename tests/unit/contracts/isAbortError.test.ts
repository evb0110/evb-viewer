import {createAbortError, isAbortError} from '@contracts/isAbortError';
import {describe, expect, it, vi} from 'vitest';

describe('canonical abort error contract', () => {
    it('creates Error instances with AbortError name and message', () => {
        const defaultError = createAbortError();
        expect(defaultError).toBeInstanceOf(Error);
        expect(defaultError.name).toBe('AbortError');
        expect(defaultError.message).toBe('The operation was aborted');

        const customError = createAbortError('Renderer destroyed');
        expect(customError).toBeInstanceOf(Error);
        expect(customError.name).toBe('AbortError');
        expect(customError.message).toBe('Renderer destroyed');
    });

    it('recognizes canonical AbortError, ABORT_ERR, DOMException.ABORT_ERR, and MainOperationUserCanceledError shapes', () => {
        const userCanceled = new Error('Canceled by the user');
        userCanceled.name = 'MainOperationUserCanceledError';

        const nodeAbort = Object.assign(new Error('The operation was aborted'), {code: 'ABORT_ERR'});
        const domCodeOnly = {code: DOMException.ABORT_ERR};

        expect(isAbortError(createAbortError())).toBe(true);
        expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
        expect(isAbortError({name: 'AbortError'})).toBe(true);
        expect(isAbortError(userCanceled)).toBe(true);
        expect(isAbortError(nodeAbort)).toBe(true);
        expect(isAbortError({code: 'ABORT_ERR'})).toBe(true);
        expect(isAbortError(domCodeOnly)).toBe(true);
    });

    it('unwraps SuppressedError and cause chains without losing abort identity', () => {
        const abort = createAbortError('save canceled');
        const cleanup = new Error('disposer failed');

        expect(isAbortError(new SuppressedError(cleanup, abort))).toBe(true);
        expect(isAbortError(new SuppressedError(abort, cleanup))).toBe(true);
        expect(
            isAbortError(
                new SuppressedError(new Error('outer disposer'), new SuppressedError(cleanup, new DOMException('canceled', 'AbortError'))),
            ),
        ).toBe(true);
        expect(
            isAbortError({
                name: 'SuppressedError',
                error: cleanup,
                suppressed: {code: 'ABORT_ERR'},
            }),
        ).toBe(true);
        expect(isAbortError(new Error('IPC invoke failed', {cause: abort}))).toBe(true);
        expect(isAbortError(new Error('outer', {cause: new SuppressedError(cleanup, abort)}))).toBe(true);
    });

    it('rejects non-abort errors, message-only strings, timeouts, arrays, and cycles', () => {
        const timeoutDom = new DOMException('timed out', 'TimeoutError');
        const timeoutErr = Object.assign(new Error('timed out'), {name: 'TimeoutError'});
        const arrayWithAbortName = Object.assign([], {name: 'AbortError'});

        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
        expect(isAbortError('AbortError')).toBe(false);
        expect(isAbortError(DOMException.ABORT_ERR)).toBe(false);
        expect(isAbortError(arrayWithAbortName)).toBe(false);
        expect(isAbortError(new Error('Operation canceled'))).toBe(false);
        expect(isAbortError(new Error('The operation was aborted'))).toBe(false);
        expect(isAbortError(new Error('Renderer destroyed'))).toBe(false);
        expect(isAbortError(timeoutDom)).toBe(false);
        expect(isAbortError(timeoutErr)).toBe(false);
        expect(isAbortError(new SuppressedError(new Error('cleanup'), new Error('boom')))).toBe(false);

        const cyclicCause: {cause?: unknown} = {};
        cyclicCause.cause = cyclicCause;
        expect(isAbortError(cyclicCause)).toBe(false);

        const cyclicSuppressed: {
            name: string;
            error?: unknown;
            suppressed?: unknown;
        } = {name: 'SuppressedError'};
        cyclicSuppressed.suppressed = cyclicSuppressed;
        cyclicSuppressed.error = cyclicSuppressed;
        expect(isAbortError(cyclicSuppressed)).toBe(false);
    });

    it('rejects plain errors with undefined code even when DOMException.ABORT_ERR is absent', async () => {
        const originalDomException = globalThis.DOMException;
        class MinimalDomException extends Error {
            constructor(message?: string, name?: string) {
                super(message);
                this.name = name ?? 'DOMException';
            }
        }
        try {
            Object.defineProperty(globalThis, 'DOMException', {
                value: MinimalDomException,
                configurable: true,
                writable: true,
            });
            vi.resetModules();
            const {isAbortError: reloadedIsAbortError} = await import('@contracts/isAbortError');
            expect(reloadedIsAbortError(new Error('plain error'))).toBe(false);
            expect(reloadedIsAbortError({code: undefined})).toBe(false);
            expect(reloadedIsAbortError({code: 20})).toBe(true);
        } finally {
            Object.defineProperty(globalThis, 'DOMException', {
                value: originalDomException,
                configurable: true,
                writable: true,
            });
            vi.resetModules();
        }
    });
});
