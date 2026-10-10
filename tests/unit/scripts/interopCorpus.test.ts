import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

import {createManifest} from '@scripts/generate-interop-corpus.mjs';
import {verifyInteropRendering} from '@scripts/verify-interop-rendering.mjs';
import {
    REQUIRED_CANONICAL_KINDS,
    validateCorpus,
    validateManifest,
} from '@scripts/verify-interop-corpus.mjs';

const corpusDirectory = join(process.cwd(), 'tests/fixtures/electron/interop');

describe('interop corpus verifier', () => {
    // The Linux rendering oracle uses qpdf, Poppler and ImageMagick from the POSIX PATH.
    it.skipIf(process.platform === 'win32')('executes the deterministic generator and Linux rendering oracle', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-interop-'));

        try {
            const manifest = await createManifest(temporaryDirectory);
            expect(manifest.entries).toHaveLength(2);

            const rendering = await verifyInteropRendering({
                artifactDirectory: join(temporaryDirectory, 'renders'),
                corpusDirectory,
                inputPaths: [],
            });
            expect(rendering.files).toHaveLength(2);
            expect(rendering.files.every(file => file.visualChecks.length === 5)).toBe(true);
        } finally {
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('validates the generated corpus and all required scenario families', async () => {
        const result = await validateCorpus({
            corpusDirectory,
            runQpdf: false,
        });

        expect(result.readyEntries).toBeGreaterThanOrEqual(2);
        expect(result.kinds).toEqual(REQUIRED_CANONICAL_KINDS);
        expect(result.scenarioCount).toBeGreaterThan(0);
        expect(result.requiredCases).toEqual({
            nativeText: true,
            legacyFreeTextPopup: true,
            replyChain: true,
            unknownVendorKey: true,
            missingName: true,
            richText: true,
            appearance: true,
            reviewState: true,
        });
        expect(result.stockWriterEntries).toBeGreaterThan(0);
    });

    it('rejects an absent manifest instead of silently skipping the corpus', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-interop-'));

        try {
            await expect(
                validateCorpus({
                    corpusDirectory: temporaryDirectory,
                    runQpdf: false,
                }),
            ).rejects.toThrow(/corpus-manifest\.json|manifest/i);
        } finally {
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects a changed ready fixture even when its manifest shape is valid', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-interop-'));

        try {
            const manifest = JSON.parse(
                await readFile(join(corpusDirectory, 'corpus-manifest.json'), 'utf8'),
            );
            const entry = manifest.entries.find(
                (candidate: {status?: string}) => candidate.status === 'ready',
            );
            const sourcePath = join(corpusDirectory, entry.file);
            const destinationPath = join(temporaryDirectory, entry.file);
            await writeFile(destinationPath, await readFile(sourcePath));
            manifest.entries = [entry];
            await writeFile(
                join(temporaryDirectory, 'corpus-manifest.json'),
                JSON.stringify(manifest, null, 2),
            );

            const bytes = Buffer.from(await readFile(destinationPath));
            bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
            await writeFile(destinationPath, bytes);

            await expect(
                validateCorpus({
                    corpusDirectory: temporaryDirectory,
                    runQpdf: false,
                }),
            ).rejects.toThrow(/sha256|bytes|hash/i);
        } finally {
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects stock provenance that claims an unrelated writer', async () => {
        const manifest = JSON.parse(
            await readFile(join(corpusDirectory, 'corpus-manifest.json'), 'utf8'),
        );
        const stockEntry = manifest.entries.find(
            (candidate: {provenance?: {kind?: string}}) => (
                candidate.provenance?.kind === 'stock-pdfjs-save-of-synthetic-input'
            ),
        );
        stockEntry.provenance.packageName = 'pdfjs-dist';

        await expect(
            validateManifest({
                corpusDirectory,
                manifest,
                runQpdf: false,
            }),
        ).rejects.toThrow(/stock|provenance|package/i);
    });

    it('rejects an acquisition-required entry instead of silently skipping it', async () => {
        const manifest = JSON.parse(
            await readFile(join(corpusDirectory, 'corpus-manifest.json'), 'utf8'),
        );
        manifest.entries[0]!.status = 'acquisition-required';

        await expect(
            validateManifest({
                corpusDirectory,
                manifest,
                runQpdf: false,
            }),
        ).rejects.toThrow(/not ready|acquisition/i);
    });

    it('rejects a manifest that omits a required scenario family', async () => {
        const manifest = JSON.parse(
            await readFile(join(corpusDirectory, 'corpus-manifest.json'), 'utf8'),
        );
        manifest.requiredCases.richText = false;

        await expect(
            validateManifest({
                corpusDirectory,
                manifest,
                runQpdf: false,
            }),
        ).rejects.toThrow(/requiredCases|scenario/i);
    });
});
