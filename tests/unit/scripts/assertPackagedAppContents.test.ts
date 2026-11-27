import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {describe, expect, it} from 'vitest';

interface IAssertPackagedAppContentsModule {
    EXPECTED_UNPACKED_DIST_ELECTRON: string[];
    FORBIDDEN_EXACT_ENTRIES: string[];
    REQUIRED_ASAR_ENTRIES: string[];
    REQUIRED_ASAR_PREFIXES: string[];
    collectEntryViolations: (entries: string[]) => string[];
    collectUnpackedViolations: (asarPath: string) => string[];
    normalizeAsarEntries: (entries: string[]) => string[];
}

interface IBuildArtifactHygieneModule {
    collectPublicArtifactContentViolations: (content: string | Buffer, options: {target: string}) => string[];
}

async function loadPackagedContentsModule(): Promise<IAssertPackagedAppContentsModule> {
    return import(pathToFileURL(resolve(process.cwd(), 'scripts/release/assert-packaged-app-contents.mjs')).href);
}

async function loadBuildArtifactHygieneModule(): Promise<IBuildArtifactHygieneModule> {
    return import(pathToFileURL(resolve(process.cwd(), 'scripts/check-build-artifacts-hygiene.mjs')).href);
}

describe('assert-packaged-app-contents', () => {
    it('normalizes Windows ASAR entries before required checks', async () => {
        const {REQUIRED_ASAR_ENTRIES, REQUIRED_ASAR_PREFIXES, collectEntryViolations, normalizeAsarEntries} =
            await loadPackagedContentsModule();
        const windowsEntries = [...REQUIRED_ASAR_ENTRIES, ...REQUIRED_ASAR_PREFIXES.map((prefix) => `${prefix}fixture.js`)].map((entry) =>
            entry.replaceAll('/', '\\'),
        );

        expect(collectEntryViolations(normalizeAsarEntries(windowsEntries))).toEqual([]);
    });

    it('adds a leading slash to relative ASAR entries', async () => {
        const {normalizeAsarEntries} = await loadPackagedContentsModule();

        expect(normalizeAsarEntries(['package.json', 'dist-electron\\main.js'])).toEqual(['/package.json', '/dist-electron/main.js']);
    });

    it('requires a split main chunk in ASAR', async () => {
        const {REQUIRED_ASAR_ENTRIES, collectEntryViolations} = await loadPackagedContentsModule();

        expect(collectEntryViolations(REQUIRED_ASAR_ENTRIES)).toContain('missing required entry prefix: /dist-electron/main-chunk-');
    });

    it('rejects split main chunks from app.asar.unpacked', async () => {
        const {EXPECTED_UNPACKED_DIST_ELECTRON, collectUnpackedViolations} = await loadPackagedContentsModule();
        const root = await mkdtemp(join(tmpdir(), 'evb-packaged-contents-'));
        const asarPath = join(root, 'app.asar');
        const unpackedDistElectron = join(`${asarPath}.unpacked`, 'dist-electron');
        const unpackedWasmDir = join(`${asarPath}.unpacked`, 'nuxt-output', 'public', 'wasm');
        try {
            await mkdir(unpackedDistElectron, {recursive: true});
            await mkdir(unpackedWasmDir, {recursive: true});
            await Promise.all(
                EXPECTED_UNPACKED_DIST_ELECTRON.map((file) =>
                    writeFile(join(unpackedDistElectron, file), file === 'package.json' ? '{"type":"module"}' : ''),
                ),
            );
            await Promise.all(
                ['evb-pdf-page-ops.wasm', 'evb-qpdf.mjs', 'evb-qpdf.wasm'].map((file) => writeFile(join(unpackedWasmDir, file), '')),
            );
            await writeFile(join(unpackedDistElectron, 'main-chunk-fixture.js'), '');

            expect(collectUnpackedViolations(asarPath)).toContain('unexpected unpacked file: dist-electron/main-chunk-fixture.js');
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reports missing unpacked evb-qpdf.mjs under app.asar.unpacked/nuxt-output/public/wasm', async () => {
        const {EXPECTED_UNPACKED_DIST_ELECTRON, collectUnpackedViolations} = await loadPackagedContentsModule();
        const root = await mkdtemp(join(tmpdir(), 'evb-packaged-qpdf-unpacked-'));
        const asarPath = join(root, 'app.asar');
        const unpackedDistElectron = join(`${asarPath}.unpacked`, 'dist-electron');
        const unpackedWasmDir = join(`${asarPath}.unpacked`, 'nuxt-output', 'public', 'wasm');
        try {
            await mkdir(unpackedDistElectron, {recursive: true});
            await mkdir(unpackedWasmDir, {recursive: true});
            await Promise.all(
                EXPECTED_UNPACKED_DIST_ELECTRON.map((file) =>
                    writeFile(join(unpackedDistElectron, file), file === 'package.json' ? '{"type":"module"}' : ''),
                ),
            );
            await writeFile(join(unpackedWasmDir, 'evb-pdf-page-ops.wasm'), '');
            await writeFile(join(unpackedWasmDir, 'evb-qpdf.wasm'), '');

            expect(collectUnpackedViolations(asarPath)).toEqual(['missing unpacked file: nuxt-output/public/wasm/evb-qpdf.mjs']);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects source maps and bundle metafiles', async () => {
        const {collectEntryViolations} = await loadPackagedContentsModule();

        expect(collectEntryViolations(['/dist-electron/main.js.map', '/dist-electron/preload.meta.json'])).toEqual(
            expect.arrayContaining([
                'source map should not ship: /dist-electron/main.js.map',
                'bundle metafile should not ship: /dist-electron/preload.meta.json',
            ]),
        );
    });

    it('rejects vendor packages and archives while allowing copied PDF assets', async () => {
        const {collectEntryViolations} = await loadPackagedContentsModule();
        const problems = collectEntryViolations([
            '/vendor/pdfjs-dist/pdfjs-dist-6.3.311-6922bee2.tgz',
            '/vendor/pdfjs-dist/package/build/pdf.mjs',
            '/dist-electron/pdfjs-dist-codex-preview/build/pdf.mjs',
            '/dist-electron/pdf.d.ts',
            '/dist-electron/pdf.d.mts',
            '/dist-electron/pdf.worker.mjs.map',
            '/dist-electron/pdf_viewer.mjs.map',
            '/dist-electron/pdfjs.patch',
            '/dist-electron/pdf.sandbox.mjs',
            '/dist-electron/pdf.min.mjs',
            '/dist-electron/image_decoders/jpx.js',
            '/dist-electron/pdf.worker.mjs',
            '/nuxt-output/public/pdf/cmaps/78-H.bcmap',
        ]);
        expect(problems).toEqual(
            expect.arrayContaining([
                'forbidden entry present: /vendor/pdfjs-dist/pdfjs-dist-6.3.311-6922bee2.tgz',
                'forbidden entry present: /vendor/pdfjs-dist/package/build/pdf.mjs',
                'complete or alternate PDF.js package content should not ship: /dist-electron/pdfjs-dist-codex-preview/build/pdf.mjs',
                'PDF.js declaration should not ship: /dist-electron/pdf.d.ts',
                'PDF.js declaration should not ship: /dist-electron/pdf.d.mts',
                'source map should not ship: /dist-electron/pdf.worker.mjs.map',
                'source map should not ship: /dist-electron/pdf_viewer.mjs.map',
                'PDF.js development artifact should not ship: /dist-electron/pdfjs.patch',
                'complete or alternate PDF.js package content should not ship: /dist-electron/pdf.sandbox.mjs',
                'complete or alternate PDF.js package content should not ship: /dist-electron/pdf.min.mjs',
                'complete or alternate PDF.js package content should not ship: /dist-electron/image_decoders/jpx.js',
            ]),
        );
        expect(problems).not.toContain(
            'complete or alternate PDF.js package content should not ship: /nuxt-output/public/pdf/cmaps/78-H.bcmap',
        );
    });

    it('rejects staged private source directories by bounded path matching', async () => {
        const {collectEntryViolations} = await loadPackagedContentsModule();

        expect(
            collectEntryViolations([
                '/dist-electron/private-sourcemaps/release/sources/main.ts',
                '/nuxt-output/public/.tmp/sentry-sources/app.ts',
            ]),
        ).toEqual(
            expect.arrayContaining([
                'private staging path should not ship: /dist-electron/private-sourcemaps/release/sources/main.ts',
                'private staging path should not ship: /nuxt-output/public/.tmp/sentry-sources/app.ts',
            ]),
        );
    });

    it('rejects tokens without returning their values', async () => {
        const {collectPublicArtifactContentViolations} = await loadBuildArtifactHygieneModule();
        const token = `sntrys_${'a'.repeat(24)}`;
        const violations = collectPublicArtifactContentViolations(`const token=${token};`, {target: 'desktop'});

        expect(violations).toContain('remote auth credential');
        expect(JSON.stringify(violations)).not.toContain(token);
    });

    it('rejects every Sentry DSN from the desktop renderer', async () => {
        const {collectPublicArtifactContentViolations} = await loadBuildArtifactHygieneModule();

        expect(
            collectPublicArtifactContentViolations('fetch("https://browserkey@o123.ingest.us.sentry.io/456")', {
                target: 'desktop-renderer',
            }),
        ).toContain('web Sentry ingest endpoint in desktop renderer');
        expect(collectPublicArtifactContentViolations('export const clean = true;', {target: 'desktop-renderer'})).toEqual([]);
    });

    it('rejects mixed runtime endpoints from one public bundle', async () => {
        const {collectPublicArtifactContentViolations} = await loadBuildArtifactHygieneModule();

        expect(
            collectPublicArtifactContentViolations(
                ['https://browserkey@o123.ingest.de.sentry.io/456', 'https://serverkey@o123.ingest.de.sentry.io/456'].join('\n'),
                {target: 'web-static'},
            ),
        ).toContain('multiple runtime Sentry endpoints');
    });

    it('keeps EXPECTED_UNPACKED_DIST_ELECTRON and WASM packaging entries aligned with electron-builder.yml', async () => {
        const {EXPECTED_UNPACKED_DIST_ELECTRON, FORBIDDEN_EXACT_ENTRIES, REQUIRED_ASAR_ENTRIES} = await loadPackagedContentsModule();
        const {parseAsarUnpackEntries} = (await import(
            pathToFileURL(resolve(process.cwd(), 'scripts/check-electron-builder-asar-unpack.mjs')).href
        )) as {parseAsarUnpackEntries: (source: string) => string[]};
        const builderSource = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8');
        const unpackedEntries = parseAsarUnpackEntries(builderSource);

        // Every top-level dist-electron/* entry unpacked by electron-builder.yml
        // must match EXPECTED_UNPACKED_DIST_ELECTRON so stale entries (such as
        // removed native runtime folders) fail in PR CI rather than Release.
        const configuredDistElectronUnpack = [
            ...new Set(
                unpackedEntries
                    .filter((entry) => entry.startsWith('dist-electron/'))
                    .map((entry) => entry.slice('dist-electron/'.length).split('/')[0]!),
            ),
        ].sort();
        expect(EXPECTED_UNPACKED_DIST_ELECTRON).toEqual(configuredDistElectronUnpack);

        // Extract top-level `files:` exclusions from electron-builder.yml.
        const lines = builderSource.split(/\r?\n/u);
        const filesStart = lines.findIndex((line) => line.trim() === 'files:');
        expect(filesStart).toBeGreaterThanOrEqual(0);
        const fileEntries: string[] = [];
        for (const line of lines.slice(filesStart + 1)) {
            if (/^\S/u.test(line)) {
                break;
            }
            const match = line.match(/^\s*-\s+["']?(.+?)["']?\s*$/u);
            if (match?.[1]) {
                fileEntries.push(match[1]);
            }
        }
        const excludedFileEntries = fileEntries.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));

        // Desktop ships evb-qpdf.{mjs,wasm} inside ASAR and unpacked for worker threads.
        expect(REQUIRED_ASAR_ENTRIES).toContain('/nuxt-output/public/wasm/evb-qpdf.mjs');
        expect(REQUIRED_ASAR_ENTRIES).toContain('/nuxt-output/public/wasm/evb-qpdf.wasm');
        expect(FORBIDDEN_EXACT_ENTRIES).not.toContain('/nuxt-output/public/wasm/evb-qpdf.mjs');
        expect(FORBIDDEN_EXACT_ENTRIES).not.toContain('/nuxt-output/public/wasm/evb-qpdf.wasm');
        expect(unpackedEntries).toContain('nuxt-output/public/wasm/evb-qpdf.*');

        // No required ASAR entry may be excluded by electron-builder.yml `files:`.
        const wildcardToRegExp = (pattern: string) => new RegExp(`^/${pattern.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}$`, 'u');
        for (const requiredEntry of REQUIRED_ASAR_ENTRIES) {
            for (const excluded of excludedFileEntries) {
                if (excluded.includes('**')) {
                    continue;
                }
                expect(
                    wildcardToRegExp(excluded).test(requiredEntry),
                    `electron-builder.yml excludes required ASAR entry ${requiredEntry} via !${excluded}`,
                ).toBe(false);
            }
        }

        // Every explicitly excluded single file under nuxt-output/public/ should be forbidden in ASAR.
        for (const excluded of excludedFileEntries) {
            if (excluded.startsWith('nuxt-output/public/') && !excluded.includes('*')) {
                expect(FORBIDDEN_EXACT_ENTRIES).toContain(`/${excluded}`);
            }
        }
    });
});
