import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const mocks = vi.hoisted(() => ({browserLogger: {error: vi.fn()}}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: mocks.browserLogger}));

function createFailure(eventId: string): FailureReceipt {
    return {
        eventId: eventId as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1767225600000),
        severity: 'error',
    };
}

function createOptions(key: 'app-bootstrap' | 'electron-platform-contract' | 'electron-preload-bridge') {
    return {
        error: new Error(`${key} failed`),
        key,
        message: 'Bootstrap failed',
        section: 'loader',
        title: 'Startup failure',
    } as const;
}

describe('renderer bootstrap failure ownership', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.browserLogger.error.mockReturnValue(createFailure('0123456789abcdef0123456789abcdef'));
    });

    it('reuses one receipt and presentation for the same closed bootstrap key', async () => {
        const {getOrCaptureRendererBootstrapFailure} = await import('@app/utils/getOrCaptureRendererBootstrapFailure');

        const first = getOrCaptureRendererBootstrapFailure(createOptions('electron-preload-bridge'));
        const second = getOrCaptureRendererBootstrapFailure({
            ...createOptions('electron-preload-bridge'),
            error: new Error('a later bridge observation failed'),
            title: 'A different title must not replace the first presentation',
        });

        expect(second).toBe(first);
        expect(second.failure).toBe(first.failure);
        expect(mocks.browserLogger.error).toHaveBeenCalledOnce();
    });

    it('keeps different bootstrap keys as separate occurrences', async () => {
        const {getOrCaptureRendererBootstrapFailure} = await import('@app/utils/getOrCaptureRendererBootstrapFailure');
        mocks.browserLogger.error
            .mockReturnValueOnce(createFailure('0123456789abcdef0123456789abcdef'))
            .mockReturnValueOnce(createFailure('fedcba9876543210fedcba9876543210'));

        const bridge = getOrCaptureRendererBootstrapFailure(createOptions('electron-preload-bridge'));
        const contract = getOrCaptureRendererBootstrapFailure(createOptions('electron-platform-contract'));

        expect(contract).not.toBe(bridge);
        expect(contract.failure.eventId).not.toBe(bridge.failure.eventId);
        expect(mocks.browserLogger.error).toHaveBeenCalledTimes(2);
    });
});
