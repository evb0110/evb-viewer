import {
    mkdir,
    copyFile,
    cp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    readFileSync,
    realpathSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {
    dirname,
    join,
} from 'node:path';
import esbuild from 'esbuild';
import {
    isSentryDiagnosticsBuild,
    resolveSentryBuildIdentity,
} from '../packages/contracts/diagnostics/releaseIdentity.js';
import {stagePrivateSourcemaps} from './release/stage-private-sourcemaps.mjs';

const { WORKER_BUNDLES } = await import(new URL('../packages/electron-worker-bundles/electronWorkerBundles.js', import.meta.url).href);

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const diagnosticsEligible = isSentryDiagnosticsBuild(process.env);
const emitSourceMaps = process.env.EVB_ELECTRON_SOURCEMAP === '1' || diagnosticsEligible;
const desktopIdentity = diagnosticsEligible
    ? resolveSentryBuildIdentity({
        target: 'desktop',
        version: packageJson.version,
        environment: process.env,
        platform: process.platform,
        architecture: process.arch,
    })
    : null;
const desktopDsn = diagnosticsEligible
    ? process.env.SENTRY_DESKTOP_DSN?.trim() ?? ''
    : '';
const buildGitSha = resolveBuildGitSha();
const buildGitShaDefine = {
    '__EVB_BUILD_GIT_SHA__': JSON.stringify(buildGitSha),
    'process.env.EVB_BUILD_GIT_SHA': JSON.stringify(buildGitSha ?? ''),
};
const buildIdentityDefine = {
    '__EVB_SENTRY_BUILD_IDENTITY__': JSON.stringify(desktopIdentity),
    'process.env.EVB_SENTRY_RELEASE': JSON.stringify(desktopIdentity?.release ?? ''),
    'process.env.EVB_SENTRY_DIST': JSON.stringify(desktopIdentity?.dist ?? ''),
    'process.env.EVB_SENTRY_ENVIRONMENT': JSON.stringify(desktopIdentity?.environment ?? ''),
};
const buildMetadataDefine = {
    ...buildGitShaDefine,
    ...buildIdentityDefine,
};
const mainSentryDefine = {
    ...buildMetadataDefine,
    '__EVB_SENTRY_DESKTOP_DSN__': JSON.stringify(desktopDsn),
    'process.env.SENTRY_DESKTOP_DSN': JSON.stringify(desktopDsn),
};
const initialBundleOptions = {
    sourcemap: emitSourceMaps ? 'external' : false,
    sourcesContent: false,
    legalComments: 'none',
    metafile: true,
    define: buildMetadataDefine,
};
const preloadBundleOptions = {
    ...initialBundleOptions,
    // Preload has no Sentry-owned mapped seam. Keep its ordinary no-map
    // output even when the reportable main and worker bundles emit maps.
    sourcemap: false,
};

if (process.platform === 'darwin') {
    execFileSync('bash', ['scripts/build-macos-pdf-print-dialog.sh'], {stdio: 'inherit'});
}

function resolveBuildGitSha() {
    const gitOptions = {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'ignore',
        ],
    };
    let status;
    try {
        status = execFileSync('git', [
            'status',
            '--porcelain',
        ], gitOptions).trim();
    } catch {
        const ciSha = process.env.GITHUB_SHA?.trim().toLowerCase() ?? '';
        // Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in packages/scan-cleanup/core/provenanceStamp.ts.
        return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ciSha) ? ciSha : null;
    }
    if (status !== '') {
        return null;
    }
    try {
        const sha = execFileSync('git', [
            'rev-parse',
            '--verify',
            'HEAD',
        ], gitOptions).trim().toLowerCase();
        // Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in packages/scan-cleanup/core/provenanceStamp.ts.
        return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha) ? sha : null;
    } catch {
        return null;
    }
}
const builds = [
    {
        entryPoints: {main: 'electron/main.ts'},
        format: 'esm',
        splitting: true,
        outdir: 'dist-electron',
        entryNames: '[name]',
        chunkNames: 'main-chunk-[name]-[hash]',
        metafileOutput: 'dist-electron/main.meta.json',
        external: ['electron'],
        // esbuild's ESM output shims dynamic CJS require() with a throwing
        // helper unless a real require exists in scope; Electron main runs in
        // Node, so createRequire restores builtin requires for CJS deps.
        banner: {js: `import { createRequire as __evbCreateRequire } from 'node:module';
const require = __evbCreateRequire(import.meta.url);`},
        ...initialBundleOptions,
        define: mainSentryDefine,
    },
    {
        entryPoints: ['electron/preload.ts'],
        format: 'cjs',
        outfile: 'dist-electron/preload.cjs',
        metafileOutput: 'dist-electron/preload.meta.json',
        external: ['electron'],
        ...preloadBundleOptions,
    },
    ...WORKER_BUNDLES.map(bundle => ({
        entryPoints: [bundle.entryPoint],
        format: bundle.format,
        outfile: `dist-electron/${bundle.fileName}`,
        external: ['electron'],
        ...initialBundleOptions,
    })),
];

