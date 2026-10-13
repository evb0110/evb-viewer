import {spawnSync} from 'node:child_process';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {assertNoPackagedRendererFailures} from '@scripts/release/assertNoPackagedRendererFailures';

describe('packaged core PDF smoke renderer failure policy', () => {
    it('accepts a renderer journey with no errors', () => {
        expect(() => assertNoPackagedRendererFailures([])).not.toThrow();
    });

    it('fails the packaged smoke for console and page errors', () => {
        expect(() => assertNoPackagedRendererFailures([
            '[packaged-renderer:error] failed to load workspace',
            '[packaged-renderer:pageerror] Error: render crashed',
        ])).toThrow(/reported 2 error\(s\).*failed to load workspace.*render crashed/su);
    });
});

// An absent payload exercises cleanup without starting an app or running a smoke journey.
describe.skipIf(process.platform === 'darwin')('packaged smoke fixture cleanup', () => {
    it('names a fixture directory that survived cleanup', () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-smoke-cleanup-test-'));
        try {
            const marker = join(root, 'fixture-path');
            mkdirSync(join(root, 'payload'));
            const preload = `
                import fs from 'node:fs';
                import {basename} from 'node:path';
                import {registerHooks, syncBuiltinESMExports} from 'node:module';
                // The absent payload never enters a renderer journey. Keep this
                // filesystem regression independent of that unused helper graph.
                const helpers = 'capturePackagedCorePdfFailureArtifacts assertOcrPdfSemanticOutput getActiveWorkspaceWorkingCopyPath runOcrSearchablePdf rotatePages openAnnotationsTab openPdfInApp saveViaWindowHandle waitForPdfLoaded waitForViewerInteractive createCanonicalTextBoxWithPointer installPageEvaluationShims getWorkspaceToolbarSnapshot readPdfAnnotationSummary readPdfCatalogWithPdfjs waitForFunctionInPage waitForRendererReady';
                const stub = 'data:text/javascript,' + encodeURIComponent(helpers.split(' ').map(name => 'export const ' + name + '=async()=>{};').join(''));
                registerHooks({resolve(specifier, context, next) {
                    return specifier.startsWith('@tests/e2e/electron/helpers/')
                        ? {url: stub, shortCircuit: true}
                        : next(specifier, context);
                }});
                const remove = fs.promises.rm;
                fs.promises.rm = async (directory, options) => {
                    if (basename(directory).startsWith('evb-packaged-core-fixtures-')) {
                        fs.writeFileSync(${JSON.stringify(marker)}, directory);
                        return;
                    }
                    return remove(directory, options);
                };
                syncBuiltinESMExports();
            `;
            const result = spawnSync(process.execPath, [
                '--import',
                'tsx',
                '--import',
                `data:text/javascript,${encodeURIComponent(preload)}`,
                resolve('scripts/release/verifyPackagedCorePdfSmoke.ts'),
                '--executable',
                join(root, 'payload', 'missing-payload'),
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    TMPDIR: root,
                    TEMP: root,
                    TMP: root,
                    EVB_PACKAGED_SMOKE_ARTIFACT_DIR: join(root, 'failure'),
                },
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('ENOENT');
            const fixtureDirectory = readFileSync(marker, 'utf8');
            expect(existsSync(fixtureDirectory)).toBe(true);
            expect(result.stderr).toContain(`Packaged smoke cleanup left temporary files at ${fixtureDirectory}:`);
        } finally {
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
