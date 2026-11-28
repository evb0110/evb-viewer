import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {decodeAppUpdateStatus} from '@contracts/updatesPlatformFeature';
import {decodeHostEnvironmentSnapshot} from '@contracts/hostPlatformFeature';
import {DOCUMENTS_DIR, encodeJson, MANIFEST_NAME} from '@document-store/documentDirectory';
import type {IStorePort} from '@document-store/storePort';
import {decodePreloadAppUpdateStatus, decodePreloadHostEnvironmentSnapshot} from '@electron/preload/preloadDecoders';
import {PRELOAD_METHOD_ARG_MAPPERS, toPlainIpcValue} from '@electron/preload/preloadMethodArgMappers';
import * as preloadPlatformFeatures from '@electron/preload/platformFeatures';
import {findUnshownUnsavedDirectories} from '@electron/file-access/findUnshownUnsavedDirectories';

describe('preload split decoders and arg mappers', () => {
    it('matches decodeAppUpdateStatus on valid and invalid update snapshots', () => {
        const samples: unknown[] = [
            {
                phase: 'idle',
                origin: 'auto',
                version: '1.2.3',
                percent: null,
                message: null,
            },
            {
                phase: 'downloading',
                origin: 'manual',
                version: '2.0.0',
                percent: 42.5,
                message: null,
                requestedHere: true,
            },
            {
                phase: 'error',
                origin: 'manual',
                reason: 'install-permission-denied',
                version: null,
                percent: null,
                message: 'Permission denied',
                requestedHere: false,
            },
            null,
            'idle',
            {phase: 'unknown', origin: 'auto', version: null, percent: null, message: null},
            {phase: 'idle', origin: 'invalid', version: null, percent: null, message: null},
            {phase: 'idle', origin: 'auto', reason: 'not-a-reason', version: null, percent: null, message: null},
            {phase: 'downloading', origin: 'auto', version: '1.0.0', percent: 101, message: null},
            {phase: 'downloading', origin: 'auto', version: '1.0.0', percent: Number.NaN, message: null},
            {phase: 'idle', origin: 'auto', version: 'x'.repeat(129), percent: null, message: null},
            {phase: 'idle', origin: 'auto', version: '1.0.0', percent: null, message: 'm'.repeat(4_097)},
            {phase: 'idle', origin: 'auto', version: '1.0.0', percent: null, message: null, requestedHere: 'yes'},
        ];

        for (const sample of samples) {
            expect(decodePreloadAppUpdateStatus(sample)).toEqual(decodeAppUpdateStatus(sample));
        }
    });

    it('matches decodeHostEnvironmentSnapshot on valid and invalid host snapshots', () => {
        const samples: unknown[] = [
            {platform: 'darwin', osScaleFactor: 2},
            {platform: 'win32', osScaleFactor: 1.5},
            {platform: 'linux', osScaleFactor: 1},
            null,
            {platform: 'freebsd', osScaleFactor: 1},
            {platform: 'darwin', osScaleFactor: 0},
            {platform: 'darwin', osScaleFactor: -1},
            {platform: 'darwin', osScaleFactor: 8.5},
            {platform: 'darwin', osScaleFactor: Number.POSITIVE_INFINITY},
        ];

        for (const sample of samples) {
            expect(decodePreloadHostEnvironmentSnapshot(sample)).toEqual(decodeHostEnvironmentSnapshot(sample));
        }
    });

    it('covers every platform feature method that defines client.mapArgs', () => {
        const contractChannelsWithMapArgs = new Set<string>();
        for (const exported of Object.values(preloadPlatformFeatures)) {
            if (!exported || typeof exported !== 'object' || !('methods' in exported)) {
                continue;
            }
            for (const method of Object.values(exported.methods) as Array<{channel: string; client?: {mapArgs?: unknown}}>) {
                if (typeof method.client?.mapArgs === 'function') {
                    contractChannelsWithMapArgs.add(method.channel);
                }
            }
        }
        expect(new Set(Object.keys(PRELOAD_METHOD_ARG_MAPPERS))).toEqual(contractChannelsWithMapArgs);

        // Verify exact wire arg transformations, projection of extra non-cloneable options,
        // and repeated/circular Vue-proxy-safe deep cloning.
        expect(
            PRELOAD_METHOD_ARG_MAPPERS['pdf:search']!('/tmp/doc.pdf', 'needle', {
                matchCase: true,
                extraCallback: () => 'strip-me',
            }),
        ).toEqual([{pdfPath: '/tmp/doc.pdf', query: 'needle', matchCase: true}]);
        expect(PRELOAD_METHOD_ARG_MAPPERS['pdf:search:cancel']!(undefined)).toEqual([undefined]);
        expect(PRELOAD_METHOD_ARG_MAPPERS['djvu:text:search']!('/tmp/doc.djvu', 'needle', {matchCase: true})).toEqual([
            '/tmp/doc.djvu',
            'needle',
            {matchCase: true, wholeWord: false, useRegex: false},
        ]);
        const sharedProxy = new Proxy({nested: [1, 2], flag: true}, {});
        const plain = toPlainIpcValue({first: sharedProxy, second: sharedProxy}) as {first: unknown; second: unknown};
        expect(plain).toEqual({
            first: {nested: [1, 2], flag: true},
            second: {nested: [1, 2], flag: true},
        });
        expect(plain.first).not.toBe(sharedProxy);
        expect(plain.second).not.toBe(sharedProxy);
        expect(plain.first).toBe(plain.second);
        expect(() => structuredClone(plain)).not.toThrow();
    });
});

