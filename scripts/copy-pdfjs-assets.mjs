import {
    cp,
    readdir,
    readFile,
    mkdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { transform } from 'esbuild';
import {
    basename,
    dirname,
    join,
    relative,
    resolve,
} from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import { getCliErrorMessage } from './lib/cli-error.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const pdfjsRoot = join(projectRoot, 'node_modules', 'pdfjs-dist');
const publicPdfRoot = join(projectRoot, 'public', 'pdf');

const ASSET_DIRECTORIES = [
    'standard_fonts',
    'cmaps',
    'wasm',
    'iccs',
];

const PDFJS_DOCUMENTATION_FILE_PATTERN = /^(?:README|CHANGELOG)(?:\.[^/\\]+)?$/iu;
const PDFJS_LICENSE_FILE = 'standard_fonts/LICENSE_LIBERATION';

const PDFJS_VERSION_STAMP_FILE = '.pdfjs-version';
const PDFJS_ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u;
export const PDFJS_WORKER_MAX_BYTES = 1_500_000;
export const PDFJS_WORKER_MAX_LINES = 100;

function readPdfjsWorkerHeader(source) {
    return source.match(/^(?:\/\*\*(?!\*)[\s\S]*?\*\/\s*)+/u)?.[0] ?? '';
}

export async function minifyPdfjsWorker(source) {
    const {code} = await transform(source, {
        banner: readPdfjsWorkerHeader(source),
        format: 'esm',
        keepNames: true,
        loader: 'js',
        minify: true,
        target: 'es2022',
    });
    const minifiedSource = `${code.trimEnd()}\n`;
    const bytes = Buffer.byteLength(minifiedSource, 'utf8');
    const lines = minifiedSource.split(/\r?\n/u).length;

    if (bytes > PDFJS_WORKER_MAX_BYTES || lines > PDFJS_WORKER_MAX_LINES) {
        throw new Error(
            `Minified PDF.js worker exceeds the ${PDFJS_WORKER_MAX_BYTES}-byte `
            + `or ${PDFJS_WORKER_MAX_LINES}-line limit `
            + `(got ${bytes} bytes and ${lines} lines)`,
        );
    }
    return minifiedSource;
}

export async function readPdfjsPackageVersion(root = pdfjsRoot) {
    const packageJsonPath = join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
        throw new Error(`Missing pdfjs-dist version in ${packageJsonPath}`);
    }
    return packageJson.version.trim();
}

export async function writePdfjsVersionStamp({
    root = pdfjsRoot,
    targetRoot = publicPdfRoot,
} = {}) {
    const version = await readPdfjsPackageVersion(root);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, PDFJS_VERSION_STAMP_FILE), `${version}\n`);
    return version;
}

export async function copyPdfjsAssets({
    root = pdfjsRoot,
    targetRoot = publicPdfRoot,
} = {}) {
    await mkdir(targetRoot, { recursive: true });
    // EVB patches the readable worker bundle to keep path-backed PDFs sparse.
    // The stable root also serves packaged Node search. The renderer binds to
    // the retained snapshot below, including lazy worker and companion loads.
    const workerSource = await readFile(join(root, 'build', 'pdf.worker.mjs'), 'utf8');
    await writeFile(
        join(targetRoot, 'pdf.worker.min.mjs'),
        await minifyPdfjsWorker(workerSource),
    );

    await cp(join(root, 'LICENSE_BROTLI'), join(targetRoot, 'LICENSE_BROTLI'));
    for (const directory of ASSET_DIRECTORIES) {
        await rm(join(targetRoot, directory), {
            recursive: true,
            force: true,
        });
        await cp(
            join(root, directory),
            join(targetRoot, directory),
            {
                filter: (source) => !PDFJS_DOCUMENTATION_FILE_PATTERN.test(basename(source)),
                recursive: true,
                force: true,
            },
        );
    }

    // The v6 Liberation license carries trailing spaces on several lines.
    // Normalize this text asset so generated public assets pass the repository
    // whitespace gate without changing the license text.
    const licensePath = join(targetRoot, PDFJS_LICENSE_FILE);
    try {
        const license = await readFile(licensePath, 'utf8');
        await writeFile(licensePath, license.replace(/[ \t]+$/gmu, ''));
    } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
    }

    await writePdfjsVersionStamp({
        root,
        targetRoot,
    });

    const assets = new Map();
    for (const file of [
        'pdf.worker.min.mjs',
        'LICENSE_BROTLI',
        PDFJS_VERSION_STAMP_FILE,
    ]) {
        assets.set(file, await readFile(join(targetRoot, file)));
    }
    for (const [
        directory,
        sourceRoot,
    ] of [
            ...ASSET_DIRECTORIES.map(directory => [
                directory,
                join(targetRoot, directory),
            ]),
            [
                'images',
                join(root, 'web', 'images'),
            ],
        ]) {
        for (const entry of await readdir(sourceRoot, {
            recursive: true,
            withFileTypes: true,
        })) {
            if (!entry.isFile()) continue;
            const source = join(entry.parentPath, entry.name);
            // Upstream licenses and SVGs include trailing spaces. Normalize the
            // retained text before hashing so it is suitable for tracked source.
            const bytes = /^(?:LICENSE(?:_|$))|\.svg$/u.test(entry.name)
                ? Buffer.from((await readFile(source, 'utf8')).replace(/[ \t]+$/gmu, ''))
                : await readFile(source);
            assets.set(`${directory}/${relative(sourceRoot, source).replaceAll('\\', '/')}`, bytes);
        }
    }
    const sortedAssets = [...assets].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const hash = createHash('sha256');
    for (const [
        file,
        bytes,
    ] of sortedAssets) {
        hash.update(`${file}\0${bytes.length}\0`).update(bytes);
    }
    const assetId = hash.digest('hex');
    const manifestPath = join(targetRoot, 'assets.json');
    let previousIds = [];
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        previousIds = typeof manifest === 'string' ? [manifest] : manifest;
        if (!Array.isArray(previousIds)
            || previousIds.some(id => typeof id !== 'string' || !PDFJS_ASSET_ID_PATTERN.test(id))) {
            throw new Error(`Invalid retained PDF.js identities in ${manifestPath}`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    // Retain the current build plus 3 previous identities. A tab open across
    // more than 3 PDF.js upgrades falls back to existing version-mismatch handling.
    const retainedIds = [...new Set([
        assetId,
        ...previousIds,
    ])].slice(0, 4);
    for (const [
        file,
        bytes,
    ] of sortedAssets) {
        const destination = join(targetRoot, assetId, file);
        await mkdir(dirname(destination), {recursive: true});
        await writeFile(destination, bytes);
    }
    for (const id of previousIds) {
        if (!retainedIds.includes(id)) {
            await rm(join(targetRoot, id), {
                recursive: true,
                force: true,
            });
        }
    }
    for (const entry of await readdir(targetRoot, {withFileTypes: true})) {
        if (entry.isDirectory() && PDFJS_ASSET_ID_PATTERN.test(entry.name)
            && !previousIds.includes(entry.name) && entry.name !== assetId) {
            console.warn(`Keeping unlisted PDF.js identity directory: ${join(targetRoot, entry.name)}`);
        }
    }
    await writeFile(manifestPath, `${JSON.stringify(retainedIds)}\n`);
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
    copyPdfjsAssets().catch((error) => {
        const message = error instanceof Error ? error.stack ?? getCliErrorMessage(error) : getCliErrorMessage(error);
        console.error(`Failed to copy PDF.js assets: ${message}`);
        process.exitCode = 1;
    });
}
