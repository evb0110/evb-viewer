import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    classifyUnhandledRejectionSubsystem,
    createUnhandledRejectionRecovery,
    decideUnhandledRejection,
} from '@electron/unhandledRejectionRecovery';
import { createAbortError } from '@electron/utils/abort';

describe('unhandled rejection recovery', () => {
    it('classifies subsystem failures from stack and message evidence', () => {
        const error = new Error('Tesseract worker failed');
        error.stack = 'Error\n at electron/features/ocr/main/jobManager.ts:10';
        expect(classifyUnhandledRejectionSubsystem(error)).toBe('ocr');
        expect(classifyUnhandledRejectionSubsystem({code: 'OCR_INTERNAL_ERROR'})).toBe('ocr');
        expect(classifyUnhandledRejectionSubsystem(new Error('unrelated failure'))).toBe('unknown');
    });

    it('classifies tagged subsystem failures when the packaged stack has no source path', () => {
        const error = Object.assign(new Error('native worker failed'), {
            stack: 'Error\n at dist-electron/main-chunk-chunk-2AGSP3A7.js:10:20',
            subsystem: 'ocr' as const,
        });

        expect(decideUnhandledRejection(error)).toEqual({
            action: 'recover',
            subsystem: 'ocr',
        });
    });

    it('restarts a subsystem only after the rolling threshold', async () => {
        let timestamp = 1_000;
        const recover = vi.fn();
        const handle = createUnhandledRejectionRecovery({
            threshold: 3,
            windowMs: 10_000,
            now: () => timestamp,
            recover,
        });
        const failure = new Error('search worker rejected');

        await expect(handle('search', failure)).resolves.toMatchObject({
            count: 1,
            recovered: false,
            subsystem: 'search',
        });
        timestamp += 1_000;
        await expect(handle('search', failure)).resolves.toMatchObject({
            count: 2,
            recovered: false,
        });
        timestamp += 1_000;
        await expect(handle('search', failure)).resolves.toMatchObject({
            count: 3,
            recovered: true,
        });
        expect(recover).toHaveBeenCalledOnce();
    });

    it('propagates a subsystem recovery rejection so the caller can escalate it', async () => {
        const recoveryFailure = new Error('native cleanup rejected');
        const handle = createUnhandledRejectionRecovery({
            threshold: 2,
            recover: vi.fn().mockRejectedValue(recoveryFailure),
        });
        const failure = new Error('search worker rejected');

        await expect(handle('search', failure)).resolves.toMatchObject({
            count: 1,
            recovered: false,
        });
        await expect(handle('search', failure)).rejects.toBe(recoveryFailure);
    });

    it.each([
        'Persistence commit aborted after durable write',
        'Persistence commit canceled after durable write',
        'Persistence commit cancelled after durable write',
    ])('does not treat cancellation words in an unknown invariant failure as an abort: %s', (message) => {
        expect(decideUnhandledRejection(new Error(message))).toEqual({action: 'report'});
    });

    it.each([
        createAbortError('Search request canceled'),
        new DOMException('Search request canceled', 'AbortError'),
        Object.assign(new Error('Search request canceled'), {code: 'ABORT_ERR'}),
    ])('ignores a typed abort rejection', (abort) => {
        expect(decideUnhandledRejection(abort)).toEqual({action: 'ignore'});
    });

    it('keeps classified subsystem failures on the bounded recovery path', () => {
        const failure = new Error('Search worker failed');

        expect(decideUnhandledRejection(failure)).toEqual({
            action: 'recover',
            subsystem: 'search',
        });
    });

    it('reports an unknown unhandled rejection instead of shutting down the app', () => {
        expect(
            decideUnhandledRejection(new Error('Unexpected persistence invariant failure')),
        ).toEqual({action: 'report'});
    });
});
