import {
    cp,
    readFile,
    mkdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { transform } from 'esbuild';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';

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

const PDFJS_VERSION_STAMP_FILE = '.pdfjs-version';
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
    for (const directory of ASSET_DIRECTORIES) {
        await rm(join(targetRoot, directory), {
            recursive: true,
            force: true,
        });
        await mkdir(join(targetRoot, directory), { recursive: true });
    }

    // EVB patches the readable worker bundle to keep path-backed PDFs sparse.
    // Keep the public filename stable for the viewer asset resolver, while
    // restoring a bounded minified asset for browser delivery.
    const workerSource = await readFile(join(root, 'build', 'pdf.worker.mjs'), 'utf8');
    await writeFile(
        join(targetRoot, 'pdf.worker.min.mjs'),
        await minifyPdfjsWorker(workerSource),
    );

    for (const directory of ASSET_DIRECTORIES) {
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

    await writePdfjsVersionStamp({
        root,
        targetRoot,
    });
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
    copyPdfjsAssets().catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`Failed to copy PDF.js assets: ${message}`);
        process.exitCode = 1;
    });
}
