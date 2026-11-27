import {mkdir, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import esbuild from 'esbuild';
import {fileURLToPath} from 'node:url';
import {computeNativeBuildIds} from './native-build-id.mjs';
import {readBuildEnvironment, resolveBuildGitSha} from './lib/build-environment.mjs';

const {WORKER_BUNDLES} = await import(new URL('../packages/electron-worker-bundles/electronWorkerBundles.js', import.meta.url).href);

// Maps are emitted for local debugging or for a release build that uploads
// them to Sentry (scripts/upload-sentry-sourcemaps.mjs deletes them).
const buildEnv = readBuildEnvironment(process.env);
const emitSourceMaps = buildEnv.EVB_ELECTRON_SOURCEMAP === '1' || Boolean(buildEnv.SENTRY_AUTH_TOKEN);
const buildGitSha = resolveBuildGitSha(buildEnv);
const buildGitShaDefine = {
    __EVB_BUILD_GIT_SHA__: JSON.stringify(buildGitSha),
    'process.env.EVB_BUILD_GIT_SHA': JSON.stringify(buildGitSha ?? ''),
};
// Bundle the existing pins for Node, whose module loader does not resolve the
// manifest's TypeScript aliases. Reuse these archive identities without probing
// or hashing the installed tools again at checkpoint creation.
const runtimeManifest = await esbuild.build({
    entryPoints: ['scripts/runtimeBinaryManifest.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: 'tsconfig.base.json',
});
const {RUNTIME_BINARY_MANIFEST_ENTRIES} = await import(
    `data:text/javascript;base64,${Buffer.from(runtimeManifest.outputFiles[0].text).toString('base64')}`
);
const buildMetadataDefine = {
    ...buildGitShaDefine,
    __EVB_RUNTIME_ARCHIVE_IDS__: JSON.stringify(
        Object.fromEntries(
            RUNTIME_BINARY_MANIFEST_ENTRIES.map((entry) => [`${entry.familyId}-${entry.target.platformArch}`, entry.archiveSha256]),
        ),
    ),
    __EVB_NATIVE_BUILD_IDS__: JSON.stringify(computeNativeBuildIds(fileURLToPath(new URL('..', import.meta.url)))),
};
const mainSentryDefine = {
    ...buildMetadataDefine,
    __EVB_SENTRY_DSN__: JSON.stringify(buildEnv.SENTRY_DESKTOP_DSN?.trim() ?? ''),
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
    sourcemap: false,
};

if (process.platform === 'darwin') {
    execFileSync('bash', ['scripts/build-macos-pdf-print-dialog.sh'], {stdio: 'inherit'});
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
        banner: {
            js: `import { createRequire as __evbCreateRequire } from 'node:module';
const require = __evbCreateRequire(import.meta.url);`,
        },
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
    ...WORKER_BUNDLES.map((bundle) => ({
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
await mkdir('dist-electron', {recursive: true});

await Promise.all(
    builds.map(async ({metafileOutput, ...build}) => {
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
    }),
);

// Pin dist-electron/*.js to ESM semantics regardless of loader heuristics.
// worker_threads resolves module type from the nearest package.json; the
// asar-unpacked copy of this directory has no other package.json above it.
await writeFile('dist-electron/package.json', `${JSON.stringify({type: 'module'}, null, 4)}\n`);
