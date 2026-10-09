import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {Readable} from 'node:stream';
import {createAbortError} from '@electron/utils/abort';

const mocks = vi.hoisted(() => ({createReadStream: vi.fn()}));

vi.mock('fs', () => ({createReadStream: mocks.createReadStream}));

const {hashFileSha256} = await import('@electron/utils/hashFileSha256');

describe('OCR worker result hashing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects an already cancelled request before reading the result', async () => {
        const controller = new AbortController();
        controller.abort(createAbortError('cancelled before hashing'));

        await expect(hashFileSha256('/tmp/ocr-result.pdf', controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
            message: 'cancelled before hashing',
        });
        expect(mocks.createReadStream).not.toHaveBeenCalled();
    });

    it('returns the SHA-256 digest for a complete binary stream', async () => {
        mocks.createReadStream.mockReturnValue(Readable.from((async function* () {
            yield Buffer.from('abc');
        })()));

        await expect(hashFileSha256(
            '/tmp/ocr-result.pdf',
            new AbortController().signal,
        )).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('stops hashing when cancellation arrives between streamed chunks', async () => {
        const controller = new AbortController();
        mocks.createReadStream.mockReturnValue(Readable.from((async function* () {
            yield Buffer.from('first');
            controller.abort(createAbortError('cancel result hashing'));
            yield Buffer.from('second');
        })()));

        await expect(hashFileSha256(
            '/tmp/ocr-result.pdf',
            controller.signal,
        )).rejects.toMatchObject({
            name: 'AbortError',
            message: 'cancel result hashing',
        });
    });
});
