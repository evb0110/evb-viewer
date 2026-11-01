// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createFileSystemFileHandle} from '@tests/unit/app/platform/browserPlatformTestDoubles';

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
        Reflect.deleteProperty(window, 'showSaveFilePicker');
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

        // The close deadline is three minutes plus a second per started 8 MiB.
        await vi.advanceTimersByTimeAsync(181_000);
        const error = await saveError;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Browser file save did not finish while waiting for closing file writer');
        expect(abort).toHaveBeenCalledOnce();

        releaseClose();
        await Promise.resolve();
        expect(committed).toBe(false);
    });

    it('saves a large file whose disk writes progress slowly, however long the whole write takes', async () => {
        vi.useFakeTimers();
        const saved: number[] = [];
        // A slow disk: 30 seconds per MiB, six minutes for the whole file.
        const write = vi.fn((data: FileSystemWriteChunkType) => new Promise<void>((resolve) => {
            const byteLength = data instanceof Blob ? data.size : ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0;
            setTimeout(() => {
                saved.push(byteLength);
                resolve();
            }, byteLength / (1024 * 1024) * 30_000);
        }));
        const writable = Object.assign(new WritableStream(), {
            abort: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
            seek: vi.fn(async (_position: number) => {}),
            truncate: vi.fn(async (_size: number) => {}),
            write,
        }) satisfies FileSystemWritableFileStream;
        const handle = Object.assign(createFileSystemFileHandle({name: 'large.pdf'}), {createWritable: async () => writable});
        const {writeBytesToHandle} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        const save = writeBytesToHandle(handle, new Uint8Array(12 * 1024 * 1024)).then(() => 'saved', (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(400_000);

        await expect(save).resolves.toBe('saved');
        expect(saved.reduce((total, byteLength) => total + byteLength, 0)).toBe(12 * 1024 * 1024);
    });

    it('waits for a write permission answer given after minutes, and stops waiting when the save is cancelled', async () => {
        vi.useFakeTimers();
        const createHandle = (answerAfterMs: number) => Object.assign(createFileSystemFileHandle({name: 'prompted.pdf'}), {
            queryPermission: async () => 'prompt' as const,
            requestPermission: () => new Promise<'granted'>(resolve => setTimeout(() => resolve('granted'), answerAfterMs)),
        });
        const {ensureFileHandleWritePermission} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        const answered = ensureFileHandleWritePermission(createHandle(10 * 60_000)).then(() => 'granted', (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await expect(answered).resolves.toBe('granted');

        const controller = new AbortController();
        const cancelled = ensureFileHandleWritePermission(createHandle(60 * 60_000), controller.signal).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        controller.abort();
        await expect(cancelled).resolves.toMatchObject({name: 'AbortError'});
    });

    it('checks a revoked write grant inside the save lock without prompting or opening a writer', async () => {
        const requestPermission = vi.fn(async () => 'granted' as const);
        const createWritable = vi.fn(async () => {
            throw new Error('A writer must not open before the grant is checked');
        });
        const handle = Object.assign(createFileSystemFileHandle({name: 'staged-save.pdf'}), {
            queryPermission: async () => 'prompt' as const,
            requestPermission,
            createWritable,
        });
        const {writeBytesToHandleInSaveLock} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        await expect(writeBytesToHandleInSaveLock(handle, Uint8Array.of(37, 80, 68, 70)))
            .rejects.toThrow('Browser write permission for this file changed while the save waited for other saves.');
        expect(requestPermission).not.toHaveBeenCalled();
        expect(createWritable).not.toHaveBeenCalled();
    });

    it.each([
        'pick',
        'bytes',
    ])('refuses an incompatible TIFF destination through the %s save path without changing its bytes', async (path) => {
        let saved = 'existing PNG bytes';
        const writable = Object.assign(new WritableStream(), {
            write: async (data: FileSystemWriteChunkType) => {saved = String(data);},
            close: async () => {},
            abort: async () => {},
            seek: async () => {},
            truncate: async () => {},
        }) satisfies FileSystemWritableFileStream;
        const handle = {
            kind: 'file',
            name: 'doc.png',
            isSameEntry: async () => false,
            getFile: async () => new File([saved], 'doc.png'),
            createSyncAccessHandle: async () => {throw new Error('not used');},
            createWritable: async () => writable,
        } satisfies FileSystemFileHandle;
        Reflect.set(window, 'showSaveFilePicker', async () => handle);
        const {
            pickSaveTarget, saveBytesToPickerOrDownload,
        } = await import('@app/platform/browser-api/browserFilePickerAdapter');
        const options = {
            suggestedName: 'doc.tif',
            pickerTypes: [{accept: {'image/tiff': [
                '.tif',
                '.tiff',
            ]}}],
        };
        const save = path === 'pick' ? pickSaveTarget(options) : saveBytesToPickerOrDownload(Uint8Array.of(77, 77, 0, 42), {
            ...options,
            mimeType: 'image/tiff',
        });
        await expect(save).rejects.toThrow('Choose a file name ending in .tif, .tiff');
        expect(await (await handle.getFile()).text()).toBe('existing PNG bytes');
    });

    it.each([
        'jpeg',
        'png',
        'tiff',
    ] as const)('restricts an encoded %s save to that format', async (format) => {
        const {buildImageExportPickerTypes} = await import('@app/platform/browser-api/browserFileAccepts');
        const {IMAGE_EXPORT_FORMATS} = await import('@pdf-core/imageExportFileName');
        expect(buildImageExportPickerTypes(format).flatMap(type => Object.keys(type.accept)))
            .toEqual([IMAGE_EXPORT_FORMATS[format].mimeType]);
    });

});