describe('windowTitleHandler no-op skip', () => {
    it('skips setTitle and menu refresh when the resolved window title is unchanged', async () => {
        const setTitle = vi.fn();
        const refreshMenu = vi.fn();
        const getTitle = vi.fn(() => 'EVB Viewer');
        vi.resetModules();
        vi.doMock('@electron/menu', () => ({refreshMenu}));
        vi.doMock('@electron/te', () => ({te: (key: string) => (key === 'app.title' ? 'EVB Viewer' : key)}));
        try {
            const {handleSetWindowTitle} = await import('@electron/features/documents/main/windowTitleHandler');
            const context = {window: {getTitle, setTitle}};

            handleSetWindowTitle(context as unknown as Parameters<typeof handleSetWindowTitle>[0], '');
            expect(setTitle).not.toHaveBeenCalled();
            expect(refreshMenu).not.toHaveBeenCalled();

            handleSetWindowTitle(context as unknown as Parameters<typeof handleSetWindowTitle>[0], 'Sample.pdf - EVB Viewer');
            expect(setTitle).toHaveBeenCalledWith('Sample.pdf - EVB Viewer');
            expect(refreshMenu).toHaveBeenCalledOnce();
        } finally {
            vi.doUnmock('@electron/menu');
            vi.doUnmock('@electron/te');
        }
    });
});

