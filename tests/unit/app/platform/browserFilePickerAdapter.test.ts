// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

function setUserActivation(isActive: boolean) {
    Object.defineProperty(navigator, 'userActivation', {
        configurable: true,
        value: {
            isActive,
            hasBeenActive: isActive,
        },
    });
}

describe('browser file picker adapter', () => {
    afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(navigator, 'userActivation');
        document.body.replaceChildren();
    });

    it('ends a pick without user activation as cancelled and leaves no file input behind', async () => {
        setUserActivation(false);
        const {pickFiles} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        await expect(pickFiles({
            accept: '.pdf',
            preferFileSystemAccess: false,
        })).resolves.toEqual([]);
        expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    });

    it('returns the file chosen through an activated pick and removes its input', async () => {
        setUserActivation(true);
        const {pickFiles} = await import('@app/platform/browser-api/browserFilePickerAdapter');
        const chosen = new File(['%PDF-1.7'], 'chosen.pdf', {type: 'application/pdf'});

        const pick = pickFiles({
            accept: '.pdf',
            preferFileSystemAccess: false,
        });
        const input = document.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) {
            throw new Error('The activated pick did not attach a file input');
        }
        Object.defineProperty(input, 'files', {value: [chosen]});
        input.dispatchEvent(new Event('change'));

        await expect(pick).resolves.toEqual([{
            file: chosen,
            handle: null,
        }]);
        expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    });

    it('aborts a writer when close times out before reporting the save as failed', async () => {
        vi.useFakeTimers();
        let aborted = false;
        let committed = false;
        let releaseClose!: () => void;
        const close = vi.fn(() => new Promise<void>(resolve => {
            releaseClose = () => {
                if (!aborted) {
                    committed = true;
                }
                resolve();
            };
        }));
        const abort = vi.fn(async () => {
            aborted = true;
        });
        const writable = Object.assign(new WritableStream(), {
            abort,
            close,
            seek: vi.fn(async (_position: number) => {}),
            truncate: vi.fn(async (_size: number) => {}),
            write: vi.fn(async (_data: FileSystemWriteChunkType) => {}),
        }) satisfies FileSystemWritableFileStream;
        const handle = {
            kind: 'file',
            name: 'timed-out.pdf',
            isSameEntry: vi.fn(async (_other: FileSystemHandle) => false),
            getFile: vi.fn(async () => new File([], 'timed-out.pdf')),
            createSyncAccessHandle: vi.fn(async () => {
                throw new Error('Synchronous access is not part of this writer fixture');
            }),
            createWritable: vi.fn(async () => writable),
        } satisfies FileSystemFileHandle;
        const {writeBytesToHandle} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        const save = writeBytesToHandle(handle, Uint8Array.of(37, 80, 68, 70));
        const saveError = save.catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 12; index += 1) {
            await Promise.resolve();
        }
        expect(close).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(180_000);
        const error = await saveError;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Browser file save did not finish while waiting for closing file writer');
        expect(abort).toHaveBeenCalledOnce();

        releaseClose();
        await Promise.resolve();
        expect(committed).toBe(false);
    });
});
