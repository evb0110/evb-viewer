import {
    readdir,
    rm,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
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
