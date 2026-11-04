import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    parseTsvOcrData,
    parseTsvOutput,
} from '@ocr-core/tesseractTsv';
import {shouldNormalizeGreekMicroSign} from '@ocr-core/tesseractRecipe';

describe('parseTsvOutput', () => {
    it('preserves line boxes positioned at the top of the page', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t0\t40\t12\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t2\t40\t8\t95\tHeader',
        ].join('\n');

        expect(parseTsvOutput(tsv)).toEqual([{
            text: 'Header',
            x: 10,
            y: 0,
            width: 40,
            height: 12,
        }]);
    });

    it('accepts a valid header-only TSV as an empty OCR result', () => {
        const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [],
            text: '',
        });
    });

    it('rejects prose output instead of treating it as empty TSV', () => {
        expect(() => parseTsvOcrData('Tesseract Open Source OCR Engine v5.5.0')).toThrow('Invalid Tesseract TSV output');
    });

    it('drops word rows with malformed non-finite geometry or confidence', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\tInfinity\t2\t40\t8\t95\tBadLeft',
            '5\t1\t1\t1\t1\t2\t10\tNaN\t40\t8\t95\tBadTop',
            '5\t1\t1\t1\t1\t3\t10\t2\tInfinity\t8\t95\tBadWidth',
            '5\t1\t1\t1\t1\t4\t10\t2\t40\t8\tNaN\tBadConfidence',
            '5\t1\t1\t1\t1\t5\t10\t2\t40\t8\t95\tGood',
        ].join('\n');

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [{
                text: 'Good',
                x: 10,
                y: 2,
                width: 40,
                height: 8,
            }],
            text: 'Good',
        });
    });

    it('normalizes Greek micro signs for every registry Greek OCR language', () => {
        expect(shouldNormalizeGreekMicroSign(['ell'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['grc'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['eng'])).toBe(false);
    });
});


const nativeRunner = vi.hoisted(() => vi.fn());
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: nativeRunner}));

describe('file OCR termination ownership at the native seam', () => {
    const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
    const tsv = [
        header,
        ...Array.from({length: 32}, (_, i) => `5\t1\t1\t1\t1\t${i + 1}\t${i * 12}\t10\t10\t10\t95\tfefto`),
    ].join('\n');
    it.each([
        0,
        1,
        2,
        3,
    ].flatMap(pass => [
        false,
        true,
    ].map(aborted => ({
        pass,
        aborted,
    }))))(
        'retains created bytes and the original marked error at pass $pass, aborted=$aborted', async ({
            pass, aborted,
        }) => {
            const fs = await import('node:fs/promises');
            const {join} = await import('node:path');
            const {tmpdir} = await import('node:os');
            const {runOcrFileBased} = await import('@electron/features/ocr/pipeline/tesseractRunner');
            const {
                markUnprovenNativeTermination, getUnprovenNativeTerminationDetail,
            } = await import('@electron/utils/nativeTerminationProof');
            const directory = await fs.mkdtemp(join(tmpdir(), 'ocr-native-proof-'));
            const image = join(directory, 'page.png');
            await fs.writeFile(image, 'owned raster');
            const error = markUnprovenNativeTermination(new Error('native timeout'), 'still reading raster');
            const controller = new AbortController();
            if (aborted) controller.abort(new Error('different cancellation reason'));
            const created = new Map<string, string>();
            let invocation = 0;
            nativeRunner.mockReset().mockImplementation(async (_binary: string, args: string[]) => {
                const base = args[1]!;
                const suffixes = invocation < 2 ? [
                    '.pdf',
                    '.tsv',
                    ...(invocation === 1 ? ['.hocr'] : []),
                ] : ['.hocr'];
                for (const suffix of suffixes) {
                    const content = suffix === '.tsv' ? tsv : `${base}${suffix} owned bytes`;
                    created.set(`${base}${suffix}`, content);
                    await fs.writeFile(`${base}${suffix}`, content);
                }
                if (invocation++ === pass) throw error;
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });
            try {
                await expect(runOcrFileBased(image, ['lat'], 512, 512, 300, '/tesseract', directory, 1, controller.signal, {}, async () => undefined)).rejects.toBe(error);
                expect(getUnprovenNativeTerminationDetail(error)).toBe('still reading raster');
                expect(await fs.readFile(image, 'utf8')).toBe('owned raster');
                expect(created.size).toBe([
                    2,
                    5,
                    6,
                    7,
                ][pass]);
                for (const [
                    path,
                    content,
                ] of created) expect(await fs.readFile(path, 'utf8')).toBe(content);
            } finally { await fs.rm(directory, {
                recursive: true,
                force: true,
            }); }
        },
    );

    it.each([
        'optional-failure',
        'first-pass-abort',
    ] as const)('cleans only proven stopped output: %s', async mode => {
        const fs = await import('node:fs/promises');
        const {join} = await import('node:path');
        const {tmpdir} = await import('node:os');
        const {runOcrFileBased} = await import('@electron/features/ocr/pipeline/tesseractRunner');
        const directory = await fs.mkdtemp(join(tmpdir(), 'ocr-proven-output-'));
        const image = join(directory, 'page.png');
        await fs.writeFile(image, 'input');
        const abort = new DOMException('confirmed native cancellation', 'AbortError');
        let invocation = 0;
        nativeRunner.mockReset().mockImplementation(async (_binary: string, args: string[]) => {
            const base = args[1]!;
            await fs.writeFile(`${base}.pdf`, 'PDF output');
            await fs.writeFile(`${base}.tsv`, tsv);
            if (mode === 'first-pass-abort') throw abort;
            if (invocation++ > 0) throw new Error('optional reader unavailable');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        try {
            const task = runOcrFileBased(image, ['lat'], 512, 512, 300, '/tesseract', directory, 1, undefined, {}, async () => undefined);
            if (mode === 'first-pass-abort') {
                await expect(task).rejects.toBe(abort);
                expect(await fs.readdir(directory)).toEqual(['page.png']);
            } else {
                const result = await task;
                expect(result.success).toBe(true);
                expect(result.pageData?.text).toContain('fefto');
                expect(result.earlyPrintUnavailable).toBe('optional reader unavailable');
                const files = await fs.readdir(directory);
                expect(files.some(name => /-(?:early|ita_old|fra)\./u.test(name))).toBe(false);
                expect(files).toContain('page-ocr.pdf');
            }
        } finally { await fs.rm(directory, {
            recursive: true,
            force: true,
        }); }
    });
});
