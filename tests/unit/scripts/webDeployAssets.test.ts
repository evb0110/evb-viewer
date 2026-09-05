import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { createServer } from 'node:http';

interface IWebDeployAssetsModule {
    REQUIRED_WEB_DEPLOY_ASSETS: Array<{ relativePath: string }>;
    REQUIRED_WEB_OUTPUT_CONTRACTS: string[];
    REQUIRED_WEB_WASM_ASSETS: Array<{ relativePath: string }>;
    getExpectedWebDeployOutputRoots: (env?: NodeJS.ProcessEnv) => string[];
    getNodeServerBootTiming: (platform?: NodeJS.Platform) => {
        healthDeadlineMs: number;
        listeningDeadlineMs: number;
        shutdownTimeoutMs: number;
    };
    parseWebDeployAssetOptions: (rawArgs?: string[], env?: NodeJS.ProcessEnv) => {
        outputRoots: string[];
        vercelOutput: boolean;
    };
    assertInitialRendererDependencyGraph: (rootPath: string) => Promise<{
        modulePreloads: string[];
        staticAssets: string[];
    }>;
    collectWebDeployOutputViolations: (rootPath: string) => Promise<string[]>;
    validateWebDeployAssets: (options?: {
        env?: NodeJS.ProcessEnv;
        outputRoots?: string[];
        projectRoot?: string;
        sourceRoot?: string;
    }) => Promise<unknown>;
    validateVercelFunctionBoot: (options?: {projectRoot?: string}) => Promise<void>;
    validateNodeServerBoot: (options?: {
        port?: number;
        projectRoot?: string;
    }) => Promise<void>;
}

const {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
    assertInitialRendererDependencyGraph,
    collectWebDeployOutputViolations,
    getExpectedWebDeployOutputRoots,
    getNodeServerBootTiming,
    parseWebDeployAssetOptions,
    validateWebDeployAssets,
    validateNodeServerBoot,
    validateVercelFunctionBoot,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-web-deploy-assets.mjs')).href
) as IWebDeployAssetsModule;

async function createTempProject() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-web-assets-'));
    const roots = [
        'public',
        'nuxt-output/public',
        '.vercel/output/static',
    ];

    for (const root of roots) {
        await mkdir(path.join(tempRoot, root, 'wasm'), {recursive: true});
    }

    for (const asset of REQUIRED_WEB_WASM_ASSETS) {
        const sourcePath = path.join(process.cwd(), 'public', asset.relativePath);
        for (const root of roots) {
            await copyFile(sourcePath, path.join(tempRoot, root, asset.relativePath));
        }
    }

    const wasmPaths = new Set(REQUIRED_WEB_WASM_ASSETS.map(asset => asset.relativePath));
    for (const asset of REQUIRED_WEB_DEPLOY_ASSETS) {
        if (wasmPaths.has(asset.relativePath)) {
            continue;
        }
        for (const root of roots) {
            const assetPath = path.join(tempRoot, root, asset.relativePath);
            await mkdir(path.dirname(assetPath), {recursive: true});
            await writeFile(assetPath, 'required web asset', 'utf8');
        }
    }
    for (const root of roots.slice(1)) {
        await mkdir(path.join(tempRoot, root, 'electron'), {recursive: true});
        for (const relativePath of REQUIRED_WEB_OUTPUT_CONTRACTS) {
            await writeFile(path.join(tempRoot, root, relativePath), '<!doctype html>', 'utf8');
        }
        await writeFile(
            path.join(tempRoot, root, 'electron/index.html'),
            '<!doctype html>',
            'utf8',
        );
    }

    return tempRoot;
}

