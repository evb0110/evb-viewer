import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    iterateOcrPageCheckpoints,
    persistOcrPageCheckpoint,
    restoreOcrPageCheckpoint,
} from '@electron/features/ocr/pipeline/ocrPageCheckpoints';
import type {IOcrRecognizedPage} from '@ocr-core/recognizeOcrPages';
import {afterEach, describe, expect, it} from 'vitest';

const tempDirs: string[] = [];

async function makeCheckpointDir() {
    const dir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-checkpoints-'));
    tempDirs.push(dir);
    return dir;
}

function makeRecognizedPage(overrides: Partial<IOcrRecognizedPage> = {}): IOcrRecognizedPage {
    return {
        pageNumber: 1,
        languages: ['eng'],
        pdf: Buffer.from('%PDF-1.7\n% page 1\n%%EOF\n'),
        text: 'Hello OCR',
        wordEdits: [],
        wordGeometry: {
            rasterWidthPx: 100,
            rasterHeightPx: 200,
            words: [
                {
                    text: 'Hello',
                    x: 10,
                    y: 20,
                    width: 40,
                    height: 20,
                },
            ],
        },
        diagnostics: [
            {
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'warning',
                message: 'Source DPI capped',
                pageNumber: requirePageNumber(1),
            },
        ],
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((dir) =>
            rm(dir, {
                recursive: true,
                force: true,
            }),
        ),
    );
});

describe('ocrPageCheckpoints', () => {
    it('round-trips a persisted checkpoint with valid OCR diagnostics', async () => {
        const dir = await makeCheckpointDir();
        const page = makeRecognizedPage();

        await persistOcrPageCheckpoint(dir, page);
        const restored = await restoreOcrPageCheckpoint(dir, 1);

        expect(restored).toEqual(page);
    });

    it.each([
        ['unknown diagnostic code', [{code: 'OCR_NOT_A_REAL_CODE', severity: 'warning', message: 'bad'}]],
        ['invalid severity', [{code: 'OCR_SOURCE_DPI_LIMITED', severity: 'error', message: 'bad'}]],
        ['missing message', [{code: 'OCR_SOURCE_DPI_LIMITED', severity: 'info'}]],
        ['invalid pageNumber', [{code: 'OCR_SOURCE_DPI_LIMITED', severity: 'info', message: 'ok', pageNumber: 0}]],
        ['non-object entry', ['raw-string-entry']],
        ['null entry', [null]],
    ] as const)('rejects persisted checkpoints containing malformed diagnostics (%s)', async (_label, badDiagnostics) => {
        const dir = await makeCheckpointDir();
        const page = makeRecognizedPage();

        await persistOcrPageCheckpoint(dir, page);
        const jsonPath = join(dir, 'page-1.json');
        const pdfPath = join(dir, 'page-1.pdf');
        const stored = JSON.parse(await readFile(jsonPath, 'utf8')) as {
            version: number;
            pdfSha256: string;
            page: Record<string, unknown>;
        };
        stored.page.diagnostics = badDiagnostics;
        await writeFile(jsonPath, JSON.stringify(stored), 'utf8');

        // Iterator skips malformed checkpoint without throwing.
        const iterated = [];
        for await (const item of iterateOcrPageCheckpoints(
            [{pageNumber: requirePageNumber(1), languages: ['eng']}],
            dir,
            new AbortController().signal,
        )) {
            iterated.push(item);
        }
        expect(iterated).toEqual([]);

        // Restore rejects and cleans up the corrupt checkpoint pair.
        expect(await restoreOcrPageCheckpoint(dir, 1)).toBeNull();
        expect(existsSync(jsonPath)).toBe(false);
        expect(existsSync(pdfPath)).toBe(false);
    });
});
