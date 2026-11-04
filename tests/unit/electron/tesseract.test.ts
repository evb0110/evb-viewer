import type * as TViMockOriginalModule from '@ocr-core/resolveTesseractLanguageConfig';

import { EventEmitter } from 'node:events';
import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class MockStdin extends EventEmitter {
    public end = vi.fn((_buffer: Buffer, callback?: (error?: Error | null) => void) => {
        this.endCallback = callback;
    });

    public endCallback: ((error?: Error | null) => void) | undefined;
}

class MockChildProcess extends EventEmitter {
    public stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
    public stderr = new EventEmitter();
    public stdin: MockStdin | undefined;
    public kill = vi.fn((_signal: string) => true);
}

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
    spawn: vi.fn(),
    ensureTessdataLanguages: vi.fn(),
    resolveTesseractLanguageConfig: vi.fn(),
}));

vi.mock('child_process', () => ({
    execFile: mocks.execFile,
    spawn: mocks.spawn,
}));
vi.mock('@electron/features/ocr/languageModels', () => ({ensureTessdataLanguages: mocks.ensureTessdataLanguages}));
vi.mock('@ocr-core/resolveTesseractLanguageConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    resolveTesseractLanguageConfig: mocks.resolveTesseractLanguageConfig,
}));

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

describe('Tesseract TSV geometry parsing', () => {
    it('uses line-level vertical geometry for word boxes', async () => {
        const { parseTsvOutput } = await import('@ocr-core/tesseractTsv');
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t40\t160\t50\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t55\t70\t20\t92\tTITLE',
            '5\t1\t1\t1\t1\t2\t90\t65\t40\t12\t91\tword',
        ].join('\n');

        expect(parseTsvOutput(tsv)).toEqual([
            {
                text: 'TITLE',
                x: 10,
                y: 40,
                width: 70,
                height: 50,
            },
            {
                text: 'word',
                x: 90,
                y: 40,
                width: 40,
                height: 50,
            },
        ]);
    });

    it('parses words and page text from a single TSV pass result', async () => {
        const { parseTsvOcrData } = await import('@ocr-core/tesseractTsv');
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t40\t160\t50\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t55\t70\t20\t92\tFirst',
            '5\t1\t1\t1\t1\t2\t90\t65\t40\t12\t18\tfaint',
            '4\t1\t1\t1\t2\t0\t10\t110\t160\t30\t-1\t',
            '5\t1\t1\t1\t2\t1\t10\t115\t80\t12\t95\tSecond',
        ].join('\n');

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [
                {
                    text: 'First',
                    x: 10,
                    y: 40,
                    width: 70,
                    height: 50,
                },
                {
                    text: 'Second',
                    x: 10,
                    y: 110,
                    width: 80,
                    height: 30,
                },
            ],
            text: 'First faint\nSecond',
        });
    });

    it('rejects TSV structures before unbounded row, word, or text accumulation', async () => {
        const { parseTsvOcrData } = await import('@ocr-core/tesseractTsv');
        const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
        const rows = [
            '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tone',
            '5\t1\t1\t1\t1\t2\t10\t0\t10\t10\t90\ttwo',
        ];

        expect(() => parseTsvOcrData([
            header,
            ...rows,
        ].join('\n'), {maxRows: 1}))
            .toThrow('1-row limit');
        expect(() => parseTsvOcrData([
            header,
            ...rows,
        ].join('\n'), {maxWords: 1}))
            .toThrow('1-word limit');
        expect(() => parseTsvOcrData([
            header,
            rows[0]!,
        ].join('\n'), {maxTextCharacters: 2}))
            .toThrow('2-character text limit');
        expect(() => parseTsvOcrData([
            header,
            '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\ta',
            '5\t1\t1\t1\t2\t1\t0\t10\t10\t10\t90\tb',
        ].join('\n'), {maxTextCharacters: 2}))
            .toThrow('2-character text limit');
        expect(() => parseTsvOcrData([
            header,
            rows[0]!,
        ].join('\n'), {maxInputCharacters: 4}))
            .toThrow('parser input limit');
    });
});