describe('web deploy assets check', () => {
    it('rejects PDF.js package artifacts but allows copied PDF runtime assets', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-web-output-scan-'));
        try {
            await mkdir(path.join(tempRoot, 'public/pdf/cmaps'), {recursive: true});
            await mkdir(path.join(tempRoot, 'vendor/pdfjs-dist/package'), {recursive: true});
            await mkdir(path.join(tempRoot, 'vendor/pdfjs-dist-codex-preview/build'), {recursive: true});
            await mkdir(path.join(tempRoot, 'vendor/djvujs'), {recursive: true});
            await writeFile(path.join(tempRoot, 'pdfjs-dist.tgz'), 'archive');
            await writeFile(path.join(tempRoot, 'vendor/pdfjs-dist/package/pdf.mjs'), 'package');
            await writeFile(path.join(tempRoot, 'vendor/pdfjs-dist-codex-preview/build/pdf.mjs'), 'preview package');
            await writeFile(path.join(tempRoot, 'vendor/djvujs/djvu.js'), 'runtime vendor');
            await writeFile(path.join(tempRoot, 'public/pdf/cmaps/78-H.bcmap'), 'cmap');
            await writeFile(path.join(tempRoot, 'public/pdf/pdf.worker.min.mjs'), 'worker');
            await writeFile(path.join(tempRoot, 'public/pdf/pdf.sandbox.mjs'), 'alternate');
            await writeFile(path.join(tempRoot, 'public/pdf/pdf.d.mts'), 'declaration');
            await writeFile(path.join(tempRoot, 'public/pdf/pdf.mjs.map'), 'map');
            await writeFile(path.join(tempRoot, 'public/pdf/pdf_viewer.mjs.map'), 'map');
            await expect(collectWebDeployOutputViolations(tempRoot)).resolves.toEqual([
                'pdfjs-dist.tgz',
                'public/pdf/pdf.d.mts',
                'public/pdf/pdf.mjs.map',
                'public/pdf/pdf.sandbox.mjs',
                'public/pdf/pdf_viewer.mjs.map',
                'vendor/pdfjs-dist-codex-preview/build/pdf.mjs',
                'vendor/pdfjs-dist/package/pdf.mjs',
            ]);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
    it('keeps the strict boot deadline except for slower Windows cold starts', () => {
        expect(getNodeServerBootTiming('linux')).toEqual({
            healthDeadlineMs: 8_000,
            listeningDeadlineMs: 8_000,
            shutdownTimeoutMs: 2_000,
        });
        expect(getNodeServerBootTiming('darwin')).toEqual({
            healthDeadlineMs: 8_000,
            listeningDeadlineMs: 8_000,
            shutdownTimeoutMs: 2_000,
        });
        expect(getNodeServerBootTiming('win32')).toEqual({
            healthDeadlineMs: 30_000,
            listeningDeadlineMs: 30_000,
            shutdownTimeoutMs: 5_000,
        });
    });

    it('boots the generated Node server entry instead of trusting file presence', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-node-server-'));
        const serverRoot = path.join(tempRoot, 'nuxt-output/server');
        const shutdownMarker = path.join(tempRoot, 'graceful-shutdown.txt');
        try {
            await mkdir(serverRoot, {recursive: true});
            await writeFile(
                path.join(serverRoot, 'index.mjs'),
                'await import("./missing-runtime-module.mjs");',
                'utf8',
            );
            await expect(validateNodeServerBoot({projectRoot: tempRoot}))
                .rejects.toThrow(/Nuxt node server failed to boot:.*missing-runtime-module/su);

            await writeFile(
                path.join(serverRoot, 'index.mjs'),
                [
                    'import {writeFileSync} from "node:fs";',
                    'import {createServer} from "node:http";',
                    'const server = createServer((_request, response) => {',
                    '  response.statusCode = 204;',
                    '  response.end();',
                    '});',
                    'process.once("SIGTERM", () => {',
                    `  writeFileSync(${JSON.stringify(shutdownMarker)}, "closed", "utf8");`,
                    '  server.close();',
                    '});',
                    'server.listen(Number(process.env.PORT), process.env.HOST, () => {',
                    '  console.log(`Listening on http://${process.env.HOST}:${process.env.PORT}`);',
                    '});',
                ].join('\n'),
                'utf8',
            );
            await expect(validateNodeServerBoot({projectRoot: tempRoot})).resolves.toBeUndefined();
            await expect(readFile(shutdownMarker, 'utf8')).resolves.toBe('closed');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects a response served by a different process on the selected port', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-node-server-port-race-'));
        const serverRoot = path.join(tempRoot, 'nuxt-output/server');
        const impostor = createServer((_request, response) => {
            response.statusCode = 204;
            response.end();
        });
        try {
            await mkdir(serverRoot, {recursive: true});
            await new Promise<void>((resolvePromise, rejectPromise) => {
                impostor.once('error', rejectPromise);
                impostor.listen(0, '127.0.0.1', resolvePromise);
            });
            const address = impostor.address();
            if (!address || typeof address === 'string') {
                throw new Error('Unable to bind the impostor server.');
            }
            await writeFile(
                path.join(serverRoot, 'index.mjs'),
                [
                    'import {createServer} from "node:http";',
                    'const server = createServer((_request, response) => response.end());',
                    'server.listen(Number(process.env.PORT), process.env.HOST, () => {',
                    '  console.log(`Listening on http://${process.env.HOST}:${process.env.PORT}`);',
                    '});',
                ].join('\n'),
                'utf8',
            );

            await expect(validateNodeServerBoot({
                port: address.port,
                projectRoot: tempRoot,
            })).rejects.toThrow(/Nuxt node server failed to boot.*EADDRINUSE/su);
        } finally {
            await new Promise<void>(resolvePromise => impostor.close(() => resolvePromise()));
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects an invalid explicit boot-check port', async () => {
        await expect(validateNodeServerBoot({
            port: 0,
            projectRoot: process.cwd(),
        })).rejects.toThrow('The Nuxt boot check port must be an integer from 1 through 65535.');
    });

    it('checks local Nuxt build output assets', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeployAssets({
                env: {},
                projectRoot: tempRoot,
            })).resolves.toBeTruthy();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('checks Vercel Build Output static assets', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeployAssets({
                env: {VERCEL: '1'},
                projectRoot: tempRoot,
            })).resolves.toBeTruthy();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects private maps and staged sources in Vercel output', async () => {
        const tempRoot = await createTempProject();
        try {
            await mkdir(path.join(tempRoot, '.vercel/output/static/_nuxt'), {recursive: true});
            await writeFile(
                path.join(tempRoot, '.vercel/output/static/_nuxt/app.js.map'),
                '{}',
                'utf8',
            );
            await mkdir(
                path.join(tempRoot, '.vercel/output/static/private-sourcemaps/sources'),
                {recursive: true},
            );
            await writeFile(
                path.join(tempRoot, '.vercel/output/static/private-sourcemaps/sources/app.ts'),
                'private source',
                'utf8',
            );

            await expect(validateWebDeployAssets({
                env: {VERCEL: '1'},
                projectRoot: tempRoot,
            })).rejects.toThrow('contains forbidden public artifacts');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects auth tokens from Vercel static output', async () => {
        const tempRoot = await createTempProject();
        try {
            await mkdir(path.join(tempRoot, '.vercel/output/static/_nuxt'), {recursive: true});
            await writeFile(
                path.join(tempRoot, '.vercel/output/static/_nuxt/app.js'),
                `const token="sntrys_${'a'.repeat(24)}";`,
                'utf8',
            );

            await expect(validateWebDeployAssets({
                env: {VERCEL: '1'},
                projectRoot: tempRoot,
            })).rejects.toThrow('contains forbidden public artifacts');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('uses the same output roots as nuxt.config.ts', () => {
        expect(getExpectedWebDeployOutputRoots({})).toEqual(['nuxt-output/public']);
        expect(getExpectedWebDeployOutputRoots({VERCEL: '1'})).toEqual(['.vercel/output/static']);
        expect(getExpectedWebDeployOutputRoots({NOW_BUILDER: '1'})).toEqual(['.vercel/output/static']);
    });

    it('supports an explicit Vercel output validation mode', () => {
        expect(parseWebDeployAssetOptions(['--vercel-output'], {})).toEqual({
            outputRoots: ['.vercel/output/static'],
            vercelOutput: true,
        });
        expect(parseWebDeployAssetOptions([], {})).toEqual({
            outputRoots: ['nuxt-output/public'],
            vercelOutput: false,
        });
        expect(() => parseWebDeployAssetOptions(['--unknown'], {}))
            .toThrow('Unsupported web deploy asset option: --unknown');
        expect(() => parseWebDeployAssetOptions([
            '--vercel-output',
            '--vercel-output',
        ], {})).toThrow('Expected at most one --vercel-output option.');
    });

    it('rejects forbidden dependencies reached through static initial imports', async () => {
        const tempRoot = await createTempProject();
        const outputRoot = path.join(tempRoot, 'nuxt-output/public');
        try {
            await mkdir(path.join(outputRoot, '_nuxt'), {recursive: true});
            await writeFile(
                path.join(outputRoot, 'electron/index.html'),
                '<link rel="modulepreload" href="/_nuxt/entry.js">',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/entry.js'),
                'import "./shared.js"; import("./lazy.js");',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/shared.js'),
                'export {value} from "./vendor.js";',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/vendor.js'),
                'export const value = "pdf-lib";',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/lazy.js'),
                'export const value = "utif";',
                'utf8',
            );

            await expect(assertInitialRendererDependencyGraph(outputRoot))
                .rejects.toThrow('Initial renderer dependency graph contains pdf-lib: /_nuxt/vendor.js');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects Sentry modules reached by the initial renderer imports', async () => {
        const tempRoot = await createTempProject();
        const outputRoot = path.join(tempRoot, 'nuxt-output/public');
        try {
            await mkdir(path.join(outputRoot, '_nuxt'), {recursive: true});
            await writeFile(
                path.join(outputRoot, 'electron/index.html'),
                '<link rel="modulepreload" href="/_nuxt/entry.js">',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/entry.js'),
                'import "./sentry.js";',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/sentry.js'),
                'export const value = "@sentry/browser";',
                'utf8',
            );

            await expect(assertInitialRendererDependencyGraph(outputRoot))
                .rejects.toThrow('Initial renderer dependency graph contains @sentry/: /_nuxt/sentry.js');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('does not treat dynamic imports as initial renderer dependencies', async () => {
        const tempRoot = await createTempProject();
        const outputRoot = path.join(tempRoot, 'nuxt-output/public');
        try {
            await mkdir(path.join(outputRoot, '_nuxt'), {recursive: true});
            await writeFile(
                path.join(outputRoot, 'electron/index.html'),
                '<link href="/_nuxt/entry.js" rel="modulepreload">',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/entry.js'),
                'import("./lazy.js");',
                'utf8',
            );
            await writeFile(
                path.join(outputRoot, '_nuxt/lazy.js'),
                'export const value = "pako";',
                'utf8',
            );

            await expect(assertInitialRendererDependencyGraph(outputRoot)).resolves.toEqual({
                modulePreloads: ['/_nuxt/entry.js'],
                staticAssets: ['/_nuxt/entry.js'],
            });
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('loads the generated Vercel server function entry', async () => {
        const tempRoot = await createTempProject();
        const functionRoot = path.join(tempRoot, '.vercel/output/functions/__fallback.func');
        try {
            await mkdir(functionRoot, {recursive: true});
            await writeFile(path.join(functionRoot, 'index.mjs'), 'export default {};\n', 'utf8');
            await expect(validateVercelFunctionBoot({projectRoot: tempRoot})).resolves.toBeUndefined();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails when a generated Vercel server dependency is missing', async () => {
        const tempRoot = await createTempProject();
        const functionRoot = path.join(tempRoot, '.vercel/output/functions/__fallback.func');
        try {
            await mkdir(functionRoot, {recursive: true});
            await writeFile(
                path.join(functionRoot, 'index.mjs'),
                'import "./missing-dependency.mjs";\nexport default {};\n',
                'utf8',
            );
            await expect(validateVercelFunctionBoot({projectRoot: tempRoot}))
                .rejects.toThrow('Vercel server function failed to load');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails when the expected build output is absent', async () => {
        const tempRoot = await createTempProject();
        try {
            await rm(path.join(tempRoot, 'nuxt-output'), {
                force: true,
                recursive: true,
            });
            await expect(validateWebDeployAssets({
                env: {},
                projectRoot: tempRoot,
            })).rejects.toThrow('Missing web build output nuxt-output/public');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each(REQUIRED_WEB_DEPLOY_ASSETS)(
        'fails when required output asset $relativePath is absent',
        async (asset) => {
            const tempRoot = await createTempProject();
            try {
                await rm(path.join(tempRoot, 'nuxt-output/public', asset.relativePath));
                await expect(validateWebDeployAssets({
                    env: {},
                    projectRoot: tempRoot,
                })).rejects.toThrow(`Missing web build output nuxt-output/public asset: ${asset.relativePath}`);
            } finally {
                await rm(tempRoot, {
                    force: true,
                    recursive: true,
                });
            }
        },
    );

    it.each(REQUIRED_WEB_OUTPUT_CONTRACTS)(
        'fails when required output contract %s is absent',
        async (relativePath) => {
            const tempRoot = await createTempProject();
            try {
                await rm(path.join(tempRoot, 'nuxt-output/public', relativePath));
                await expect(validateWebDeployAssets({
                    env: {},
                    projectRoot: tempRoot,
                })).rejects.toThrow(`Missing web build output nuxt-output/public asset: ${relativePath}`);
            } finally {
                await rm(tempRoot, {
                    force: true,
                    recursive: true,
                });
            }
        },
    );
});