describe('findUnshownUnsavedDirectories', () => {
    function createMockPort(files: Record<string, Uint8Array>, docDirs: string[]): IStorePort {
        return {
            list: vi.fn(async (dir: string) => (dir === DOCUMENTS_DIR ? docDirs : [])),
            read: vi.fn(async (path: string) => {
                const bytes = files[path];
                if (!bytes) {
                    throw Object.assign(new Error(`ENOENT: ${path}`), {code: 'ENOENT'});
                }
                return bytes;
            }),
            writeAtomic: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
        } as unknown as IStorePort;
    }

    it('skips collection GC for clean, open-only, and dirty-only directories without interrupted publishes', async () => {
        const files: Record<string, Uint8Array> = {
            [`${DOCUMENTS_DIR}/clean-doc/${MANIFEST_NAME}`]: encodeJson({
                version: 1,
                ext: 'pdf',
                next: 2,
                history: [],
                destination: '/tmp/clean.pdf',
                baseline: 'w1',
                current: {id: 1, file: 'r1.pdf', length: 10, witness: 'w1'},
            }),
            [`${DOCUMENTS_DIR}/open-only/${MANIFEST_NAME}`]: encodeJson({
                version: 1,
                ext: 'pdf',
                next: 2,
                history: [],
                destination: '/tmp/open.pdf',
                baseline: 'w1',
                current: {id: 1, file: 'r1.pdf', length: 10, witness: 'w2', openOnly: true},
            }),
            [`${DOCUMENTS_DIR}/dirty-doc/${MANIFEST_NAME}`]: encodeJson({
                version: 1,
                ext: 'pdf',
                next: 2,
                history: [],
                destination: '/tmp/dirty.pdf',
                baseline: 'w1',
                current: {id: 1, file: 'r1.pdf', length: 10, witness: 'w2'},
            }),
        };
        const settleViaCollection = vi.fn(async () => ['should-not-run']);
        const result = await findUnshownUnsavedDirectories({
            port: createMockPort(files, ['clean-doc', 'open-only', 'dirty-doc']),
            shownDirectories: new Set(),
            heldDirectories: new Set(),
            referencesKnown: true,
            settleViaCollection,
        });

        expect(result).toEqual(['dirty-doc']);
        expect(settleViaCollection).not.toHaveBeenCalled();
    });

    it('delegates to collection settlement when an unshown directory has a pendingPublish', async () => {
        const files: Record<string, Uint8Array> = {
            [`${DOCUMENTS_DIR}/interrupted/${MANIFEST_NAME}`]: encodeJson({
                version: 1,
                ext: 'pdf',
                next: 2,
                history: [],
                destination: '/tmp/interrupted.pdf',
                baseline: 'w1',
                pendingPublish: {destination: '/tmp/interrupted.pdf', witness: 'w2'},
            }),
        };
        const settleViaCollection = vi.fn(async () => ['interrupted', 'already-shown']);
        const result = await findUnshownUnsavedDirectories({
            port: createMockPort(files, ['interrupted']),
            shownDirectories: new Set(['already-shown']),
            heldDirectories: new Set(),
            referencesKnown: true,
            settleViaCollection,
        });

        expect(settleViaCollection).toHaveBeenCalledOnce();
        expect(result).toEqual(['interrupted']);
    });

    it('returns an empty list without throwing when listing documents fails with EIO', async () => {
        const settleViaCollection = vi.fn(async () => ['should-not-run']);
        const failingPort = {
            list: vi.fn(async () => {
                throw Object.assign(new Error('EIO: input/output error'), {code: 'EIO'});
            }),
            read: vi.fn(),
            writeAtomic: vi.fn(),
            remove: vi.fn(),
        } as unknown as IStorePort;

        const result = await findUnshownUnsavedDirectories({
            port: failingPort,
            shownDirectories: new Set(),
            heldDirectories: new Set(),
            referencesKnown: true,
            settleViaCollection,
        });

        expect(result).toEqual([]);
        expect(settleViaCollection).not.toHaveBeenCalled();
    });
});

describe('keptOriginalNotices read batching', () => {
    it('batches repeated findKeptOriginal lookups within withKeptOriginalReadBatch into one read', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'evb-kept-batch-'));
        try {
            const originalPath = join(dir, 'a.pdf');
            const keptPath = join(dir, 'a.kept.pdf');
            await writeFile(keptPath, 'pdf-bytes');
            vi.resetModules();
            vi.doMock('electron', () => ({app: {getPath: () => dir}}));
            const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            const readFileSpy = vi.fn(actualFsPromises.readFile);
            vi.doMock('node:fs/promises', () => ({
                ...actualFsPromises,
                readFile: readFileSpy,
            }));
            const {findKeptOriginal, rememberKeptOriginal, withKeptOriginalReadBatch} =
                await import('@electron/file-access/keptOriginalNotices');
            await rememberKeptOriginal(originalPath, keptPath);

            readFileSpy.mockClear();
            const [first, second, missing] = await withKeptOriginalReadBatch(() =>
                Promise.all([findKeptOriginal(originalPath), findKeptOriginal(originalPath), findKeptOriginal(join(dir, 'b.pdf'))]),
            );

            expect(first).toBe(keptPath);
            expect(second).toBe(keptPath);
            expect(missing).toBeUndefined();
            const noticeReads = readFileSpy.mock.calls.filter(([target]) => String(target).endsWith('kept-original-notices.json'));
            expect(noticeReads).toHaveLength(1);
        } finally {
            vi.doUnmock('node:fs/promises');
            vi.doUnmock('electron');
            await rm(dir, {recursive: true, force: true});
        }
    });
});
