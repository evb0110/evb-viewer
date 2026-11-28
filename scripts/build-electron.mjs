import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {fileURLToPath} from 'node:url';
import {computeNativeBuildIds} from './native-build-id.mjs';
import {readBuildEnvironment, resolveBuildGitSha} from './lib/build-environment.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const rootPackageJson = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'));
const rootAppVersion = typeof rootPackageJson.version === 'string' ? rootPackageJson.version.trim() : '';
if (!rootAppVersion) {
    throw new Error('The root package.json must define the canonical application version.');
}

// Workspace packages can resolve different peer-scoped pnpm copies of valibot
// (e.g. typescript@6 vs typescript@7), causing esbuild to bundle two copies
// into main.js. Pin every valibot import to the single canonical ESM build.
const canonicalValibotEntry = fileURLToPath(import.meta.resolve('valibot'));

const sharedBuildPlugins = [
    {
        name: 'dedupe-valibot',
        setup(build) {
            build.onResolve({filter: /^valibot$/}, () => ({path: canonicalValibotEntry}));
        },
    },
    {
        name: 'inline-root-package-version',
        setup(build) {
            build.onResolve({filter: /^@root-package$/}, () => ({
                path: '@root-package',
                namespace: 'evb-root-package-version',
            }));
            build.onLoad({filter: /.*/, namespace: 'evb-root-package-version'}, () => ({
                contents: 'export default {version: __EVB_APP_VERSION__};\n',
                loader: 'js',
            }));
        },
    },
];

