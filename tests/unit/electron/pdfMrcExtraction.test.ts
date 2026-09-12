import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import {tmpdir} from 'os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {extractPdfMrcLayersBatch} from '@evb/scan-cleanup/adapters/extractPdfMrcLayers';
import type {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

const scratchDirectories: string[] = [];

async function createScratch() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-mrc-extraction-test-'));
    scratchDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(scratchDirectories.splice(0).map(directory =>
        rm(directory, {
            recursive: true,
            force: true,
        }),
    ));
});

describe('batched PDF MRC extraction', () => {
    it('preserves compact layers and asks qpdf only for the mask dictionaries it needs', async () => {
        const scratch = await createScratch();
        const progress: Array<[number, number]> = [];
        let activeListings = 0;
        let peakListings = 0;
        const qpdfSelectorCounts: number[] = [];
        const runCommand = vi.fn<typeof runNativeToolCommand>(async (command, args) => {
            if (command === '/qpdf') {
                const objectTable: Record<string, unknown> = {
                    'obj:2 0 R': {stream: {dict: {'/SMask': '20 0 R'}}},
                    'obj:20 0 R': {stream: {dict: {
                        '/BitsPerComponent': 1,
                        '/Decode': [
                            1,
                            0,
                        ],
                        '/Filter': '/JBIG2Decode',
                    }}},
                    'obj:4 0 R': {stream: {dict: {'/SMask': '40 0 R'}}},
                    'obj:40 0 R': {stream: {dict: {
                        '/BitsPerComponent': 1,
                        '/Filter': '/JBIG2Decode',
                    }}},
                };
                // qpdf emits only the objects the selectors name, so the mock
                // does the same: a lookup that still relied on the whole table
                // would come back empty here.
                const requested = args.flatMap((arg) => {
                    const parsed = /^--json-object=(\d+),(\d+)$/u.exec(arg);
                    return parsed === null ? [] : [`obj:${parsed[1]!} ${parsed[2]!} R`];
                });
                qpdfSelectorCounts.push(requested.length);
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: JSON.stringify({qpdf: [
                        {jsonversion: 2},
                        Object.fromEntries(
                            requested.flatMap(key =>
                                key in objectTable ? [[
                                    key,
                                    objectTable[key],
                                ]] : [],
                            ),
                        ),
                    ]}),
                };
            }
            if (args.includes('-list')) {
                activeListings += 1;
                peakListings = Math.max(peakListings, activeListings);
                await Promise.resolve();
                activeListings -= 1;
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                        '11 0 image 706 1066 rgb 3 8 jpx no 1 0 120 120 1K 1%',
                        '11 1 image 2120 3202 rgb 3 8 jpx no 2 0 360 360 1K 1%',
                        '11 2 smask 2120 3202 gray 1 1 jbig2 no 2 0 360 360 1K 1%',
                        '35 3 image 706 1066 rgb 3 8 jpx no 3 0 120 120 1K 1%',
                        '35 4 image 2120 3202 rgb 3 8 jpx no 4 0 360 360 1K 1%',
                        '35 5 smask 2120 3202 gray 1 1 jbig2 no 4 0 360 360 1K 1%',
                    ].join('\n'),
                };
            }
            if (args.includes('-all')) {
                const prefix = args.at(-1)!;
                await Promise.all([
                    writeFile(`${prefix}-000.jp2`, 'BACKGROUND-11'),
                    writeFile(`${prefix}-001.jp2`, 'FOREGROUND-11'),
                    writeFile(`${prefix}-002.jb2e`, 'MASK-11'),
                    writeFile(`${prefix}-003.jp2`, 'BACKGROUND-35'),
                    writeFile(`${prefix}-004.jp2`, 'FOREGROUND-35'),
                    writeFile(`${prefix}-005.jb2e`, 'MASK-35'),
                ]);
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (outputIndex !== -1) {
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            const decodedPrefix = args.at(-1)!;
            await writeFile(`${decodedPrefix}-1.ppm`, 'P6\n1 1\n255\n\xff\xff\xff');
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const targets = [
            11,
            35,
        ].map(pageNumber => ({
            pageNumber,
            backgroundOutputPath: join(scratch, `background-${String(pageNumber)}.ppm`),
            foregroundOutputPath: join(scratch, `foreground-${String(pageNumber)}.jp2`),
            selectionMaskOutputPath: join(scratch, `selection-${String(pageNumber)}.jb2e`),
        }));

        const result = await extractPdfMrcLayersBatch({
            pdfPath: '/source.pdf',
            targets,
            pdfimagesBinary: '/pdfimages',
            qpdfBinary: '/qpdf',
            pdfImageCombineBinary: '/combine',
            pdftoppmBinary: '/pdftoppm',
            runCommand,
            log: vi.fn(),
            rasterConcurrency: 2,
            onProgress: (completed, total) => progress.push([
                completed,
                total,
            ]),
        });

        expect([...result.keys()].sort((left, right) => left - right)).toEqual([
            11,
            35,
        ]);
        expect(runCommand).toHaveBeenCalledTimes(12);
        // Two chunks, each asking once for its foreground objects and once for
        // the masks they point at, and never for more objects than that.
        expect(runCommand.mock.calls.filter(([command]) => command === '/qpdf')).toHaveLength(4);
        expect(qpdfSelectorCounts).toEqual([
            1,
            1,
            1,
            1,
        ]);
        expect(peakListings).toBe(2);
        expect(runCommand.mock.calls.some(([
            ,
            args,
        ]) => args.includes('-png'))).toBe(false);
        expect(progress).toEqual([
            [
                1,
                2,
            ],
            [
                2,
                2,
            ],
        ]);
        expect(await readFile(targets[0]!.foregroundOutputPath, 'utf8')).toBe('FOREGROUND-11');
        expect(await readFile(targets[1]!.selectionMaskOutputPath, 'utf8')).toBe('MASK-35');
        expect(result.get(11)?.selectionMaskDecode).toBe('inverted');
        expect(result.get(35)?.selectionMaskDecode).toBe('default');
        expect(runCommand.mock.calls.some(([
            ,
            args,
        ]) => args.includes('-jpeg'))).toBe(false);
    });

    it('propagates an aborted object-table inspection without logging or caching a fallback', async () => {
        const scratch = await createScratch();
        const controller = new AbortController();
        const abortError = new DOMException('MRC inspection canceled', 'AbortError');
        const log = vi.fn();
        const runCommand = vi.fn<typeof runNativeToolCommand>(async (command, args) => {
            if (command === '/qpdf') {
                controller.abort(abortError);
                throw abortError;
            }
            if (args.includes('-list')) {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                        '1 0 image 706 1066 rgb 3 8 jpx no 1 0 120 120 1K 1%',
                        '1 1 image 2120 3202 rgb 3 8 jpx no 2 0 360 360 1K 1%',
                        '1 2 smask 2120 3202 gray 1 1 jbig2 no 2 0 360 360 1K 1%',
                    ].join('\n'),
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const extraction = extractPdfMrcLayersBatch({
            pdfPath: '/source.pdf',
            targets: [{
                pageNumber: 1,
                backgroundOutputPath: join(scratch, 'background-1.ppm'),
                foregroundOutputPath: join(scratch, 'foreground-1.jp2'),
                selectionMaskOutputPath: join(scratch, 'selection-1.jb2e'),
            }],
            pdfimagesBinary: '/pdfimages',
            qpdfBinary: '/qpdf',
            pdfImageCombineBinary: '/combine',
            pdftoppmBinary: '/pdftoppm',
            runCommand,
            log,
            rasterConcurrency: 2,
            signal: controller.signal,
        });

        await expect(extraction).rejects.toBe(abortError);
        expect(runCommand.mock.calls.filter(([command]) => command === '/qpdf')).toHaveLength(1);
        expect(log).not.toHaveBeenCalledWith('warn', expect.any(String));
    });

    it('keeps successful chunks when a sibling chunk falls back', async () => {
        const scratch = await createScratch();
        const log = vi.fn();
        const progress: Array<[number, number]> = [];
        const runCommand = vi.fn<typeof runNativeToolCommand>(async (command, args) => {
            if (command === '/qpdf') {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: JSON.stringify({qpdf: [{
                        'obj:2 0 R': {stream: {dict: {'/SMask': '20 0 R'}}},
                        'obj:20 0 R': {stream: {dict: {
                            '/BitsPerComponent': 1,
                            '/Filter': '/JBIG2Decode',
                        }}},
                        'obj:4 0 R': {stream: {dict: {'/SMask': '40 0 R'}}},
                        'obj:40 0 R': {stream: {dict: {
                            '/BitsPerComponent': 1,
                            '/Filter': '/JBIG2Decode',
                        }}},
                    }]}),
                };
            }
            const firstPage = Number(args[args.indexOf('-f') + 1]);
            const objectNumber = firstPage === 1 ? 2 : 4;
            if (args.includes('-list')) {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                        `${String(firstPage)} 0 image 100 140 rgb 3 8 jpx no 1 0 100 100 1K 1%`,
                        `${String(firstPage)} 1 image 300 420 rgb 3 8 jpx no ${String(objectNumber)} 0 300 300 1K 1%`,
                        `${String(firstPage)} 2 smask 300 420 gray 1 1 jbig2 no ${String(objectNumber)} 0 300 300 1K 1%`,
                    ].join('\n'),
                };
            }
            if (args.includes('-all')) {
                if (firstPage === 30) throw new Error('chunk 30 failed');
                const prefix = args.at(-1)!;
                await Promise.all([
                    writeFile(`${prefix}-000.jp2`, 'BACKGROUND-1'),
                    writeFile(`${prefix}-001.jp2`, 'FOREGROUND-1'),
                    writeFile(`${prefix}-002.jb2e`, 'MASK-1'),
                ]);
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (outputIndex !== -1) {
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            await writeFile(`${args.at(-1)!}-1.ppm`, 'P6\n1 1\n255\n\xff\xff\xff');
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const targets = [
            1,
            30,
        ].map(pageNumber => ({
            pageNumber,
            backgroundOutputPath: join(scratch, `background-${String(pageNumber)}.ppm`),
            foregroundOutputPath: join(scratch, `foreground-${String(pageNumber)}.jp2`),
            selectionMaskOutputPath: join(scratch, `selection-${String(pageNumber)}.jb2e`),
        }));

        const result = await extractPdfMrcLayersBatch({
            pdfPath: '/source.pdf',
            targets,
            pdfimagesBinary: '/pdfimages',
            qpdfBinary: '/qpdf',
            pdfImageCombineBinary: '/combine',
            pdftoppmBinary: '/pdftoppm',
            runCommand,
            log,
            rasterConcurrency: 2,
            onProgress: (completed, total) => progress.push([
                completed,
                total,
            ]),
        });

        expect([...result.keys()]).toEqual([1]);
        expect(await readFile(targets[0]!.foregroundOutputPath, 'utf8')).toBe('FOREGROUND-1');
        expect(log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('page(s) 30'),
        );
        expect(progress.at(-1)).toEqual([
            2,
            2,
        ]);
    });
});
