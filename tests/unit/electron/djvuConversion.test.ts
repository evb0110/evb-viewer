import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runDjvuEngine: vi.fn(),
    runNativeCommand: vi.fn(),
    cancelNativeCommandGroup: vi.fn(),
    resolveNativeToolPath: vi.fn(),
    runPageStructureCommand: vi.fn(),
    hostTier: 'high' as 'low' | 'medium' | 'high',
    logicalCpus: 8,
}));

vi.mock('electron', () => ({app: {
    getPath: () => tmpdir(),
    isPackaged: false,
}}));
vi.mock('@electron/features/djvu/main/djvuEnginePool', () => ({runDjvuEngine: mocks.runDjvuEngine}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({
    runNativeCommand: mocks.runNativeCommand,
    cancelNativeCommandGroup: mocks.cancelNativeCommandGroup,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: mocks.resolveNativeToolPath}));
vi.mock('@electron/features/page-ops/publicNative', () => ({runPageStructureCommand: mocks.runPageStructureCommand}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    tier: mocks.hostTier,
    logicalCpus: mocks.logicalCpus,
    performanceMode: 'auto',
})}));

const {
    cancelConversion,
    convertDjvuToPdfFile,
    renderDjvuPageToImage,
    resolveDjvuRangeWorkerCount,
    runRegisteredDjvuProcess,
} = await import('@electron/features/djvu/main/ddjvuConversion');

describe('resolveDjvuRangeWorkerCount', () => {
    it('does not clamp a two-core host up to two conversion workers', () => {
        expect(resolveDjvuRangeWorkerCount(100, 2, 'high')).toBe(1);
    });

    it('keeps one core free and respects the page count', () => {
        expect(resolveDjvuRangeWorkerCount(4, 8, 'high')).toBe(4);
        expect(resolveDjvuRangeWorkerCount(100, 8, 'high')).toBe(7);
        expect(resolveDjvuRangeWorkerCount(100, 32, 'high')).toBe(12);
    });

    it('clamps low-tier range conversion to one worker', () => {
        expect(resolveDjvuRangeWorkerCount(100, 8, 'low')).toBe(1);
    });
});

