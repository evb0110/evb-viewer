import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    relative,
    resolve,
    sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { minifyPdfjsWorker } from './copy-pdfjs-assets.mjs';

const projectRoot = resolve(new URL('..', import.meta.url).pathname);
const archiveName = 'pdfjs-dist-5.7.304-f029c046.tgz';
const dependencyKey = `file:vendor/pdfjs-dist/${archiveName}`;
const expectedPackage = {
    name: 'pdfjs-dist',
    version: '5.7.304',
};
const expectedFork = {
    repository: 'https://github.com/evb0110/pdf.js.git',
    branch: 'evb/5.7.284',
    commit: 'f029c04600ed3d851491c0d70eafe7caa1557d36',
    tree: 'b4653b1e48fcb781ffeafed8efcdceb1a0b986fe',
    sourceBaseCommit: '5e0ac85d697d41a2232045033962b3437b7e2ad1',
    sourceBaseTree: '9dbb438c9a4bce5a958ca8b37d305b79b5b74c6a',
    upstreamTag: 'v5.7.284',
    upstreamCommit: '7e5b36c2d572ba82e1e3adeb1c266f0052746c73',
    upstreamTree: '688cb5794199b81185419d02cb5142e776287085',
};
const expectedBuildCommands = [
    'PUPPETEER_SKIP_DOWNLOAD=1 npm ci',
    'npx gulp lint',
    'npx gulp unittestcli',
    'npx gulp typestest',
    'npx gulp dist',
    'npm pack ./build/dist --ignore-scripts --json',
];
const forkMarkerFiles = [
    'NOTICE',
    'gulpfile.mjs',
    'scripts/verify_fork_artifacts.mjs',
    'src/core/chunked_stream.js',
    'src/core/evaluator.js',
    'src/core/worker.js',
    'src/core/xref.js',
    'src/display/api.js',
    'src/display/canvas.js',
    'src/display/editor/editor.js',
    'src/display/editor/stamp.js',
    'src/display/text_layer.js',
    'src/display/transport_stream.js',
    'test/integration/stamp_editor_spec.mjs',
    'test/unit/api_spec.js',
    'test/unit/stream_spec.js',
];
const runtimeMarkerSources = {
    pdf: [
        'webpack://pdf.js/./src/display/editor/editor.js',
        'webpack://pdf.js/./src/display/canvas.js',
        'webpack://pdf.js/./src/display/transport_stream.js',
        'webpack://pdf.js/./src/display/text_layer.js',
        'webpack://pdf.js/./src/display/api.js',
        'webpack://pdf.js/./src/display/editor/stamp.js',
    ],
    worker: [
        'webpack://pdf.js/./src/core/chunked_stream.js',
        'webpack://pdf.js/./src/core/evaluator.js',
        'webpack://pdf.js/./src/core/xref.js',
        'webpack://pdf.js/./src/core/worker.js',
    ],
};
const requiredFiles = [
    'build/pdf.mjs',
    'build/pdf.worker.mjs',
    'legacy/build/pdf.mjs',
    'legacy/build/pdf.worker.mjs',
    'web/pdf_viewer.mjs',
    'legacy/web/pdf_viewer.mjs',
    'types/src/pdf.d.ts',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_INVENTORY.json',
    'cmaps/78-H.bcmap',
    'standard_fonts/LiberationSans-Regular.ttf',
    'wasm/openjpeg.wasm',
    'iccs/CGATS001Compat-v2-micro.icc',
];
const fail = message => { throw new Error(`PDF.js provenance verification failed: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const sha256 = value => digest('sha256', value);
const sha512 = value => digest('sha512', value);
const sri = value => `sha512-${createHash('sha512').update(value).digest('base64')}`;
const unsafePath = value => {
    const normalized = value.replaceAll('\\', '/');
    return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
        || normalized.split('/').includes('..') || normalized.split('/').some(part => part === '');
};
const forbiddenName = value => /(?:^|\/)(?:[^/]+~|\.[^/]+\.swp|[^/]+\.(?:orig|rej|patch|bak))$/u.test(value);
const absoluteSourceMapPath = value => /^(?:[A-Za-z]:[\\/]|\\\\|\/|file:)/iu.test(value);
const rangeWorkerMarkers = [
    '_storedChunks',
    'discardChunksBefore',
    'indexObjectsBounded',
    'SCAN_WINDOW_BYTES',
    'getByteRange',
];

export function parseManifest(text) {
    const rows = text.trimEnd().split('\n').map(line => {
        const match = line.match(/^file\t(\d+)\t([0-9a-f]{64})\t(.+)$/u);
        assert(match, `invalid manifest row: ${line}`);
        const path = match[3].replaceAll('\\', '/');
        assert(!unsafePath(path) && !forbiddenName(path), `unsafe manifest path: ${path}`);
        return {
            type: match[0].slice(0, 4).trim(),
            size: Number(match[1]),
            hash: match[2],
            path,
        };
    });
    assert(rows.length === new Set(rows.map(row => row.path)).size, 'manifest contains duplicate paths');
    assert(rows.every((row, index) => index === 0 || rows[index - 1].path < row.path), 'manifest is not sorted');
    return rows;
}

export { absoluteSourceMapPath };

export function inspectArchive(candidateArchivePath) {
    const entries = [];
    const listing = execFileSync('tar', [
        '-tvzf',
        candidateArchivePath,
    ], {encoding: 'utf8'});
    for (const line of listing.trimEnd().split('\n')) {
        const match = line.match(/^(?<type>.)(?:\S*)\s+\S+\s+(?<size>\d+)\s+\S+\s+\S+\s+(?<path>.+)$/u);
        assert(match, `unreadable archive listing row: ${line}`);
        const path = match.groups.path.replaceAll('\\', '/');
        assert(match.groups.type === '-', `archive contains unsupported entry type ${match.groups.type}: ${path}`);
        assert(path.startsWith('package/') && path !== 'package/' && !unsafePath(path.slice(8)), `unsafe archive path: ${path}`);
        const packagePath = path.slice(8);
        assert(!forbiddenName(packagePath), `archive contains backup/patch artifact: ${path}`);
        entries.push({
            type: 'file',
            size: Number(match.groups.size),
            path: packagePath,
        });
    }
    assert(entries.length === new Set(entries.map(entry => entry.path)).size, 'archive contains duplicate entries');
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function validateReceipt(receipt) {
    assert(receipt.schemaVersion === 1, 'unsupported receipt schema');
    for (const [
        key,
        value,
    ] of Object.entries(expectedFork)) assert(receipt.source?.[key] === value, `receipt source.${key} mismatch`);
    assert(receipt.source.cleanCheckout === true && receipt.source.fullHistory === true, 'source checkout is not clean and complete');
    assert(receipt.source.versionCalculationBase === 'sourceBaseCommit', 'version calculation base mismatch');
    assert(receipt.build.packageLockSha256 === '3bf40345ad74ca02396681079e25fb9b63332e75ade3394ce990549dcd5263c0', 'fork package-lock hash mismatch');
    assert(JSON.stringify(receipt.build.commands) === JSON.stringify(expectedBuildCommands)
        && receipt.build.environment === 'PUPPETEER_SKIP_DOWNLOAD=1', 'build receipt is incomplete');
    assert(receipt.build.node && receipt.build.npm && receipt.build.os && receipt.build.arch, 'build tool receipt is incomplete');
    assert(receipt.artifact.published === false && receipt.evb.noNpmPublication === true, 'npm publication is not disabled');
    assert(receipt.evb.dependencyKey === dependencyKey && receipt.evb.pnpm === '10.32.1', 'EVB dependency or pnpm mismatch');
    assert(receipt.evb.previewDependency === 'npm:pdfjs-dist@5.4.296', 'preview dependency mismatch');
    assert(receipt.package.sourceMapPolicy === 'source maps retained; local absolute paths forbidden' && receipt.package.sourceMapCount === 10, 'source-map receipt mismatch');
    assert(receipt.package.manifest === `${archiveName.slice(0, -4)}.files.sha256` && receipt.package.manifestFormat === 'file<TAB>size<TAB>sha256<TAB>path', 'manifest receipt mismatch');
    assert(receipt.verification.requiredForkMarkers === forkMarkerFiles.length, 'fork marker count mismatch');
    assert(JSON.stringify(receipt.verification.forkMarkerFiles) === JSON.stringify(forkMarkerFiles), 'fork marker list mismatch');
    assert(JSON.stringify(receipt.verification.runtimeMarkerSourceFiles)
        === JSON.stringify([
            ...runtimeMarkerSources.pdf,
            ...runtimeMarkerSources.worker,
        ]), 'runtime marker source list mismatch');
}

export async function verify(options = {}) {
    const root = resolve(options.projectRoot ?? projectRoot);
    const archivePath = options.archivePath ?? join(root, 'vendor/pdfjs-dist', archiveName);
    const receiptPath = options.receiptPath ?? join(root, 'vendor/pdfjs-dist/provenance.json');
    const manifestPath = options.manifestPath ?? join(root, 'vendor/pdfjs-dist', `${archiveName.slice(0, -4)}.files.sha256`);
    const [
        archive,
        receiptText,
        manifestText,
        installedText,
    ] = await Promise.all([
        readFile(archivePath),
        readFile(receiptPath, 'utf8'),
        readFile(manifestPath, 'utf8'),
        readFile(join(root, 'node_modules/pdfjs-dist/package.json'), 'utf8'),
    ]);
    const receipt = JSON.parse(receiptText);
    const manifest = parseManifest(manifestText);
    const installedPackage = JSON.parse(installedText);
    const archiveStat = await stat(archivePath);
    const archiveEntries = inspectArchive(archivePath);
    validateReceipt(receipt);
    assert(receipt.verifier?.sourceSha256 === sha256(await readFile(new URL('./verify-pdfjs-provenance.mjs', import.meta.url))), 'verifier source hash mismatch');
    assert(receipt.artifact.path === dependencyKey && receipt.artifact.filename === archiveName, 'receipt artifact mismatch');
    assert(archiveStat.size === receipt.archive.byteSize, 'archive byte size mismatch');
    assert(sha256(archive) === receipt.archive.sha256 && sha256(archive) === receipt.build.reproduciblePackSha256, 'archive SHA-256 mismatch');
    assert(sha512(archive) === receipt.archive.sha512 && sri(archive) === receipt.archive.sri, 'archive SHA-512 or SRI mismatch');
    assert(receipt.archive.pack1Sha256 === sha256(archive)
        && receipt.archive.pack2Sha256 === sha256(archive)
        && receipt.archive.reproducible === true, 'pack reproducibility mismatch');
    assert(archiveEntries.length === receipt.archive.entryCount && archiveEntries.length === manifest.length, 'archive or manifest entry count mismatch');
    assert(sha256(manifestText) === receipt.package.manifestSha256, 'manifest hash mismatch');
    archiveEntries.forEach((entry, index) => assert(entry.type === manifest[index]?.type
        && entry.size === manifest[index]?.size
        && entry.path === manifest[index]?.path, `archive metadata mismatch at ${entry.path}`));
    const tempRoot = await mkdtemp(join(tmpdir(), 'evb-pdfjs-provenance-'));
    try {
        execFileSync('tar', [
            '-xzf',
            archivePath,
            '--no-same-owner',
            '--no-same-permissions',
        ], {
            cwd: tempRoot,
            stdio: 'ignore',
        });
        const packageRoot = join(tempRoot, 'package');
        const actual = [];
        async function walk(directory) {
            for (const entry of await readdir(directory, {withFileTypes: true})) {
                const entryPath = join(directory, entry.name);
                if (entry.isDirectory()) {
                    await walk(entryPath);
                    continue;
                }
                assert(entry.isFile(), `extracted package contains unsafe entry: ${entry.name}`);
                const packagePath = relative(packageRoot, entryPath).split(sep).join('/');
                assert(!unsafePath(packagePath), `extracted path escaped package: ${packagePath}`);
                const content = await readFile(entryPath);
                actual.push({
                    path: packagePath,
                    size: content.length,
                    hash: sha256(content),
                });
            }
        }
        await walk(packageRoot);
        actual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        assert(actual.length === manifest.length && actual.length === archiveEntries.length, 'extracted file count mismatch');
        const unpackedByteSize = actual.reduce((total, file) => total + file.size, 0);
        assert(actual.length === receipt.package.entryCount && unpackedByteSize === receipt.package.unpackedByteSize, 'package receipt size mismatch');
        assert(unpackedByteSize === receipt.archive.unpackedByteSize, 'unpacked byte size mismatch');
        actual.forEach((file, index) => assert(manifest[index]?.type === 'file'
            && manifest[index].size === file.size
            && manifest[index].path === file.path
            && manifest[index].hash === file.hash, `manifest mismatch at ${file.path}`));
        const extractedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        assert(extractedPackage.name === expectedPackage.name && extractedPackage.version === expectedPackage.version, 'package identity mismatch');
        assert(extractedPackage.license === 'Apache-2.0', 'package license metadata mismatch');
        assert(installedPackage.name === expectedPackage.name && installedPackage.version === expectedPackage.version, 'installed package identity mismatch');
        assert(extractedPackage.repository?.url === `git+${expectedFork.repository}`, 'repository metadata mismatch');
        assert(extractedPackage['x-evb-provenance']?.sourceCommit === expectedFork.commit && extractedPackage['x-evb-provenance']?.sourceTree === expectedFork.tree, 'package fork metadata mismatch');
        for (const required of requiredFiles) assert(actual.some(file => file.path === required), `required package file missing: ${required}`);
        const forkProvenance = JSON.parse(await readFile(join(packageRoot, 'FORK_PROVENANCE.json'), 'utf8'));
        assert(forkProvenance.sourceCommit === expectedFork.commit && forkProvenance.sourceTree === expectedFork.tree && forkProvenance.sourceBaseCommit === expectedFork.sourceBaseCommit, 'fork provenance metadata mismatch');
        assert((await readFile(join(packageRoot, 'NOTICE'), 'utf8')).includes('EVB Viewer'), 'fork NOTICE missing');
        JSON.parse(await readFile(join(packageRoot, 'THIRD_PARTY_INVENTORY.json'), 'utf8'));
        const bundlePaths = [
            'build/pdf.mjs',
            'build/pdf.worker.mjs',
            'legacy/build/pdf.mjs',
            'legacy/build/pdf.worker.mjs',
        ];
        for (const bundle of bundlePaths) {
            const content = await readFile(join(packageRoot, bundle), 'utf8');
            assert(!content.includes('stream.bytes'), `forbidden stream.bytes materialization in ${bundle}`);
            if (bundle.endsWith('worker.mjs')) for (const marker of rangeWorkerMarkers) assert(content.includes(marker), `missing range-worker marker ${marker} in ${bundle}`);
        }
        const maps = actual.filter(file => file.path.endsWith('.map'));
        assert(maps.length === receipt.package.sourceMapCount, 'source-map count mismatch');
        for (const map of maps) {
            const sourceMap = JSON.parse(await readFile(join(packageRoot, map.path), 'utf8'));
            assert(!sourceMap.sources?.some(absoluteSourceMapPath), `local absolute source-map path in ${map.path}`);
            const hasForkMetadata = sourceMap['x-evb-source-commit'] !== undefined
                || sourceMap['x-evb-source-tree'] !== undefined;
            assert(!hasForkMetadata || (sourceMap['x-evb-source-commit'] === expectedFork.commit
                && sourceMap['x-evb-source-tree'] === expectedFork.tree), `source-map fork metadata mismatch in ${map.path}`);
            const expectedSources = map.path.endsWith('pdf.worker.mjs.map')
                ? runtimeMarkerSources.worker
                : map.path.endsWith('pdf.mjs.map') ? runtimeMarkerSources.pdf : [];
            assert(expectedSources.length === 0 || (sourceMap['x-evb-source-commit'] === expectedFork.commit
                && sourceMap['x-evb-source-tree'] === expectedFork.tree), `runtime source-map fork metadata mismatch in ${map.path}`);
            for (const source of expectedSources) {
                const sourceIndex = sourceMap.sources?.indexOf(source) ?? -1;
                assert(sourceIndex >= 0 && sourceMap.sourcesContent?.[sourceIndex]?.includes('EVB Viewer fork modification'), `fork marker source notice missing for ${source} in ${map.path}`);
            }
        }
    } finally { await rm(tempRoot, {
        recursive: true,
        force: true,
    }); }
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert(packageJson.dependencies?.['pdfjs-dist'] === dependencyKey && packageJson.dependencies?.['pdfjs-dist-codex-preview'] === 'npm:pdfjs-dist@5.4.296', 'package dependency mismatch');
    const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    assert(lockfile.includes(`specifier: ${dependencyKey}`) && lockfile.includes(`integrity: ${receipt.evb.lockfilePdfjsIntegrity}`), 'lockfile does not bind the committed tarball');
    assert((await readFile(join(root, receipt.evb.publicVersionStamp), 'utf8')).trim() === expectedPackage.version, 'public version stamp mismatch');
    const publicWorker = await readFile(join(root, 'public/pdf/pdf.worker.min.mjs'));
    const installedWorker = await readFile(join(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
    for (const marker of rangeWorkerMarkers) assert(installedWorker.includes(marker), `installed worker is missing ${marker}`);
    assert(publicWorker.equals(Buffer.from(await minifyPdfjsWorker(installedWorker))), 'copied public worker identity mismatch');
    async function compareTree(relativePath) {
        const installedRoot = join(root, 'node_modules/pdfjs-dist', relativePath);
        const publicRoot = join(root, 'public/pdf', relativePath);
        async function collect(directory, base, files) {
            for (const entry of await readdir(directory, {withFileTypes: true})) {
                const full = join(directory, entry.name);
                const name = join(base, entry.name);
                if (entry.isDirectory()) await collect(full, name, files);
                else {
                    assert(entry.isFile(), `copied asset is not a regular file: ${relativePath}/${name}`);
                    files.push(name);
                }
            }
        }
        const files = [];
        await collect(installedRoot, '', files);
        for (const name of files) {
            const installed = await readFile(join(installedRoot, name));
            const copied = await readFile(join(publicRoot, name));
            assert(installed.equals(copied), `copied ${relativePath} asset mismatch: ${name}`);
        }
        const copiedFiles = [];
        await collect(publicRoot, '', copiedFiles);
        assert(copiedFiles.sort().join('\n') === files.sort().join('\n'), `copied ${relativePath} file set mismatch`);
    }
    for (const tree of [
        'cmaps',
        'standard_fonts',
        'wasm',
        'iccs',
    ]) await compareTree(tree);
    try {
        const electronWorker = await readFile(join(root, 'dist-electron/pdf.worker.mjs'));
        const installedWorker = await readFile(join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'));
        assert(electronWorker.equals(installedWorker), 'copied Electron worker identity mismatch');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    console.log(`PDF.js provenance verified: ${archiveName}, ${archiveEntries.length} entries, ${archiveStat.size} bytes.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    verify().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
