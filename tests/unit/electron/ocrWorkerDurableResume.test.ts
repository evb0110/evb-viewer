import {
    readdir,
    readFile,
    writeFile,
    rm,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createOcrWorkerPipelineHarness,
    readOcrWorkerCallLog,
    type IOcrWorkerPipelineHarness,
} from '@tests/helpers/ocrWorkerPipelineHarness';

import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {OCR_LANGUAGE_MODEL_SHA256} from '@contracts/ocrLanguages';

let harnesses: IOcrWorkerPipelineHarness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.map(harness => harness.close().catch(() => undefined)));
    const roots = new Set(harnesses.map(harness => harness.root));
    await Promise.all([...roots].map(root => rm(root, {
        recursive: true,
        force: true,
    })));
    harnesses = [];
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

async function waitForFirstCheckpoint(root: string) {
    await expect.poll(async () => {
        const files = await readdir(`${root}/ocr-checkpoints`, {recursive: true}).catch(() => []);
        return files.some(file => file.endsWith('page-1.json'));
    }, {
        timeout: 45_000,
        interval: 100,
    }).toBe(true);
}

describe('real OCR worker durable page checkpoints', () => {
    describe('recipe identity', () => {
        let first: IOcrWorkerPipelineHarness;

        beforeEach(async () => {
            // Fixture/module startup precedes the behavior under test. These
            // identity checks still run the real pipeline and read saved text.
            first = await createOcrWorkerPipelineHarness({concurrency: 3});
            harnesses.push(first);
        });

        it.each([
            'native',
            'runtime',
            'selected-model',
        ] as const)(
            'reuses same-recipe recognition but recomputes saved text after a %s identity change',
            async (identityKind) => {
                const originalModelHash = OCR_LANGUAGE_MODEL_SHA256.eng;
                const identityName = identityKind === 'native' ? '__EVB_NATIVE_BUILD_IDS__' : '__EVB_RUNTIME_ARCHIVE_IDS__';
                const identityKey = identityKind === 'native' ? 'evb-scan-cleanup' : `tesseract-${process.platform}-${process.arch}`;
                try {
                    vi.stubGlobal(identityName, {[identityKey]: 'old-tool'});
                    await first.start('old-recipe');
                    const scriptPath = join(first.root, 'fake-tesseract.sh');
                    await writeFile(scriptPath, (await readFile(scriptPath, 'utf8')).replaceAll('checkpoint', 'newrecipe'));
                    await first.start('same-recipe');
                    const readSavedText = async () => {
                        const root = join(first.root, 'ocr-checkpoints');
                        const files = await readdir(root, {recursive: true});
                        return Promise.all(files.filter(file => file.endsWith('page-1.json')).map(async file => (
                            JSON.parse(await readFile(join(root, file), 'utf8')).pageData.text as string
                        )));
                    };
                    expect(await readSavedText()).toEqual(['checkpoint page 1']);
                    if (identityKind === 'selected-model') {
                        Object.assign(OCR_LANGUAGE_MODEL_SHA256, {eng: 'new-model-hash'});
                    } else {
                        vi.stubGlobal(identityName, {[identityKey]: 'new-tool'});
                    }
                    await first.start('changed-recipe');
                    expect(await readSavedText()).toContain('newrecipe page 1');
                } finally {
                    Object.assign(OCR_LANGUAGE_MODEL_SHA256, {eng: originalModelHash});
                    vi.unstubAllGlobals();
                }
            },
        );
    });

    it('rejects same-size checkpoint corruption while retaining the other recognized pages', async () => {
        const harness = await createOcrWorkerPipelineHarness();
        harnesses.push(harness);
        await harness.start('recognize');
        const root = join(harness.root, 'ocr-checkpoints');
        const files = await readdir(root, {recursive: true});
        const pageOne = files.find(file => file.endsWith('page-1.pdf'))!;
        const pdf = await readFile(join(root, pageOne));
        pdf[0] = pdf[0]! ^ 1;
        await writeFile(join(root, pageOne), pdf);
        const scriptPath = join(harness.root, 'fake-tesseract.sh');
        await writeFile(scriptPath, (await readFile(scriptPath, 'utf8')).replaceAll('checkpoint', 'repaired'));
        await harness.start('repair');
        const repaired = JSON.parse(await readFile(join(root, pageOne.replace('.pdf', '.json')), 'utf8'));
        expect(repaired.pageData.text).toBe('repaired page 1');
        expect(repaired.pdfSha256).toBe(createHash('sha256').update(await readFile(join(root, pageOne))).digest('hex'));
        const retained = JSON.parse(await readFile(join(root, pageOne.replace('page-1.pdf', 'page-2.json')), 'utf8'));
        expect(retained.pageData.text).toBe('checkpoint page 2');
    });

    it('keeps concurrent twin recognition artifacts independent and the source unchanged', async () => {
        const first = await createOcrWorkerPipelineHarness();
        const twin = await createOcrWorkerPipelineHarness({tempRoot: first.root});
        harnesses.push(first, twin);
        const sourceBefore = await readFile(first.sourcePdfPath);
        await Promise.all([
            first.start('first'),
            twin.start('twin'),
        ]);
        const root = join(first.root, 'ocr-checkpoints');
        const files = await readdir(root, {recursive: true});
        const pageFiles = files.filter(file => /page-\d+\.json$/u.test(file));
        expect(pageFiles).toHaveLength(6);
        for (const file of pageFiles) {
            const checkpoint = JSON.parse(await readFile(join(root, file), 'utf8'));
            expect(checkpoint.pageData.text).toBe(`checkpoint page ${checkpoint.pageData.pageNumber}`);
            const pdf = await readFile(join(root, file.replace('.json', '.pdf')));
            expect(checkpoint.pdfSha256).toBe(createHash('sha256').update(pdf).digest('hex'));
        }
        expect(await readFile(first.sourcePdfPath)).toEqual(sourceBefore);
    });

    it('restarts after page one without invoking Tesseract for that page again', async (context) => {
        if (!await hasRequiredTools()) {
            context.skip();
            return;
        }

        const first = await createOcrWorkerPipelineHarness({stallPage: 2});
        harnesses.push(first);
        void first.start('crash-run').catch(() => undefined);
        await waitForFirstCheckpoint(first.root);
        await first.close();

        const callsBeforeResume = await readOcrWorkerCallLog(first.callLogPath);
        expect(callsBeforeResume).toContain(1);

        const resumed = await createOcrWorkerPipelineHarness({tempRoot: first.root});
        harnesses.push(resumed);
        const resumedResult = await resumed.start('resume-run');

        const calls = await readOcrWorkerCallLog(resumed.callLogPath);
        expect(calls.filter(page => page === 1)).toHaveLength(1);
        expect(calls, JSON.stringify({result: resumedResult.result})).toEqual(expect.arrayContaining([
            2,
            3,
        ]));
    }, 90_000);
});
