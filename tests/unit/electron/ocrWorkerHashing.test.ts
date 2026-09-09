import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createAbortError} from '@electron/utils/abort';

const mocks = vi.hoisted(() => ({createReadStream: vi.fn()}));

vi.mock('node:fs', () => ({createReadStream: mocks.createReadStream}));

const {sha256OcrFile} = await import('@electron/features/ocr/worker/sha256OcrFile');

describe('OCR worker result hashing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the SHA-256 digest for a complete binary stream', async () => {
        mocks.createReadStream.mockReturnValue((async function* () {
            yield Buffer.from('abc');
        })());

        await expect(sha256OcrFile(
            '/tmp/ocr-result.pdf',
            new AbortController().signal,
        )).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('stops hashing when cancellation arrives between streamed chunks', async () => {
        const controller = new AbortController();
        mocks.createReadStream.mockReturnValue((async function* () {
            yield Buffer.from('first');
            controller.abort(createAbortError('cancel result hashing'));
            yield Buffer.from('second');
        })());

        await expect(sha256OcrFile(
            '/tmp/ocr-result.pdf',
            controller.signal,
        )).rejects.toMatchObject({
            name: 'AbortError',
            message: 'cancel result hashing',
        });
    });
});
