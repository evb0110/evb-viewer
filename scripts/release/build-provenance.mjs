import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** @typedef {{path: string, sha256: string, size: number}} IProvenanceFile */
/** @typedef {{byteLength: number, fileCount: number, files: IProvenanceFile[], sha256: string}} IProvenancePayload */
/** @typedef {{schemaVersion?: number, commitSha?: string, version?: string, arch?: string, channel?: string, lockfileSha256?: string, appAsar?: {sha256?: string}, payload?: IProvenancePayload}} IProvenance */
/** @typedef {{appAsarPath: string, arch: string, channel: string, outputPath: string}} IBuildProvenanceOptions */

/** @param {string} filePath */
async function sha256(filePath) {
    return createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex');
}

/** @param {string} left @param {string} right */
function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/** @param {string} rootPath @param {string} [currentPath] @returns {Promise<IProvenanceFile[]>} */
async function collectPayloadFiles(rootPath, currentPath = rootPath) {
    const entries = await readdir(currentPath, {withFileTypes: true});
    const files = [];

    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
        const absolutePath = join(currentPath, entry.name);
        const fileStat = await lstat(absolutePath);
        const relativePath = absolutePath.slice(rootPath.length + 1).replaceAll('\\', '/');

        if (fileStat.isSymbolicLink()) {
            throw new Error(`Packaged payload contains a symbolic link: ${relativePath}`);
        }
        if (fileStat.isDirectory()) {
            files.push(...(await collectPayloadFiles(rootPath, absolutePath)));
            continue;
        }
        if (!fileStat.isFile()) {
            throw new Error(`Packaged payload contains a non-regular entry: ${relativePath}`);
        }

        files.push({
            path: relativePath,
            sha256: await sha256(absolutePath),
            size: fileStat.size,
        });
    }

    return files.sort((left, right) => compareCodeUnits(left.path, right.path));
}

/** @param {IProvenanceFile[]} files */
function hashPayloadManifest(files) {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
    }
    return hash.digest('hex');
}

/** @param {string} appAsarPath @returns {Promise<IProvenancePayload>} */
async function createPayloadProvenance(appAsarPath) {
    const rootPath = resolve(appAsarPath, '..', '..');
    const files = await collectPayloadFiles(rootPath);
    return {
        byteLength: files.reduce((total, file) => total + file.size, 0),
        fileCount: files.length,
        files,
        sha256: hashPayloadManifest(files),
    };
}

/** @param {IBuildProvenanceOptions} options */
export async function createBuildProvenance({appAsarPath, arch, channel, outputPath}) {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    const provenance = {
        schemaVersion: 2,
        commitSha: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        version: packageJson.version,
        arch,
        channel,
        appAsar: {
            name: basename(appAsarPath),
            sha256: await sha256(appAsarPath),
        },
        payload: await createPayloadProvenance(appAsarPath),
        lockfileSha256: await sha256(resolve('pnpm-lock.yaml')),
    };
    await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    return provenance;
}

/** @param {string} directPath @param {string} storePath */
export async function assertMatchingBuildProvenance(directPath, storePath) {
    const direct = /** @type {IProvenance} */ (JSON.parse(await readFile(directPath, 'utf8')));
    const store = /** @type {IProvenance} */ (JSON.parse(await readFile(storePath, 'utf8')));
    for (const field of /** @type {(keyof IProvenance)[]} */ (['schemaVersion', 'commitSha', 'version', 'arch', 'lockfileSha256'])) {
        if (direct[field] !== store[field]) {
            throw new Error(`Build provenance mismatch for ${field}: direct=${direct[field]} store=${store[field]}`);
        }
    }
    if (direct.appAsar?.sha256 !== store.appAsar?.sha256) {
        throw new Error(`Packaged app.asar hash mismatch: direct=${direct.appAsar?.sha256} store=${store.appAsar?.sha256}`);
    }
    if (!direct.payload || !store.payload) {
        throw new Error('Complete packaged payload provenance is required for direct-download and Store parity.');
    }
    for (const field of /** @type {(keyof IProvenancePayload)[]} */ (['sha256', 'fileCount', 'byteLength'])) {
        if (direct.payload[field] !== store.payload[field]) {
            throw new Error(
                `Packaged payload provenance mismatch for ${field}: direct=${direct.payload[field]} store=${store.payload[field]}`,
            );
        }
    }
    const directFiles = direct.payload.files ?? [];
    const storeFiles = store.payload.files ?? [];
    if (JSON.stringify(directFiles) !== JSON.stringify(storeFiles)) {
        for (let index = 0; index < Math.max(directFiles.length, storeFiles.length); index += 1) {
            const directFile = directFiles[index];
            const storeFile = storeFiles[index];
            if (JSON.stringify(directFile) !== JSON.stringify(storeFile)) {
                throw new Error(
                    'Complete packaged payload file manifest mismatch between direct-download and Store packages: ' +
                        `direct=${directFile?.path ?? '<missing>'} store=${storeFile?.path ?? '<missing>'}`,
                );
            }
        }
    }
    return {
        direct,
        store,
    };
}

/** @param {string[]} argv @returns {Promise<void>} */
async function main(argv) {
    const [command, ...args] = argv;
    if (command === 'create' && args.length === 4) {
        const [channel, arch, appAsarPath, outputPath] = args;
        if (channel !== undefined && arch !== undefined && appAsarPath !== undefined && outputPath !== undefined) {
            await createBuildProvenance({
                appAsarPath,
                arch,
                channel,
                outputPath,
            });
            return;
        }
    }
    if (command === 'assert-match' && args.length === 2) {
        const [directPath, storePath] = args;
        if (directPath !== undefined && storePath !== undefined) {
            await assertMatchingBuildProvenance(directPath, storePath);
            process.stdout.write('Direct-download and Store packaged application provenance matches.\n');
            return;
        }
    }
    throw new Error(
        'Usage: build-provenance.mjs create <channel> <arch> <app.asar> <output.json> | assert-match <direct.json> <store.json>',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    await main(process.argv.slice(2));
}