describe('file-based Tesseract arguments', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        mocks.resolveTesseractLanguageConfig.mockReturnValue({
            orderedLanguages: ['eng'],
            extraConfigArgs: [
                '-c',
                'preserve_interword_spaces=1',
            ],
        });
    });

    it('reports parameters the engine rejected while still exiting successfully', async () => {
        const { findUnsupportedTesseractOptions } = await import('@ocr-core/tesseractRecipe');
        const stderr = [
            'Estimating resolution as 300',
            'Could not set option: thresholding_method=2',
            'Warning: Invalid resolution 0 dpi. Using 70 instead.',
        ].join('\n');

        expect(findUnsupportedTesseractOptions(stderr)).toEqual(['thresholding_method=2']);
        expect(findUnsupportedTesseractOptions('Estimating resolution as 300\n')).toEqual([]);
    });

    it('adds public quality profile options without removing existing output config', async () => {
        const child = new MockChildProcess();
        mocks.spawn.mockReturnValue(child);

        const { runOcrFileBased } = await import('@electron/features/ocr/pipeline/tesseractRunner');
        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            1000,
            1500,
            300,
            '/mock/tesseract',
            '/mock/tessdata',
            1,
            undefined,
            {
                qualityProfile: 'poor-scan',
                pageSegmentationMode: 6,
            },
        );

        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });
        child.emit('close', 1);
        await resultPromise;

        expect(mocks.resolveTesseractLanguageConfig).toHaveBeenCalledWith(['eng'], {preserveDictionaries: false});
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
            '--psm',
            '6',
            '-c',
            'thresholding_method=2',
            '-c',
            'tessedit_create_tsv=1',
            '-c',
            'tessedit_create_pdf=1',
            '-c',
            'textonly_pdf=1',
        ]));
    });

    it.each([
        'model-preparation',
        'confirmed-reread',
    ] as const)('removes the first pass outputs when early-print reading is canceled (%s)', async phase => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-ocr-early-print-cancel-'));
        try {
            const image = join(directory, 'page-1.png');
            await writeFile(image, PNG_SIGNATURE);
            // The first pass writes its TSV and PDF; long-s-shaped words send
            // the page on to early-print reading.
            let passes = 0;
            mocks.spawn.mockImplementation((_command: string, args: string[]) => {
                const child = new MockChildProcess();
                const outputBase = args[1]!;
                const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
                const rows = Array.from({length: 20}, (_, index) => `5\t1\t1\t1\t1\t${index + 1}\t${index * 12}\t10\t10\t10\t95\tfafa`);
                void Promise.all([
                    writeFile(`${outputBase}.tsv`, [
                        header,
                        ...rows,
                    ].join('\n')),
                    writeFile(`${outputBase}.pdf`, '%PDF-1.4\n'),
                    ...(args.includes('tessedit_create_hocr=1') ? [writeFile(`${outputBase}.hocr`, '<html/>')] : []),
                ]).then(() => {
                    if (phase === 'confirmed-reread' && passes++ > 0) {
                        // The reread has stopped before cancellation; the next native
                        // attempt observes the abort without launching another process.
                        child.emit('close', 0);
                        controller.abort();
                    } else child.emit('close', 0);
                });
                return child;
            });
            const controller = new AbortController();
            const { runOcrFileBased } = await import('@electron/features/ocr/pipeline/tesseractRunner');

            await expect(runOcrFileBased(image, ['lat'], 512, 512, 300, '/mock/tesseract', directory, 1, controller.signal, {}, async () => {
                if (phase === 'model-preparation') {
                    controller.abort();
                    throw controller.signal.reason;
                }
            })).rejects.toMatchObject({name: 'AbortError'});

            expect(await readdir(directory)).toEqual(['page-1.png']);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('preserves dictionaries for the accurate quality profile', async () => {
        const child = new MockChildProcess();
        mocks.spawn.mockReturnValue(child);

        const { runOcrFileBased } = await import('@electron/features/ocr/pipeline/tesseractRunner');
        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            1000,
            1500,
            300,
            '/mock/tesseract',
            '/mock/tessdata',
            1,
            undefined,
            {qualityProfile: 'accurate'},
        );

        await vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        });
        child.emit('close', 1);
        await resultPromise;

        expect(mocks.resolveTesseractLanguageConfig).toHaveBeenCalledWith(['eng'], {preserveDictionaries: true});
    });
});

describe('PNG dimension parsing', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
            tempDir = null;
        }
    });

    it('reads dimensions from the PNG header on disk', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-png-'));
        const imagePath = join(tempDir, 'page.png');
        const header = Buffer.alloc(24);
        PNG_SIGNATURE.copy(header, 0);
        header.writeUInt32BE(2048, 16);
        header.writeUInt32BE(1536, 20);
        await writeFile(imagePath, header);

        const { getPngDimensionsFromFile } = await import('@electron/features/ocr/pipeline/tesseractRunner');

        await expect(getPngDimensionsFromFile(imagePath)).resolves.toEqual({
            width: 2048,
            height: 1536,
        });
    });
});