await rm('dist-electron', {
    recursive: true,
    force: true,
});
await mkdir('dist-electron', { recursive: true });

await Promise.all(builds.map(async ({
    metafileOutput,
    ...build
}) => {
    const result = await esbuild.build({
        bundle: true,
        minify: true,
        keepNames: true,
        platform: 'node',
        ...build,
    });
    if (metafileOutput && result.metafile) {
        await writeFile(metafileOutput, `${JSON.stringify(result.metafile)}\n`);
    }
}));

await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist-electron/pdf.worker.mjs');

const require = createRequire(import.meta.url);
const canvasPackageRoot = realpathSync(dirname(require.resolve('@napi-rs/canvas/package.json')));
const canvasTargetPackage = resolveCanvasTargetPackage();
const canvasTargetPackageJson = join(dirname(canvasPackageRoot), canvasTargetPackage, 'package.json');
const stagedCanvasRoot = 'dist-electron/runtime/@napi-rs/canvas';
await cp(canvasPackageRoot, stagedCanvasRoot, {recursive: true});
await rm(join(stagedCanvasRoot, 'README.md'), {force: true});
await rm(join(stagedCanvasRoot, 'LICENSE'), {force: true});
await rm(join(stagedCanvasRoot, 'index.d.ts'), {force: true});
await rm(join(stagedCanvasRoot, 'node-canvas.d.ts'), {force: true});
await cp(
    join(realpathSync(dirname(canvasTargetPackageJson)), `skia.${canvasTargetPackage.replace('canvas-', '')}.node`),
    join(stagedCanvasRoot, `skia.${canvasTargetPackage.replace('canvas-', '')}.node`),
);

function resolveCanvasTargetPackage() {
    const platform = process.platform;
    const architecture = process.arch;
    if (platform === 'darwin' && architecture === 'arm64') {
        return 'canvas-darwin-arm64';
    }
    if (platform === 'darwin' && architecture === 'x64') {
        return 'canvas-darwin-x64';
    }
    if (platform === 'win32' && architecture === 'arm64') {
        return 'canvas-win32-arm64-msvc';
    }
    if (platform === 'win32' && architecture === 'x64') {
        return 'canvas-win32-x64-msvc';
    }
    if (platform === 'linux' && architecture === 'x64') {
        return 'canvas-linux-x64-gnu';
    }
    if (platform === 'linux' && architecture === 'arm64') {
        return 'canvas-linux-arm64-gnu';
    }
    throw new Error(`@napi-rs/canvas has no configured target for ${platform}-${architecture}`);
}

// Pin dist-electron/*.js to ESM semantics regardless of loader heuristics.
// worker_threads resolves module type from the nearest package.json; the
// asar-unpacked copy of this directory has no other package.json above it.
await writeFile('dist-electron/package.json', `${JSON.stringify({ type: 'module' }, null, 4)}\n`);

if (desktopIdentity) {
    await stagePrivateSourcemaps({
        identity: desktopIdentity,
        outputRoots: ['dist-electron'],
        resetCompletedIdentityLock: true,
    });
}
