import {execFileSync} from 'node:child_process';
import {open, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** @typedef {(args: string[], options?: object) => string} TReadelf */

/** @param {string} left @param {string} right */
export function compareNumericVersions(left, right) {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/** @param {string} versionInfo */
export function extractRequiredGlibcVersions(versionInfo) {
    return [
        ...new Set([...versionInfo.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))),
    ].sort(compareNumericVersions);
}

/** @param {string} directory @returns {Promise<string[]>} */
async function collectFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(filePath)));
        } else if (entry.isFile()) {
            files.push(filePath);
        }
    }
    return files;
}

/** @param {string} filePath */
async function isElfFile(filePath) {
    const handle = await open(filePath, 'r');
    try {
        const magic = Buffer.alloc(4);
        const {bytesRead} = await handle.read(magic, 0, magic.byteLength, 0);
        return bytesRead === magic.byteLength && magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
    } finally {
        await handle.close();
    }
}

/**
 * @param {string} rootDirectory
 * @param {string} maximumVersion
 * @param {{runReadelf?: TReadelf}} [options]
 */
export async function assertLinuxGlibcBaseline(
    rootDirectory,
    maximumVersion,
    {runReadelf = (args, options) => String(execFileSync('readelf', args, options))} = {},
) {
    runReadelf(['--version'], {stdio: 'ignore'});
    /** @type {string[]} */
    const failures = [];
    let elfFileCount = 0;
    for (const filePath of await collectFiles(resolve(rootDirectory))) {
        if (!(await isElfFile(filePath))) {
            continue;
        }
        elfFileCount += 1;
        let versionInfo;
        try {
            versionInfo = runReadelf(['--version-info', filePath], {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            const stderr =
                error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
            throw new Error(`readelf could not inspect ELF file ${filePath}${stderr ? `: ${stderr}` : ''}`, {cause: error});
        }
        const newestVersion = extractRequiredGlibcVersions(versionInfo).at(-1);
        if (newestVersion && compareNumericVersions(newestVersion, maximumVersion) > 0) {
            failures.push(`${filePath}: GLIBC_${newestVersion}`);
        }
    }
    if (elfFileCount === 0) {
        throw new Error(`No ELF files found below ${rootDirectory}`);
    }
    if (failures.length > 0) {
        throw new Error(`Linux package exceeds the GLIBC_${maximumVersion} compatibility baseline:\n${failures.join('\n')}`);
    }
    return {elfFileCount};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [rootDirectory, maximumVersion] = process.argv.slice(2);
    if (!rootDirectory || maximumVersion === undefined || !/^\d+(?:\.\d+)+$/u.test(maximumVersion)) {
        throw new Error('Usage: assert-linux-glibc-baseline.mjs <package-root> <maximum-version>');
    }
    const result = await assertLinuxGlibcBaseline(rootDirectory, maximumVersion);
    process.stdout.write(`Verified ${result.elfFileCount} ELF files against GLIBC_${maximumVersion}.\n`);
}
