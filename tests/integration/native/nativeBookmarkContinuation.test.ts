import {execFile} from 'node:child_process';
import {
    access,
    copyFile,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {normalizePdfNativeMutationSet} from '@contracts/nativePdfMutations';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

const execFileAsync = promisify(execFile);
const NATIVE_BOOKMARK_TIMEOUT_MS = 180_000;

function decodePdfText(value: unknown) {
    return value instanceof PDFString || value instanceof PDFHexString
        ? value.decodeText()
        : null;
}

describe('native bookmark continuation integration', () => {
    let tempRoot = '';

    afterEach(async () => {
        if (tempRoot) {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
            tempRoot = '';
        }
    });

    it('saves and reopens 10,001 flat bookmarks through bounded native appends', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-native-bookmarks-'));
        const binaryPath = resolveNativePageOpsPath();
        expect(binaryPath).not.toBeNull();
        const qpdfPath = getPdfNativeToolPaths().qpdf;
        await access(binaryPath!);
        const inputPath = join(tempRoot, 'input.pdf');
        const workingPath = join(tempRoot, 'working.pdf');
        const source = await PDFDocument.create();
        source.addPage([
            612,
            792,
        ]);
        await writeFile(inputPath, await source.save());
        await copyFile(inputPath, workingPath);

        const mutations = normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 1,
            untitledLabel: 'Untitled',
            items: Array.from({length: 10_001}, (_, index) => ({
                title: `Bookmark ${index}`,
                pageIndex: 0,
                pageYRatio: null,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            })),
        }}, 'mutations');
        const chunks = splitPdfNativeMutationSetIntoBoundedChunks(mutations);
        expect(chunks).toHaveLength(3);

        for (const [
            index,
            chunk,
        ] of chunks.entries()) {
            const mutationsPath = join(tempRoot, `mutations-${index}.json`);
            await writeFile(mutationsPath, `${JSON.stringify(chunk)}\n`, 'utf8');
            await runNativeToolCommand(binaryPath!, [
                'save-mutations',
                '--input',
                workingPath,
                '--output',
                workingPath,
                '--mutations-file',
                mutationsPath,
                '--modified-at',
                'D:20260829120500+04\'00\'',
                '--qpdf',
                qpdfPath,
                '--append',
            ], {
                timeoutMs: NATIVE_BOOKMARK_TIMEOUT_MS,
            });
        }

        await expect(execFileAsync(qpdfPath, [
            '--check',
            workingPath,
        ], {
            encoding: 'utf8',
            timeout: NATIVE_BOOKMARK_TIMEOUT_MS,
        })).resolves.toBeTruthy();

        const reopened = await PDFDocument.load(await readFile(workingPath), {updateMetadata: false});
        const outlines = reopened.catalog.lookup(PDFName.of('Outlines'), PDFDict);
        expect(outlines.get(PDFName.of('Count'))?.toString()).toBe('10001');
        let current = outlines.get(PDFName.of('First'));
        let count = 0;
        let firstTitle: string | null = null;
        let lastTitle: string | null = null;
        while (current instanceof PDFRef) {
            const item = reopened.context.lookup(current, PDFDict);
            const title = decodePdfText(item.get(PDFName.of('Title')));
            firstTitle ??= title;
            lastTitle = title;
            count += 1;
            current = item.get(PDFName.of('Next'));
        }
        expect({
            count,
            firstTitle,
            lastTitle,
        }).toEqual({
            count: 10_001,
            firstTitle: 'Bookmark 0',
            lastTitle: 'Bookmark 10000',
        });
    });
});
