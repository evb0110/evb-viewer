const {readdirSync} = require('node:fs');
const {posix} = require('node:path');

const moduleEntrypoints = [
    'public', 'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'public.ts', 'public.tsx',
    'publicNative.ts', 'public.js', 'public.mjs', 'public/index.ts', 'public/index.tsx',
    'public/index.js', 'public/index.mjs',
];
const boundaryRules = [];
// A string is a path prefix (the path itself or anything below it); a RegExp
// is used as is. Exceptions allow both an entrypoint file and descendants of
// an allowed public directory.
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathPattern = value => value instanceof RegExp
    ? value.source
    : `^${escapeRegex(value)}(?:/|$)`;
// Files at least one directory below `root`, outside the excluded child directories.
const belowExcept = (root, excluded) => new RegExp(
    `^${escapeRegex(root)}/(?!(?:${excluded.map(escapeRegex).join('|')})/)[^/]+/.+$`,
    'u',
);
const pathsPattern = values => `(?:${[].concat(values).map(pathPattern).join('|')})`;
const addZone = (target, from, except = []) => boundaryRules.push({
    name: `boundary-${boundaryRules.length + 1}`,
    severity: 'error',
    comment: `Keep ${[].concat(target).join(', ')} out of ${[].concat(from).join(', ')} internals.`,
    from: {path: pathsPattern(target)},
    to: {
        path: pathsPattern(from),
        ...(except.length > 0 ? {
            pathNot: pathsPattern([].concat(from).flatMap(root => except.map(entry => posix.join(root, entry)))),
        } : {}),
    },
});

for (const [source, target] of [
    ['electron', 'app'], ['app', 'electron'], ['landing', 'app'], ['landing', 'electron'], ['electron', 'landing'],
    ['app', 'landing'], ['packages', 'app'], ['packages', 'electron'], ['packages', 'landing'],
    ['app/services', 'app/composables'], ['scripts', 'electron'], ['scripts', 'app'],
    ['app', 'scripts'], ['electron', 'scripts'], ['packages', 'scripts'], ['server', 'electron'],
    ['server', 'landing'], ['app', 'server'], ['electron', 'server'], ['landing', 'server'],
    ['packages', 'server'], ['landing', 'scripts'], ['server', 'scripts'],
]) {
    addZone(source, target);
    if (source === 'scripts' && target === 'electron') {
        // Erased type imports carry no runtime coupling (including menu automation).
        boundaryRules.at(-1).to.dependencyTypesNot = ['type-only'];
        // This test-fixture stager reuses the app's native-tool path resolution and fsync helper.
        boundaryRules.at(-1).from.pathNot = '^scripts/ci/stageExactPdfFixture\\.ts$';
    }
}

for (const [source, allowed] of [
    ['packages/contracts', ['contracts', 'i18n-core']],
    ['packages/pdf-core', ['pdf-core', 'contracts']],
    ['packages/ocr-core', ['ocr-core', 'contracts']],
    ['packages/agent-core', ['agent-core', 'contracts']],
    ['packages/i18n-core', ['i18n-core']],
    ['packages/i18n-app', ['i18n-app', 'i18n-core']],
    ['packages/release-selection', ['release-selection', 'contracts']],
    ['packages/electron-worker-bundles', ['electron-worker-bundles']],
    ['packages/scan-cleanup', ['scan-cleanup', 'contracts']],
    ['packages/chrome-extension', ['chrome-extension', 'contracts']],
]) addZone(source, 'packages', allowed.map(name => `./${name}`));
addZone(belowExcept('packages', ['contracts', 'pdf-core', 'ocr-core', 'agent-core', 'release-selection', 'scan-cleanup', 'chrome-extension']), 'packages/contracts');

for (const [prefix, allowed] of [
    ['app/modules', moduleEntrypoints],
    ['electron/features', [...moduleEntrypoints, 'contract.ts']],
]) {
    const owners = readdirSync(prefix, {withFileTypes: true})
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    for (const sourceOwner of owners) {
        for (const targetOwner of owners) {
            if (sourceOwner === targetOwner) continue;
            addZone(`${prefix}/${sourceOwner}`, `${prefix}/${targetOwner}`, allowed);
        }
    }
}
addZone(['app/modules/pdf-viewer', 'app/modules/document-viewer'], 'app/modules/workspace-shell');
addZone('app/modules', 'app/platform/browser');
for (const owner of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    for (const importer of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
        if (owner !== importer) addZone(`electron/features/${importer}`, `electron/features/${owner}/main`);
    }
}

