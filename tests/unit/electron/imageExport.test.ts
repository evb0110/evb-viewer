import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as utifModule from 'utif';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IUtifFrame {
    width?: number;
    height?: number;
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
    encodeImage(
        rgba: Uint8Array | ArrayBuffer,
        width: number,
        height: number,
    ): ArrayBuffer;
}

const mocks = vi.hoisted(() => ({runCommand: vi.fn()}));

vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: () => ({
    pdftoppm: '/mock/pdftoppm',
    qpdf: '/mock/qpdf',
})}));

vi.mock('@electron/ocr/worker/run-command', () => ({runCommand: mocks.runCommand}));

const { exportPdfAsMultiPageTiff } = await import('@electron/image/export');

const UTIF = utifModule as IUtifModule;

describe('exportPdfAsMultiPageTiff', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'image-export-test-'));
        mocks.runCommand.mockReset();
        mocks.runCommand.mockImplementation(async (command: string, args: string[]) => {
            if (command !== '/mock/pdftoppm') {
                throw new Error(`Unexpected command: ${command}`);
            }

            const prefix = args[2];
            if (typeof prefix !== 'string') {
                throw new Error('Expected pdftoppm output prefix');
            }

            const firstPage = Buffer.from(UTIF.encodeImage(new Uint8Array([
                255,
                0,
                0,
                255,
            ]), 1, 1));
            const secondPage = Buffer.from(UTIF.encodeImage(new Uint8Array([
                0,
                255,
                0,
                255,
            ]), 1, 1));

            await writeFile(`${prefix}-1.tif`, firstPage);
            await writeFile(`${prefix}-2.tif`, secondPage);

            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('creates a multi-page TIFF without host tool fallbacks', async () => {
        const outputPath = join(tempDir, 'exported.tiff');

        const resultPath = await exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath);
        expect(resultPath).toBe(outputPath);

        const outputBytes = new Uint8Array(await readFile(outputPath));
        const ifds = UTIF.decode(outputBytes);
        expect(ifds.length).toBeGreaterThanOrEqual(2);

        UTIF.decodeImage(outputBytes, ifds[0]!);
        UTIF.decodeImage(outputBytes, ifds[1]!);

        const firstRgba = UTIF.toRGBA8(ifds[0]!);
        const secondRgba = UTIF.toRGBA8(ifds[1]!);

        expect(Array.from(firstRgba.slice(0, 4))).toEqual([
            255,
            0,
            0,
            255,
        ]);
        expect(Array.from(secondRgba.slice(0, 4))).toEqual([
            0,
            255,
            0,
            255,
        ]);

        expect(mocks.runCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runCommand).toHaveBeenCalledWith('/mock/pdftoppm', expect.any(Array));
    });
});