async function createPreloadSplitPlugins() {
    const [featuresBundle, mappersBundle, documentsContractBundle] = await Promise.all([
        esbuild.build({
            entryPoints: ['electron/preload/platformFeatures.ts'],
            bundle: true,
            platform: 'node',
            format: 'esm',
            write: false,
            tsconfig: 'tsconfig.base.json',
            plugins: sharedBuildPlugins,
        }),
        esbuild.build({
            entryPoints: ['electron/preload/preloadMethodArgMappers.ts'],
            bundle: true,
            platform: 'node',
            format: 'esm',
            write: false,
            tsconfig: 'tsconfig.base.json',
            plugins: sharedBuildPlugins,
        }),
        esbuild.build({
            entryPoints: ['electron/features/documents/contract.ts'],
            bundle: true,
            platform: 'node',
            format: 'esm',
            write: false,
            tsconfig: 'tsconfig.base.json',
            plugins: sharedBuildPlugins,
        }),
    ]);

    const [canonicalFeatures, mappersModule, documentsContract] = await Promise.all([
        import(`data:text/javascript;base64,${Buffer.from(featuresBundle.outputFiles[0].text).toString('base64')}`),
        import(`data:text/javascript;base64,${Buffer.from(mappersBundle.outputFiles[0].text).toString('base64')}`),
        import(`data:text/javascript;base64,${Buffer.from(documentsContractBundle.outputFiles[0].text).toString('base64')}`),
    ]);

    const knownMappers = mappersModule.PRELOAD_METHOD_ARG_MAPPERS;
    const mapperChannelRefs = [];
    const strippedExports = {};

    for (const [exportName, value] of Object.entries(canonicalFeatures)) {
        if (exportName === 'FULL_SCAN_CLEANUP_SUPPORT') {
            strippedExports[exportName] = value;
            continue;
        }
        if (!value || typeof value !== 'object' || !('methods' in value) || !('events' in value)) {
            throw new Error(`Unexpected export "${exportName}" in electron/preload/platformFeatures.ts`);
        }

        const methods = {};
        for (const [methodName, spec] of Object.entries(value.methods)) {
            if (spec.kind === 'sync') {
                methods[methodName] = spec.optionalWhenImplemented ? ['s', 1] : ['s'];
                continue;
            }
            if ('local' in spec) {
                methods[methodName] = spec.optionalWhenImplemented ? ['l', 1] : ['l'];
                continue;
            }
            const hasMapArgs = typeof spec.client?.mapArgs === 'function';
            if (hasMapArgs && typeof knownMappers[spec.channel] !== 'function') {
                throw new Error(
                    `Missing preload argument mapper for "${spec.channel}" (${exportName}.${methodName}); add it to electron/preload/preloadMethodArgMappers.ts`,
                );
            }
            if (hasMapArgs) {
                mapperChannelRefs.push(spec.channel);
            }
            const timeoutMs = spec.ipc?.timeoutMs ?? 0;
            const flags = (spec.optionalWhenImplemented ? 1 : 0) | (hasMapArgs ? 2 : 0);
            methods[methodName] = timeoutMs === 0 && flags === 0 ? spec.channel : [spec.channel, timeoutMs, flags];
        }

        const events = {};
        for (const [eventName, spec] of Object.entries(value.events)) {
            events[eventName] = spec.subscription ? [spec.channel, spec.subscription.channel] : spec.channel;
        }

        strippedExports[exportName] = [value.path, methods, events];
    }

    const platformFeaturesSource = [
        `import {PRELOAD_METHOD_ARG_MAPPERS} from ${JSON.stringify(resolve(REPO_ROOT, 'electron/preload/preloadMethodArgMappers.ts'))};`,
        'function hydratePreloadFeature([path, rawMethods, rawEvents]) {',
        '    const methods = {};',
        '    for (const [name, entry] of Object.entries(rawMethods)) {',
        '        if (typeof entry === "string") {',
        '            methods[name] = {kind: "async", channel: entry, ipc: {}};',
        '        } else if (entry[0] === "s") {',
        '            methods[name] = entry[1] ? {kind: "sync", optionalWhenImplemented: true} : {kind: "sync"};',
        '        } else if (entry[0] === "l") {',
        '            methods[name] = entry[1] ? {kind: "async", local: true, optionalWhenImplemented: true} : {kind: "async", local: true};',
        '        } else {',
        '            const [channel, timeoutMs, flags] = entry;',
        '            const spec = {kind: "async", channel, ipc: timeoutMs ? {timeoutMs} : {}};',
        '            if (flags & 1) spec.optionalWhenImplemented = true;',
        '            if (flags & 2) spec.client = {mapArgs: PRELOAD_METHOD_ARG_MAPPERS[channel]};',
        '            methods[name] = spec;',
        '        }',
        '    }',
        '    const events = {};',
        '    for (const [name, entry] of Object.entries(rawEvents)) {',
        '        events[name] = typeof entry === "string"',
        '            ? {kind: "event", channel: entry}',
        '            : {kind: "event", channel: entry[0], subscription: {channel: entry[1]}};',
        '    }',
        '    return {path, methods, events};',
        '}',
        ...Object.entries(strippedExports).map(([name, descriptor]) =>
            name === 'FULL_SCAN_CLEANUP_SUPPORT'
                ? `export const ${name} = Object.freeze(${JSON.stringify(descriptor)});`
                : `export const ${name} = hydratePreloadFeature(${JSON.stringify(descriptor)});`,
        ),
    ].join('\n');

    const documentsChannelsSource = `export const DOCUMENTS_CHANNELS = ${JSON.stringify(documentsContract.DOCUMENTS_CHANNELS)};\n`;

    return [
        {
            name: 'preload-strip-platform-feature-schemas',
            setup(build) {
                build.onResolve({filter: /^@electron\/preload\/platformFeatures$/}, () => ({
                    path: 'preload-platform-features',
                    namespace: 'evb-preload-descriptors',
                }));
                build.onLoad({filter: /^preload-platform-features$/, namespace: 'evb-preload-descriptors'}, () => ({
                    contents: platformFeaturesSource,
                    loader: 'js',
                    resolveDir: REPO_ROOT,
                }));
                build.onResolve({filter: /^@electron\/features\/documents\/contract$/}, () => ({
                    path: 'preload-documents-channels',
                    namespace: 'evb-preload-descriptors',
                }));
                build.onLoad({filter: /^preload-documents-channels$/, namespace: 'evb-preload-descriptors'}, () => ({
                    contents: documentsChannelsSource,
                    loader: 'js',
                    resolveDir: REPO_ROOT,
                }));
            },
        },
    ];
}

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
    __EVB_APP_VERSION__: JSON.stringify(rootAppVersion),
    __EVB_RUNTIME_ARCHIVE_IDS__: JSON.stringify(
        Object.fromEntries(
            RUNTIME_BINARY_MANIFEST_ENTRIES.map((entry) => [`${entry.familyId}-${entry.target.platformArch}`, entry.archiveSha256]),
        ),
    ),
    __EVB_NATIVE_BUILD_IDS__: JSON.stringify(computeNativeBuildIds(REPO_ROOT)),
};
const mainSentryDefine = {
    ...buildMetadataDefine,
    __EVB_SENTRY_DSN__: JSON.stringify(buildEnv.SENTRY_DESKTOP_DSN?.trim() ?? ''),
};
const preloadSplitPlugins = await createPreloadSplitPlugins();
const initialBundleOptions = {
    sourcemap: emitSourceMaps ? 'external' : false,
    sourcesContent: false,
    legalComments: 'none',
    metafile: true,
    define: buildMetadataDefine,
    plugins: sharedBuildPlugins,
};
const preloadBundleOptions = {
    ...initialBundleOptions,
    sourcemap: false,
    plugins: [...preloadSplitPlugins, ...sharedBuildPlugins],
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
