import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as BrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';

const qpdfMock = vi.hoisted(() => ({runBrowserQpdfCommand: vi.fn()}));

vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof BrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: (...args: unknown[]) => qpdfMock.runBrowserQpdfCommand(...args),
}));

describe('finishBrowserPdfCandidate', () => {
    const source = Uint8Array.from({length: 10}, (_, index) => index + 1);
    const rewriteResult = (output: Uint8Array | null, exitCode = 0) => ({
        exitCode,
        stdout: '',
        stderr: '',
        output,
    });
    const checkResult = (exitCode: number) => ({
        exitCode,
        stdout: exitCode === 2 ? '' : 'checking document.pdf\nNo syntax or stream encoding errors found',
        stderr: exitCode === 2 ? 'damaged' : '',
        output: null,
    });

    function answerQpdf(rewrite: unknown, checkExitCode = 0) {
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async (command: string) => {
            if (command === 'lossless-rewrite') {
                if (rewrite instanceof Error) throw rewrite;
                return rewrite;
            }
            return checkResult(checkExitCode);
        });
    }

    beforeEach(() => {
        qpdfMock.runBrowserQpdfCommand.mockReset();
    });

    it('keeps a smaller rewrite that passes its own full check and leaves the input intact', async () => {
        const candidate = Uint8Array.of(9, 9, 9);
        answerQpdf(rewriteResult(candidate, 3));
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBe(candidate);

        const rewriteInput = qpdfMock.runBrowserQpdfCommand.mock.calls[0]?.[1] as Uint8Array;
        expect(rewriteInput).not.toBe(source);
        expect(rewriteInput.buffer).not.toBe(source.buffer);
        expect([...source]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
        ]);
        expect(qpdfMock.runBrowserQpdfCommand.mock.calls.map(([command]) => command))
            .toEqual([
                'lossless-rewrite',
                'check',
            ]);
    });

    it.each([
        [
            'an equal-size rewrite',
            rewriteResult(new Uint8Array(10)),
            0,
        ],
        [
            'a larger rewrite',
            rewriteResult(new Uint8Array(11)),
            0,
        ],
        [
            'an empty rewrite',
            rewriteResult(new Uint8Array()),
            0,
        ],
        [
            'no rewrite output',
            rewriteResult(null),
            0,
        ],
        [
            'a failed rewrite exit',
            rewriteResult(Uint8Array.of(1), 2),
            0,
        ],
        [
            'a rewrite that throws',
            new Error('engine ran out of memory'),
            0,
        ],
        [
            'a candidate that fails its full check',
            rewriteResult(Uint8Array.of(1)),
            2,
        ],
    ])('retains the input after %s', async (_label, rewrite, checkExitCode) => {
        answerQpdf(rewrite, checkExitCode);
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBeNull();
    });

    it('throws an abort instead of retaining the input', async () => {
        const controller = new AbortController();
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async () => {
            controller.abort(new DOMException('Optimize was canceled', 'AbortError'));
            throw new Error('engine stopped');
        });
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: controller.signal,
        }))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('does not start qpdf after an abort', async () => {
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: AbortSignal.abort(),
        }))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(qpdfMock.runBrowserQpdfCommand).not.toHaveBeenCalled();
    });
});