describe('ddjvuConversion (DjVuLibre WASM + evb-pdf-image-combine)', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.hostTier = 'high';
        mocks.logicalCpus = 8;
        mocks.resolveNativeToolPath.mockReturnValue('/tools/evb-pdf-image-combine');
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-conversion-test-'));
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('renders requested DjVu page modes through the DjVuLibre WASM engine pool', async () => {
        const outputPath = join(tempDir, 'mask.pbm');
        mocks.runDjvuEngine.mockImplementationOnce(async (request: {
            type: string;
            outputPath: string;
        }) => {
            expect(request).toMatchObject({
                type: 'renderPageToFile',
                djvuPath: '/tmp/book.djvu',
                pageNumber: 3,
                outputPath,
                options: {
                    format: 'pbm',
                    mode: 'mask',
                    subsample: 2,
                },
            });
            await writeFile(request.outputPath, Buffer.from('P4\n8 1\n\xff', 'binary'));
            return {
                width: 8,
                height: 1,
                present: true,
            };
        });

        const result = await renderDjvuPageToImage('/tmp/book.djvu', outputPath, 3, 'job-render', {
            format: 'pbm',
            mode: 'mask',
            subsample: 2,
        });

        expect(result).toEqual({
            success: true,
            outputPath,
            fileSize: 8,
        });
    });

    it('converts selected pages via DjVuLibre WASM rasters and native evb-pdf-image-combine', async () => {
        const outputPath = join(tempDir, 'direct.pdf');
        const progressValues: number[] = [];
        let capturedManifest = '';

        mocks.runDjvuEngine.mockImplementation(async (request: {
            type: string;
            pageNumber?: number;
            outputPath?: string;
        }) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 5,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            if (request.type === 'getPageSizes') {
                return [
                    {
                        width: 600,
                        height: 900,
                        dpi: 300,
                    },
                    {
                        width: 1200,
                        height: 1600,
                        dpi: 150,
                    },
                ];
            }
            if (request.type === 'renderPageToFile') {
                await writeFile(request.outputPath!, Buffer.from('P6\n2 2\n255\n0123456789ab', 'binary'));
                return {
                    width: 2,
                    height: 2,
                    present: true,
                };
            }
            throw new Error(`Unexpected request: ${request.type}`);
        });

        mocks.runNativeCommand.mockImplementationOnce(async (
            _command: string,
            args: string[],
            options: { onStdout?: (chunk: string) => void },
        ) => {
            const manifestPath = args[args.indexOf('--compact-manifest') + 1]!;
            capturedManifest = await readFile(manifestPath, 'utf8');
            options.onStdout?.('{"type":"progress","processed":2,"total":2,"percent":100,"elapsedMs":1,"estimatedRemainingMs":0}\n');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.4\n%%EOF\n', 'utf8');
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        const result = await convertDjvuToPdfFile('/tmp/book.djvu', outputPath, 'job-direct', {
            pages: '2,4',
            subsample: 2,
            onProgress: percent => progressValues.push(percent),
        });

        expect(result).toMatchObject({
            success: true,
            outputPath,
        });
        expect(result.fileSize).toBeGreaterThan(0);
        const lines = capturedManifest.trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]!)).toMatchObject({ pageCount: 2 });
        expect(lines[1]).toContain('image-jpeg\t144.0000\t216.0000\t92\t');
        expect(lines[2]).toContain('image-jpeg\t576.0000\t768.0000\t92\t');
        expect(progressValues.at(-1)).toBe(94);
    });

    it('uses lossless image manifest entries for Full Quality (subsample 1) and batches large exports to release scratch PPMs', async () => {
        const outputPath = join(tempDir, 'batched-full.pdf');
        const capturedManifests: string[] = [];
        const batchPpmPaths: string[][] = [];

        mocks.runDjvuEngine.mockImplementation(async (request: {
            type: string;
            pageNumber?: number;
            outputPath?: string;
        }) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 26,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            if (request.type === 'getPageSizes') {
                return Array.from({ length: 26 }, () => ({
                    width: 600,
                    height: 900,
                    dpi: 300,
                }));
            }
            if (request.type === 'renderPageToFile') {
                await writeFile(request.outputPath!, Buffer.from('P6\n2 2\n255\n0123456789ab', 'binary'));
                return {
                    width: 2,
                    height: 2,
                    present: true,
                };
            }
            throw new Error(`Unexpected request: ${request.type}`);
        });

        mocks.runNativeCommand.mockImplementation(async (_command: string, args: string[]) => {
            const manifestPath = args[args.indexOf('--compact-manifest') + 1]!;
            const manifest = await readFile(manifestPath, 'utf8');
            capturedManifests.push(manifest);
            const ppmPaths = manifest
                .trim()
                .split('\n')
                .slice(1)
                .map(line => line.split('\t').at(-1)!);
            batchPpmPaths.push(ppmPaths);
            if (batchPpmPaths.length === 2) {
                // Batch 1 PPMs must already be unlinked before batch 2 combines.
                const { existsSync } = await import('node:fs');
                expect(batchPpmPaths[0]!.every(ppm => !existsSync(ppm))).toBe(true);
            }
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.4\n%%EOF\n', 'utf8');
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        mocks.runPageStructureCommand.mockImplementationOnce(async (
            command: string,
            firstChunk: string,
            finalOutput: string,
            args: { sources?: string[] },
        ) => {
            expect(command).toBe('merge-pages');
            expect(firstChunk).toContain('direct-chunk-0001.pdf');
            expect(args.sources).toHaveLength(1);
            expect(args.sources?.[0]).toContain('direct-chunk-0002.pdf');
            await writeFile(finalOutput, '%PDF-1.4\n%merged\n%%EOF\n', 'utf8');
        });

        const result = await convertDjvuToPdfFile('/tmp/book.djvu', outputPath, 'job-batched', {
            subsample: 1,
        });

        expect(result).toMatchObject({
            success: true,
            outputPath,
        });
        expect(capturedManifests).toHaveLength(2);
        const batch1Lines = capturedManifests[0]!.trim().split('\n');
        const batch2Lines = capturedManifests[1]!.trim().split('\n');
        expect(JSON.parse(batch1Lines[0]!)).toMatchObject({ pageCount: 24 });
        expect(JSON.parse(batch2Lines[0]!)).toMatchObject({ pageCount: 2 });
        expect(batch1Lines[1]).toMatch(/^image\t144\.0000\t216\.0000\t/);
        expect(batch2Lines[1]).toMatch(/^image\t144\.0000\t216\.0000\t/);
        expect(mocks.runPageStructureCommand).toHaveBeenCalledTimes(1);
    });

    it('cancels active WASM conversion jobs and registered child processes by parent job prefix', async () => {
        const started = Promise.withResolvers<undefined>();
        let observedSignal: AbortSignal | undefined;

        mocks.runDjvuEngine.mockImplementationOnce(async (_request: unknown, options?: { signal?: AbortSignal }) => {
            observedSignal = options?.signal;
            started.resolve(undefined);
            await new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
            });
        });

        const renderPromise = renderDjvuPageToImage('/tmp/book.djvu', join(tempDir, 'canceled.ppm'), 1, 'job-parent-page-1');
        await started.promise;

        const processStarted = Promise.withResolvers<undefined>();
        const releaseProcess = Promise.withResolvers<undefined>();
        mocks.runNativeCommand.mockImplementationOnce(async () => {
            processStarted.resolve(undefined);
            await releaseProcess.promise;
            throw new Error('killed');
        });
        const procPromise = runRegisteredDjvuProcess('job-parent-combine', '/tools/evb-pdf-image-combine', []);
        await processStarted.promise;

        const canceled = await cancelConversion('job-parent');
        releaseProcess.resolve(undefined);

        expect(canceled).toBe(true);
        expect(observedSignal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith('job-parent-combine');
        await expect(renderPromise).resolves.toMatchObject({
            success: false,
            error: 'DjVu conversion canceled',
        });
        await expect(procPromise).resolves.toMatchObject({
            success: false,
            error: 'DjVu conversion canceled',
        });
    });
});
