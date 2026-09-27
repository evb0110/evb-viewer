import {execFile} from 'node:child_process';
import {
    readdir,
    rm,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createOcrWorkerPipelineHarness,
    readOcrWorkerCallLog,
    type IOcrWorkerPipelineHarness,
} from '@tests/helpers/ocrWorkerPipelineHarness';

let harness: IOcrWorkerPipelineHarness | null = null;

afterEach(async () => {
    await harness?.close().catch(() => undefined);
    if (harness) {
        await rm(harness.root, {
            recursive: true,
            force: true,
        });
    }
    harness = null;
});

async function hasRequiredTools() {
    const execFileAsync = promisify(execFile);
    return Promise.all([
        'qpdf',
        'pdftoppm',
        'pdftotext',
    ].map(tool => execFileAsync('which', [tool])))
        .then(() => true)
        .catch(() => false);
}

describe('OCR worker aggregate storage enforcement', () => {
    it('aborts concurrent Tesseract growth and cleans all partial job artifacts', async (context) => {
        if (!await hasRequiredTools()) {
            context.skip();
            return;
        }
        harness = await createOcrWorkerPipelineHarness({
            concurrency: 3,
            growOutputKb: 2_048,
            jobMaxTempMb: 1,
        });

        const completion = await harness.start('storage-budget-growth');
        expect(completion.result.success).toBe(false);
        expect(completion.result.errors.join('\n')).toMatch(/aggregate job limit/iu);
        await expect.poll(
            () => readOcrWorkerCallLog(harness!.callLogPath).then(calls => new Set(calls).size),
            {timeout: 5_000},
        ).toBeGreaterThan(1);
        await expect.poll(async () => {
            const names = await readdir(harness!.root, {recursive: true});
            return names.filter(name => (
                name.startsWith('ocr-checkpoints/')
                || /^ocr-[0-9a-f-]+-(?:page|merged|poppler|qpdf|source)/u.test(name)
            ));
        }, {timeout: 5_000}).toEqual([]);
    }, 60_000);
});
