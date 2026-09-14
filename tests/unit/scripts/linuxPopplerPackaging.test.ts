import { spawnSync } from 'node:child_process';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { getNativeSourceMatrixCheckEntries } from '@scripts/nativeResourceManifest';

describe('linux Poppler packaging', () => {
    it('cleans generated trees before bundling and verifies Poppler runtime resources', async () => {
        const bundleScript = await readFile(resolve(process.cwd(), 'scripts/bundle-tools-linux.sh'), 'utf8');
        for (const [
            generatedDirectory,
            firstBundleUse,
        ] of [
                [
                    'TESSERACT_DIR',
                    '\nbundle_tool "tesseract" "$TESSERACT_DIR"',
                ],
                [
                    'POPPLER_DIR',
                    '\nfor tool in pdfinfo pdftoppm pdftotext pdfimages; do',
                ],
                [
                    'QPDF_DIR',
                    '\nbundle_tool "qpdf" "$QPDF_DIR"',
                ],
                [
                    'DJVU_DIR',
                    '\nfor tool in ddjvu djvused djvudump; do',
                ],
            ] as const) {
            expect(bundleScript).toContain(`reset_bundle_dir "$${generatedDirectory}"`);
            expect(bundleScript.indexOf(`reset_bundle_dir "$${generatedDirectory}"`))
                .toBeLessThan(bundleScript.indexOf(firstBundleUse));
        }
        expect(bundleScript).toContain('cp -a /usr/share/poppler "$POPPLER_DIR/share/"');
        expect(bundleScript).toContain('cp -a /etc/fonts "$POPPLER_DIR/etc/"');
        expect(bundleScript).toContain('verify_dir()');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/share/poppler" "poppler data directory"');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/etc/fonts" "fontconfig directory"');
        expect(bundleScript).toContain('verify_tool "$POPPLER_DIR/bin/pdfinfo" "pdfinfo"');
        expect(bundleScript).toContain('missing_count=$((missing_count + 1))');
        expect(bundleScript).toContain('Error: Bundle verification failed');

        const verifyScript = await readFile(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf8');
        expect(getNativeSourceMatrixCheckEntries('linux-x64')).toEqual(expect.arrayContaining([
            {
                kind: 'required',
                label: 'poppler data directory',
                path: 'resources/poppler/linux-x64/share/poppler',
                type: 'directory',
            },
            {
                kind: 'required',
                label: 'fontconfig directory',
                path: 'resources/poppler/linux-x64/etc/fonts',
                type: 'directory',
            },
            {
                kind: 'required',
                label: 'fontconfig configuration',
                path: 'resources/poppler/linux-x64/etc/fonts/fonts.conf',
                type: 'file',
            },
        ]));
        expect(verifyScript).toContain('nativeResourceManifestCli.ts packaged-entries "$platform_arch"');
        expect(verifyScript).toContain('check_dir "$entry_path" "$entry_label"');
        expect(verifyScript).toContain('check_file "$entry_path" "$entry_label"');
    });

    it('removes stale bundle trees and stops when cleanup fails', async () => {
        const bundleScript = await readFile(resolve(process.cwd(), 'scripts/bundle-tools-linux.sh'), 'utf8');
        const functionStart = bundleScript.indexOf('reset_bundle_dir() {');
        const functionEnd = bundleScript.indexOf('\n}', functionStart);
        expect(functionStart).toBeGreaterThanOrEqual(0);
        expect(functionEnd).toBeGreaterThan(functionStart);
        const resetFunction = bundleScript.slice(functionStart, functionEnd + 2);
        expect(resetFunction).toMatch(/^reset_bundle_dir\(\) \{\n[\s\S]+\n\}$/u);

        const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'evb-linux-bundle-reset-'));
        try {
            const bundleDirs = await Promise.all([
                'tesseract',
                'poppler',
                'qpdf',
                'djvulibre',
            ].map(async name => {
                const bundleDir = path.join(fixtureRoot, name);
                await mkdir(bundleDir, {recursive: true});
                await writeFile(path.join(bundleDir, 'stale-sentinel'), 'stale', 'utf8');
                return bundleDir;
            }));
            const cleanup = spawnSync('/bin/bash', [
                '-c',
                `set -euo pipefail\n${resetFunction}\nfor bundle_dir in "$@"; do reset_bundle_dir "$bundle_dir"; done`,
                'reset-bundles',
                ...bundleDirs,
            ], {encoding: 'utf8'});
            expect(cleanup.status).toBe(0);
            for (const bundleDir of bundleDirs) {
                await expect(readFile(path.join(bundleDir, 'stale-sentinel'), 'utf8')).rejects.toThrow();
            }

            const fakeBin = path.join(fixtureRoot, 'fake-bin');
            await mkdir(fakeBin);
            await writeFile(path.join(fakeBin, 'rm'), '#!/bin/sh\nexit 17\n', 'utf8');
            await chmod(path.join(fakeBin, 'rm'), 0o755);
            const failedCleanup = spawnSync('/bin/bash', [
                '-c',
                `set -euo pipefail\n${resetFunction}\nreset_bundle_dir "$1"`,
                'reset-bundle',
                path.join(fixtureRoot, 'unremovable'),
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
                },
            });
            expect(failedCleanup.status).toBe(17);

            const emptyCleanup = spawnSync('/bin/bash', [
                '-c',
                `set -euo pipefail\n${resetFunction}\nreset_bundle_dir ""`,
            ], {encoding: 'utf8'});
            expect(emptyCleanup.status).not.toBe(0);
            expect(emptyCleanup.stderr).toContain('Refusing to reset an empty Linux bundle path');
        } finally {
            await rm(fixtureRoot, {
                force: true,
                recursive: true,
            });
        }
    });


});
