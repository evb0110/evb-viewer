import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {createOcrJobManifestController} from '@electron/features/ocr/worker/ocrJobManifest';

describe('OCR durable job manifest', () => {
    let root = '';
    afterEach(async () => {
        if (root) await rm(root, {
            recursive: true,
            force: true,
        });
    });

    it('persists verified pages and resumes at the first unverified page', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-manifest-'));
        const first = await createOcrJobManifestController(root, 'fingerprint');
        await first.markNode('recognized-page', 'running');
        await first.markPageVerified(1);
        await first.markPageVerified(2);
        await first.setTerminal('failed');

        const resumed = await createOcrJobManifestController(root, 'fingerprint');
        expect([...resumed.verifiedPages]).toEqual([
            1,
            2,
        ]);
        expect([
            1,
            2,
            3,
        ].find(page => !resumed.verifiedPages.has(page))).toBe(3);
        const disk = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
            verifiedPages: number[];
            state: string
        };
        expect(disk.verifiedPages).toEqual([
            1,
            2,
        ]);
        expect(disk.state).toBe('running');
    });
});
