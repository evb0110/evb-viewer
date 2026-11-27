import {createHash} from 'node:crypto';
import type * as TFsModule from 'node:fs';
import type * as TFsPromisesModule from 'node:fs/promises';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';

const fsHooks = vi.hoisted(() => ({
    stalledPath: null as string | null,
    readStarted: null as (() => void) | null,
    releaseRead: null as (() => void) | null,
    closeCalled: false,
    closeCompleted: false,
    closeBeforeReadSettled: false,
    readSettled: false,
    readDeferred: null as Promise<void> | null,
}));

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof TFsModule>();
    return {
        ...actual,
        createReadStream(path: TFsModule.PathLike, options?: Parameters<typeof TFsModule.createReadStream>[1]) {
            if (fsHooks.stalledPath !== null && String(path) === fsHooks.stalledPath) {
                const baseOptions = typeof options === 'string' || options === undefined ? {} : options;
                const customFs = {
                    open: actual.open,
                    close: actual.close,
                    read(
                        fd: number,
                        buffer: NodeJS.ArrayBufferView,
                        offset: number,
                        length: number,
                        position: number | null,
                        callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void,
                    ) {
                        fsHooks.readStarted?.();
                        void fsHooks.readDeferred?.then(() => {
                            fsHooks.readSettled = true;
                            actual.read(fd, buffer, offset, length, position, callback);
                        });
                    },
                };
                return actual.createReadStream(path, {
                    ...baseOptions,
                    fs: customFs as NonNullable<Exclude<typeof options, string | undefined>['fs']>,
                });
            }
            return actual.createReadStream(path, options);
        },
    };
});

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof TFsPromisesModule>();
    return {
        ...actual,
        async open(path: TFsModule.PathLike, flags?: string | number, mode?: TFsModule.Mode) {
            const handle = await actual.open(path, flags, mode);
            if (fsHooks.stalledPath === null || String(path) !== fsHooks.stalledPath) {
                return handle;
            }
            const realRead = handle.read.bind(handle);
            const realClose = handle.close.bind(handle);
            let stalledOnce = false;
            return new Proxy(handle, {
                get(target, prop, receiver) {
                    if (prop === 'read') {
                        return async (...args: Parameters<typeof handle.read>) => {
                            if (!stalledOnce) {
                                stalledOnce = true;
                                fsHooks.readStarted?.();
                                await fsHooks.readDeferred;
                                try {
                                    return await realRead(...args);
                                } finally {
                                    fsHooks.readSettled = true;
                                }
                            }
                            return realRead(...args);
                        };
                    }
                    if (prop === 'close') {
                        return async () => {
                            fsHooks.closeCalled = true;
                            if (!fsHooks.readSettled) {
                                fsHooks.closeBeforeReadSettled = true;
                            }
                            try {
                                return await realClose();
                            } finally {
                                fsHooks.closeCompleted = true;
                            }
                        };
                    }
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

const {fingerprintFileBounded} = await import('@electron/features/documents/main/fingerprintFileBounded');

describe('bounded file fingerprint', () => {
    const directories: string[] = [];

    afterEach(() => {
        fsHooks.releaseRead?.();
        fsHooks.stalledPath = null;
        fsHooks.readStarted = null;
        fsHooks.releaseRead = null;
        fsHooks.closeCalled = false;
        fsHooks.closeCompleted = false;
        fsHooks.closeBeforeReadSettled = false;
        fsHooks.readSettled = false;
        fsHooks.readDeferred = null;
        for (const directory of directories.splice(0)) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fingerprints generic binary content through bounded chunk reads', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'placed-image.jpg');
        const bytes = Buffer.concat([
            Buffer.from([
                0xff,
                0xd8,
                0xff,
                0xe0,
            ]),
            Buffer.alloc(3 * 1024 * 1024 + 19, 0xa5),
        ]);
        writeFileSync(path, bytes);

        await expect(fingerprintFileBounded(path, bytes.byteLength)).resolves.toEqual({
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            contentFingerprint: `sha256-full-v1:${createOriginalFileContentFingerprintHash(bytes.byteLength).update(bytes).digest('hex')}`,
        });
    });

    it('fingerprints an empty file accurately', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'empty.bin');
        const bytes = Buffer.alloc(0);
        writeFileSync(path, bytes);

        await expect(fingerprintFileBounded(path, 0)).resolves.toEqual({
            bytes: 0,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            contentFingerprint: `sha256-full-v1:${createOriginalFileContentFingerprintHash(0).update(bytes).digest('hex')}`,
        });
    });

    it('rejects a file whose size differs from the caller expectation', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'document.pdf');
        writeFileSync(path, Buffer.from('%PDF-1.7\n%%EOF'));

        await expect(fingerprintFileBounded(path, 1)).rejects.toThrow('size changed');
    });

    it('unblocks immediately when aborted during a stalled read and defers closing the handle until the read settles', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'stalled.pdf');
        const bytes = Buffer.from('%PDF-1.7\nstalled read test\n%%EOF');
        writeFileSync(path, bytes);

        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        fsHooks.stalledPath = path;
        fsHooks.readStarted = started.resolve;
        fsHooks.releaseRead = release.resolve;
        fsHooks.readDeferred = release.promise;

        const controller = new AbortController();
        const abortReason = new Error('save deadline exceeded');
        const fingerprintPromise = fingerprintFileBounded(path, bytes.byteLength, controller.signal);

        await started.promise;
        controller.abort(abortReason);

        let watchdogTimer: NodeJS.Timeout | undefined;
        let outcome:
            | {kind: 'resolved'}
            | {
                kind: 'rejected';
                error: unknown;
            }
            | {kind: 'stalled'};
        try {
            outcome = await Promise.race([
                fingerprintPromise.then(
                    () => ({kind: 'resolved' as const}),
                    (error: unknown) => ({
                        kind: 'rejected' as const,
                        error,
                    }),
                ),
                new Promise<{kind: 'stalled'}>(resolve => {
                    watchdogTimer = setTimeout(() => resolve({kind: 'stalled'}), 150);
                }),
            ]);
        } finally {
            if (watchdogTimer !== undefined) {
                clearTimeout(watchdogTimer);
            }
        }

        expect(outcome).toEqual({
            kind: 'rejected',
            error: abortReason,
        });
        expect(fsHooks.readSettled).toBe(false);
        expect(fsHooks.closeCalled).toBe(false);
        expect(fsHooks.closeBeforeReadSettled).toBe(false);

        release.resolve();
        await vi.waitFor(() => {
            expect(fsHooks.readSettled).toBe(true);
            expect(fsHooks.closeCalled).toBe(true);
            expect(fsHooks.closeCompleted).toBe(true);
        });
        expect(fsHooks.closeBeforeReadSettled).toBe(false);
    });
});
