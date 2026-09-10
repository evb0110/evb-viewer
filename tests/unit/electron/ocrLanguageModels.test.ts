import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { Readable } from 'node:stream';

const tessdataFixtureRoot = join(process.cwd(), 'resources', 'tesseract', 'tessdata');

const mocks = vi.hoisted(() => ({
    closeSync: vi.fn(),
    createReadStream: vi.fn(),
    existsSync: vi.fn(),
    fetch: vi.fn(),
    getOcrRuntimePolicy: vi.fn(),
    mkdir: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    readdir: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    statSync: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    installedPaths: new Set<string>(),
    fileUrl: '/tmp/app.asar/dist/electron/features/ocr/languageModels.js',
    app: {
        isPackaged: true,
        getPath: vi.fn(),
    },
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: mocks.app}));
vi.mock('os', () => ({homedir: () => '/tmp/home'}));
vi.mock('url', () => ({fileURLToPath: () => mocks.fileUrl}));
vi.mock('fs', async importOriginal => {
    const actual = await importOriginal();
    return {
        ...actual,
        closeSync: (...args: unknown[]) => mocks.closeSync(...args),
        createReadStream: (...args: unknown[]) => mocks.createReadStream(...args),
        createWriteStream: vi.fn(),
        existsSync: (path: string) => mocks.existsSync(path),
        openSync: (...args: unknown[]) => mocks.openSync(...args),
        readSync: (...args: unknown[]) => mocks.readSync(...args),
        statSync: (...args: unknown[]) => mocks.statSync(...args),
    };
});
vi.mock('fs/promises', () => ({
    copyFile: (...args: unknown[]) => mocks.copyFile(...args),
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    readdir: (...args: unknown[]) => mocks.readdir(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
    stat: vi.fn(),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/features/ocr/main/ocrRuntimePolicy', () => ({getOcrRuntimePolicy: () => mocks.getOcrRuntimePolicy()}));

describe('ensureRuntimeTessdataSeeded', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.installedPaths.clear();
        mocks.fileUrl = '/tmp/app.asar/dist/electron/features/ocr/languageModels.js';
        mocks.app.isPackaged = true;
        mocks.app.getPath.mockReturnValue('/tmp/electron-user-data');
        mocks.getOcrRuntimePolicy.mockReturnValue({
            globalPageSlots: 3,
            workerPoolSize: 2,
            modelDownloadConcurrency: 3,
        });
        Object.defineProperty(process, 'resourcesPath', {
            configurable: true,
            value: '/tmp/resources',
        });
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.existsSync.mockImplementation((path: string) =>
            path === '/tmp/resources/tesseract/tessdata'
            || path.startsWith('/tmp/resources/tesseract/tessdata/')
            || path.includes('.traineddata.seed-')
            || path.includes('.traineddata.restore-')
            || path.includes('.traineddata.download-')
            || mocks.installedPaths.has(path),
        );
        mocks.openSync.mockReturnValue(10);
        mocks.closeSync.mockReturnValue(undefined);
        mocks.statSync.mockReturnValue({
            isFile: () => true,
            size: 4096,
        });
        mocks.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
            buffer.writeUInt32LE(1, 0);
            buffer.writeBigInt64LE(12n, 4);
            return 12;
        });
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.readdir.mockResolvedValue([
            'eng.traineddata',
            'rus.traineddata',
            'notes.txt',
        ]);
        mocks.createReadStream.mockImplementation((path: string) => (
            path.includes('eng.traineddata')
                ? Readable.from([readFileSync(join(tessdataFixtureRoot, 'eng.traineddata'))])
                : path.includes('rus.traineddata')
                    ? Readable.from([readFileSync(join(tessdataFixtureRoot, 'rus.traineddata'))])
                    : undefined
        ));
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.rename.mockImplementation(async (_source: string, destination: string) => {
            mocks.installedPaths.add(destination);
        });
        mocks.writeFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('shares one async seed across concurrent callers', async () => {
        const {
            ensureRuntimeTessdataSeeded,
            getRuntimeTessdataDir,
        } = await import('@electron/features/ocr/languageModels');
        const runtimeDir = getRuntimeTessdataDir();

        await Promise.all([
            ensureRuntimeTessdataSeeded(),
            ensureRuntimeTessdataSeeded(),
        ]);
        await ensureRuntimeTessdataSeeded();

        expect(mocks.readdir).toHaveBeenCalledTimes(1);
        expect(mocks.mkdir).toHaveBeenCalledTimes(1);
        expect(mocks.copyFile).toHaveBeenCalledTimes(2);
        expect(mocks.copyFile.mock.calls.map(call => call[0])).toEqual([
            '/tmp/resources/tesseract/tessdata/eng.traineddata',
            '/tmp/resources/tesseract/tessdata/rus.traineddata',
        ]);
        expect(mocks.copyFile.mock.calls.every(call => (
            typeof call[1] === 'string'
            && call[1].startsWith(join(runtimeDir, ''))
            && call[1].includes('.seed-')
        ))).toBe(true);
        expect(mocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/\.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec-[a-f0-9]+\..+[.]tmp$/u),
            expect.stringContaining('"bundledFiles":["eng.traineddata","rus.traineddata"]'),
            {
                encoding: 'utf8',
                mode: 0o600,
            },
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/[.]tmp$/u),
            expect.stringContaining('.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec'),
        );
    });

    it('skips reseeding when the packaged resource version is current', async () => {
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/tmp/resources/tesseract/tessdata'
            || path.includes('.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec')
        ));
        const {ensureRuntimeTessdataSeeded} = await import('@electron/features/ocr/languageModels');

        await ensureRuntimeTessdataSeeded();

        expect(mocks.readdir).toHaveBeenCalledOnce();
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('restores a missing packaged model after a current seed marker without downloading', async () => {
        const runtimeModelPath = '/tmp/electron-user-data/tessdata/eng.traineddata';
        const stagingModelPath = /\/tmp\/electron-user-data\/tessdata\/eng\.traineddata\.(?:seed|restore)-/u;
        let installed = false;
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/tmp/resources/tesseract/tessdata'
            || path === '/tmp/resources/tesseract/tessdata/eng.traineddata'
            || path.includes('.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec')
            || stagingModelPath.test(path)
            || (path === runtimeModelPath && installed)
        ));
        mocks.rename.mockImplementation(async (_source: string, destination: string) => {
            if (destination === runtimeModelPath) {
                installed = true;
            }
        });

        const {ensureTessdataLanguages} = await import('@electron/features/ocr/languageModels');
        await ensureTessdataLanguages(['eng']);

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/resources/tesseract/tessdata/eng.traineddata',
            expect.stringMatching(stagingModelPath),
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(stagingModelPath),
            runtimeModelPath,
        );
    });

    it('falls through to the validated download when the packaged model is unavailable', async () => {
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/tmp/resources/tesseract/tessdata'
            || path.includes('.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec')
        ));
        mocks.fetch.mockRejectedValue(Object.assign(
            new Error('getaddrinfo EAI_AGAIN raw.githubusercontent.com'),
            {code: 'EAI_AGAIN'},
        ));

        const {ensureTessdataLanguages} = await import('@electron/features/ocr/languageModels');
        await expect(ensureTessdataLanguages(['eng'])).rejects.toMatchObject({code: 'NETWORK_UNREACHABLE'});
        expect(mocks.fetch).toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalledWith(
            expect.stringContaining('.traineddata.restore-'),
            expect.any(String),
        );
    });

    it('reclaims a failed seed staging file and retries the packaged copy', async () => {
        const runtimeModelPath = '/tmp/electron-user-data/tessdata/eng.traineddata';
        const stagingModelPath = /\/tmp\/electron-user-data\/tessdata\/eng\.traineddata\.(?:seed|restore)-/u;
        let installed = false;
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/tmp/resources/tesseract/tessdata'
            || path === '/tmp/resources/tesseract/tessdata/eng.traineddata'
            || path.includes('.evb-seeded-e12c65a915945e4c28e237a9b52bc4a8f39a0cec')
            || stagingModelPath.test(path)
            || (path === runtimeModelPath && installed)
        ));
        mocks.copyFile.mockRejectedValueOnce(new Error('copy failed'));
        mocks.fetch.mockResolvedValue({
            ok: false,
            status: 404,
        });

        const {ensureTessdataLanguages} = await import('@electron/features/ocr/languageModels');
        await expect(ensureTessdataLanguages(['eng'])).rejects.toThrow('copy failed');
        expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(stagingModelPath), {force: true});

        mocks.fetch.mockReset();
        mocks.rename.mockImplementation(async (_source: string, destination: string) => {
            if (destination === runtimeModelPath) {
                installed = true;
            }
        });
        await ensureTessdataLanguages(['eng']);

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.rename).toHaveBeenCalledWith(expect.stringMatching(stagingModelPath), runtimeModelPath);
    });

    it('uses Electron userData as the packaged runtime tessdata base', async () => {
        mocks.app.getPath.mockReturnValue('/tmp/profile/user-data');
        const { getRuntimeTessdataDir } = await import('@electron/features/ocr/languageModels');

        expect(getRuntimeTessdataDir()).toBe('/tmp/profile/user-data/tessdata');
        expect(mocks.app.getPath).toHaveBeenCalledWith('userData');
    });

    it('resolves bundled tessdata from the repository resources directory in development', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        const { getRuntimeTessdataDir } = await import('@electron/features/ocr/languageModels');

        expect(getRuntimeTessdataDir()).toBe('/repo/resources/tesseract/tessdata');
    });

    it('uses a pinned tessdata_best source ref', async () => {
        const { TESSDATA_BEST_REF } = await import('@electron/features/ocr/languageModels');

        expect(TESSDATA_BEST_REF).toMatch(/^[a-f0-9]{40}$/u);
        expect(TESSDATA_BEST_REF).toBe('e12c65a915945e4c28e237a9b52bc4a8f39a0cec');
    });

    it('validates traineddata headers with a deterministic readability check', async () => {
        mocks.existsSync.mockImplementation((path: string) => path.endsWith('.traineddata'));
        const { validateTraineddataFile } = await import('@electron/features/ocr/languageModels');

        expect(validateTraineddataFile('/tmp/eng.traineddata')).toEqual({valid: true});

        mocks.readSync.mockImplementationOnce((_fd: number, buffer: Buffer) => {
            buffer.writeUInt32LE(1, 0);
            buffer.writeBigInt64LE(99_999n, 4);
            return 12;
        });

        expect(validateTraineddataFile('/tmp/bad.traineddata')).toMatchObject({
            valid: false,
            error: expect.stringContaining('out-of-range component offset'),
        });
    });

    it('hashes a model incrementally across multiple chunks', async () => {
        const chunks = [
            Buffer.from('first model chunk'),
            Buffer.from('second model chunk'),
            Buffer.from('third model chunk'),
        ];
        mocks.createReadStream.mockReturnValue(Readable.from(chunks));
        const { hashFileSha256 } = await import('@electron/features/ocr/languageModels');

        await expect(hashFileSha256('/tmp/eng.traineddata')).resolves.toBe(
            createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
        );
        expect(mocks.createReadStream).toHaveBeenCalledWith('/tmp/eng.traineddata');
    });

    it('invalidates a cached verification after a same-size in-place mutation', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        const modelPath = '/repo/resources/tesseract/tessdata/eng.traineddata';
        const originalBytes = readFileSync(join(tessdataFixtureRoot, 'eng.traineddata'));
        let modelBytes = Buffer.from(originalBytes);
        let mtimeMs = 1;
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/repo/resources/tesseract'
            || path === modelPath
        ));
        mocks.statSync.mockImplementation(() => ({
            isFile: () => true,
            size: modelBytes.length,
            mtimeMs,
            ctimeMs: mtimeMs,
            dev: 1,
            ino: 1,
        }));
        mocks.createReadStream.mockImplementation(() => Readable.from([modelBytes]));
        const {getOcrLanguageModelStates} = await import('@electron/features/ocr/languageModels');

        expect((await getOcrLanguageModelStates()).find(language => language.code === 'eng')?.state).toBe('installed');
        modelBytes = Buffer.from(originalBytes);
        modelBytes[modelBytes.length - 1] ^= 1;
        mtimeMs = 2;

        expect((await getOcrLanguageModelStates()).find(language => language.code === 'eng')?.state).toBe('missing');
        expect(mocks.createReadStream).toHaveBeenCalledTimes(2);
    });

    it('rejects a downloaded model whose streamed checksum does not match', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/repo/resources/tesseract'
            || path.includes('.traineddata.download-')
        ));
        mocks.fetch.mockResolvedValue({
            arrayBuffer: async () => Buffer.from('downloaded model bytes'),
            body: null,
            ok: true,
            status: 200,
        });
        mocks.createReadStream.mockReturnValue(Readable.from([
            Buffer.from('downloaded '),
            Buffer.from('model bytes'),
        ]));
        const { ensureTessdataLanguages } = await import('@electron/features/ocr/languageModels');

        await expect(ensureTessdataLanguages(['eng'])).rejects.toMatchObject({
            code: 'CHECKSUM_MISMATCH',
            retryable: false,
        });
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('destroys the model stream when checksum verification is aborted mid-stream', async () => {
        let resolveSecondRead: (() => void) | undefined;
        const secondReadStarted = new Promise<void>((resolve) => {
            resolveSecondRead = resolve;
        });
        let readCount = 0;
        const stream = new Readable({read() {
            if (readCount++ === 0) {
                this.push(Buffer.from('first model chunk'));
                return;
            }
            resolveSecondRead?.();
        }});
        const destroy = vi.spyOn(stream, 'destroy');
        mocks.createReadStream.mockReturnValue(stream);
        const controller = new AbortController();
        const { hashFileSha256 } = await import('@electron/features/ocr/languageModels');
        const checksumPromise = hashFileSha256('/tmp/eng.traineddata', controller.signal);

        await secondReadStarted;
        controller.abort();

        await expect(checksumPromise).rejects.toMatchObject({name: 'AbortError'});
        expect(destroy).toHaveBeenCalledWith(expect.objectContaining({name: 'AbortError'}));
    });

    it('does not publish a downloaded model after checksum verification is aborted', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => (
            path === '/repo/resources/tesseract'
            || path.includes('.traineddata.download-')
        ));
        mocks.fetch.mockResolvedValue({
            arrayBuffer: async () => Buffer.from('downloaded model bytes'),
            body: null,
            ok: true,
            status: 200,
        });
        let resolveSecondRead: (() => void) | undefined;
        const secondReadStarted = new Promise<void>((resolve) => {
            resolveSecondRead = resolve;
        });
        let readCount = 0;
        mocks.createReadStream.mockReturnValue(new Readable({read() {
            if (readCount++ === 0) {
                this.push(Buffer.from('first model chunk'));
                return;
            }
            resolveSecondRead?.();
        }}));
        const controller = new AbortController();
        const { ensureTessdataLanguages } = await import('@electron/features/ocr/languageModels');
        const downloadPromise = ensureTessdataLanguages(['eng'], {signal: controller.signal});

        await secondReadStarted;
        controller.abort();

        await expect(downloadPromise).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => {
            expect(mocks.rm).toHaveBeenCalledWith(
                expect.stringContaining('.traineddata.download-'),
                {force: true},
            );
        });
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('uses the OCR runtime policy to cap downloads across concurrent callers', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        mocks.getOcrRuntimePolicy.mockReturnValue({
            globalPageSlots: 1,
            workerPoolSize: 1,
            modelDownloadConcurrency: 1,
        });
        let resolveGetStarted: (() => void) | undefined;
        const getStarted = new Promise<void>((resolve) => {
            resolveGetStarted = resolve;
        });
        mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'HEAD') {
                return {
                    ok: true,
                    status: 200,
                };
            }

            resolveGetStarted?.();
            return new Promise((_resolve, reject) => {
                const signal = init?.signal;
                signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });
        const firstController = new AbortController();
        const secondController = new AbortController();
        const { ensureTessdataLanguages } = await import('@electron/features/ocr/languageModels');
        const firstDownload = ensureTessdataLanguages(['eng'], {signal: firstController.signal});
        const secondDownload = ensureTessdataLanguages(['deu'], {signal: secondController.signal});

        await getStarted;
        await new Promise(resolve => setImmediate(resolve));

        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        firstController.abort();
        secondController.abort();
        await expect(firstDownload).rejects.toMatchObject({name: 'AbortError'});
        await expect(secondDownload).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.getOcrRuntimePolicy).toHaveBeenCalled();
    });

    it('treats offline model downloads as retryable after precheck', async () => {
        mocks.fileUrl = '/repo/electron/features/ocr/languageModels.ts';
        mocks.app.isPackaged = false;
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        mocks.existsSync.mockImplementation((path: string) => path === '/repo/resources/tesseract');
        const offlineError = Object.assign(new Error('getaddrinfo EAI_AGAIN raw.githubusercontent.com'), {code: 'EAI_AGAIN'});
        mocks.fetch.mockRejectedValue(offlineError);

        const { ensureTessdataLanguages } = await import('@electron/features/ocr/languageModels');

        await expect(ensureTessdataLanguages(['eng'])).rejects.toMatchObject({
            retryable: true,
            code: 'NETWORK_UNREACHABLE',
        });
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
        expect(String(mocks.fetch.mock.calls[0]?.[0])).toContain(
            'raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/eng.traineddata',
        );
    });
});
