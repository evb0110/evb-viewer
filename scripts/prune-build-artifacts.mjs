import {readdir, realpath, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const buildRoots = ['dist-electron', 'nuxt-output', '.vercel/output', '.output'];

const removableDirectoryNames = new Set(['__tests__', 'coverage']);

const removableFilePatterns = [
    /\.map$/u,
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
    // Dev-only favicons referenced exclusively behind isDev in nuxt.config.ts.
    /^favicon-dev[.-]/u,
];

const removablePathSegmentPatterns = [/^tests?$/u, /^\.vitest$/u, /^\.playwright$/u];

function shouldRemoveEntry(entryName, isDirectory) {
    if (isDirectory) {
        return removableDirectoryNames.has(entryName) || removablePathSegmentPatterns.some((pattern) => pattern.test(entryName));
    }

    return removableFilePatterns.some((pattern) => pattern.test(entryName));
}

export async function pruneDirectory(dirPath) {
    const entries = await readdir(dirPath, {withFileTypes: true});
    let removedCount = 0;

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const isDirectory = entry.isDirectory();

        // Traced server dependencies are executable input, not app-owned build
        // debris. Package authors may legitimately expose runtime modules from
        // directories or files whose names resemble tests.
        if (isDirectory && entry.name === 'node_modules') {
            continue;
        }

        if (shouldRemoveEntry(entry.name, isDirectory)) {
            await rm(entryPath, {
                recursive: true,
                force: true,
            });
            removedCount += 1;
            continue;
        }

        if (isDirectory) {
            removedCount += await pruneDirectory(entryPath);
        }
    }

    return removedCount;
}

function assertSafeBuildRoot(rootDirectory, buildRoot, configuredRoot) {
    const relativePath = path.relative(rootDirectory, buildRoot);
    if (
        path.isAbsolute(configuredRoot) ||
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(`Refusing to prune build root outside the project: ${configuredRoot}`);
    }
}

async function pruneBuildRoot(rootDirectory, relativeRoot) {
    const canonicalRootDirectory = await realpath(path.resolve(rootDirectory));
    const requestedRoot = path.resolve(canonicalRootDirectory, relativeRoot);
    assertSafeBuildRoot(canonicalRootDirectory, requestedRoot, relativeRoot);

    let root;
    try {
        root = await realpath(requestedRoot);
        assertSafeBuildRoot(canonicalRootDirectory, root, relativeRoot);
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) {
            return 0;
        }
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return 0;
        }
        throw error;
    }

    return pruneDirectory(root);
}

export async function pruneBuildArtifacts({rootDirectory = projectRoot, roots = buildRoots} = {}) {
    let totalRemoved = 0;
    for (const buildRoot of roots) {
        totalRemoved += await pruneBuildRoot(rootDirectory, buildRoot);
    }

    return totalRemoved;
}

async function isDirectCliInvocation() {
    if (!process.argv[1]) {
        return false;
    }

    const [invokedPath, modulePath] = await Promise.all([
        realpath(path.resolve(process.argv[1])).catch(() => null),
        realpath(fileURLToPath(import.meta.url)).catch(() => null),
    ]);
    return invokedPath !== null && invokedPath === modulePath;
}

if (await isDirectCliInvocation()) {
    const totalRemoved = await pruneBuildArtifacts();
    if (totalRemoved > 0) {
        console.log(`Pruned ${totalRemoved} unnecessary build artifact(s).`);
    }
}