for (const ownerRoot of ['app/platform/browser-api', 'app/modules/document-viewer']) {
    const appChildren = readdirSync('app', {withFileTypes: true})
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    for (const child of appChildren) {
        if (ownerRoot.startsWith(`app/${child}/`)) {
            const ownerName = ownerRoot.slice(`app/${child}/`.length);
            addZone(belowExcept(`app/${child}`, [ownerName]), ownerRoot, ['public.ts']);
        } else {
            addZone(`app/${child}`, ownerRoot, ['public.ts']);
        }
    }
}
for (const owner of readdirSync('app/modules', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    addZone(['app/pages', 'app/components', 'app/composables'], `app/modules/${owner}`, moduleEntrypoints);
}
// Only this composition root assembles private feature main bindings.
const featureMainBindingEntrypoints = {
    documents: ['documentsMainBindings.ts'],
    djvu: ['mainBindings.ts'],
    ocr: ['mainBindings.ts'],
    'scan-cleanup': ['scanCleanupMainBindings.ts'],
    settings: ['createSettingsMainBindings.ts'],
    shell: ['shellMainBindings.ts'],
};
for (const owner of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const featureRoot = `electron/features/${owner}`;
    const entrypoints = [...moduleEntrypoints, 'contract.ts'];
    addZone([
        'electron/bootstrap',
        /^electron\/platform-ipc\/(?!featureRegistrationDescriptors\.ts$)[^/]+$/u,
        /^electron\/platform-ipc\/[^/]+\/.+$/u,
        /^electron\/preload\/(?!createElectronApi\.ts$)[^/]+$/u,
        /^electron\/preload\/[^/]+\/.+$/u,
    ], featureRoot, entrypoints);
    addZone('electron/platform-ipc/featureRegistrationDescriptors.ts', featureRoot, [
        ...entrypoints,
        ...(featureMainBindingEntrypoints[owner] ?? []),
    ]);
    addZone('electron/preload/createElectronApi.ts', featureRoot, [
        ...entrypoints,
        // Keep preload stream setup out of the documents main-process barrel.
        ...(owner === 'documents' ? ['createDocumentsPreloadStreams.ts'] : []),
    ]);
}
for (const [target, from] of [
    ['app/modules/pdf-viewer/runtime/annotations', 'app/modules/pdf-viewer/tools'],
    ['app/modules/pdf-viewer/tools', 'app/modules/pdf-viewer/runtime/annotations'],
    ['app/modules/pdf-viewer/runtime/save', 'app/modules/pdf-viewer/runtime/annotations'],
    ['app/modules/pdf-viewer/runtime/save', 'app/modules/pdf-viewer/tools'],
]) addZone(target, from);
// A glob extglob cannot span "/", so the rest of the app is a regex.
addZone(/^app\/(?!modules\/pdf-viewer\/)/u, 'app/modules/pdf-viewer/runtime/save');
for (const target of ['electron', 'packages', 'scripts', 'server', 'landing']) addZone(target, 'app/modules/pdf-viewer/runtime/save');
addZone('app/modules/pdf-viewer/engine', 'app/modules/pdf-viewer', ['./engine', './dom']);
addZone(['app', 'packages'], 'packages/contracts/platformApi.ts');
// These three aggregate composition roots formerly carried inline exemptions.
boundaryRules.at(-1).from.pathNot = '^(app/utils/platform\\.ts|app/platform/browserPlatformApi\\.ts|packages/contracts/electronApi\\.ts)$';
addZone('electron/native-tools', ['electron/pdf', 'electron/features/djvu']);
const ocrNativeToolPaths = [
    'electron/features/ocr/main/paths.ts',
    'electron/features/ocr/main/nativeToolPaths.ts',
    'electron/features/ocr/main/resolveOcrResourcesBase.ts',
    'electron/features/ocr/pipeline/dpiDetection.ts',
];
for (const entry of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    if (entry !== 'ocr') addZone(`electron/features/${entry}`, ocrNativeToolPaths);
}
for (const entry of ['pdf', 'djvu', 'native-tools']) addZone(`electron/${entry}`, ocrNativeToolPaths);
addZone('electron/native-tools', ocrNativeToolPaths);

// PDF.js is a renderer dependency; portable wire contracts cannot load Node.
boundaryRules.push({
    name: 'pdfjs-renderer-only',
    severity: 'error',
    from: {
        path: '^(app|electron|landing|packages|scripts|server)/',
        // This corpus oracle imports pdfjs-dist-codex-preview, outside the former canonical-package restriction.
        pathNot: '^(app/modules/pdf-viewer/|app/services/pdfjs/|app/modules/document-viewer/source/|electron/features/search/|app/platform/browser-api/browserPdfjsDocumentInit\\.ts$|scripts/generate-interop-corpus\\.mjs$)',
    },
    to: {path: '(^|/)node_modules/pdfjs-dist(/|$)'},
}, {
    name: 'contracts-no-node-runtime',
    severity: 'error',
    from: {path: '^packages/contracts/'},
    to: {
        dependencyTypes: ['core'],
        dependencyTypesNot: ['type-only'],
    },
}, {
    name: 'contracts-no-electron-runtime',
    severity: 'error',
    from: {path: '^packages/contracts/'},
    to: {path: '(^|/)node_modules/electron(/|$)', dependencyTypesNot: ['type-only']},
});
module.exports = {
    forbidden: [...boundaryRules, {
        name: 'no-circular-dependencies',
        severity: 'error',
        from: {path: '^(app|electron|landing|packages|scripts|server)/'},
        // Preserve the existing runtime cycle check while also cruising erased imports
        // for boundaries. A cycle containing an erased edge has no runtime cycle.
        to: {circular: true, viaOnly: {dependencyTypesNot: ['type-only']}},
    }],
    options: {
        exclude: {path: '(^|/)\\.(nuxt|output|vercel)/'},
        doNotFollow: {path: '(^|/)node_modules/'},
        tsConfig: {fileName: 'tsconfig.json'},
        tsPreCompilationDeps: true,
    },
};
