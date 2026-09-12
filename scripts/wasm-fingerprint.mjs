import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {
    lstat,
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const WASM_MAGIC = Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
]);
const FINGERPRINT_PREFIX = 'v1:';

export const WASM_FINGERPRINT_SCHEMA_VERSION = 1;
export const WASM_FINGERPRINT_SECTION_NAME = 'evb-source-fingerprint';

const WASM_FINGERPRINT_INPUTS = [
    '.cargo',
    'native',
    'scripts/build-wasm-tool.mjs',
    'scripts/check-wasm-freshness.mjs',
    'scripts/wasm-artifacts.mjs',
    'scripts/wasm-fingerprint.mjs',
];
const IGNORED_DIRECTORY_NAMES = new Set([
    '.git',
    'target',
]);
const IGNORED_FILE_NAMES = new Set(['auto-imports.d.ts']);

/** @typedef {{path: string, relativePath: string}} IWasmFingerprintFile */
/** @typedef {{offset: number, value: number}} IUnsignedLeb128 */
/** @typedef {{projectRoot?: string | undefined, rustflags?: string | undefined, rustcCommitHash?: string | undefined}} IWasmFingerprintOptions */
/** @typedef {{code?: string | undefined}} INodeError */
/** @typedef {typeof import('./wasm-artifacts.mjs').WASM_ARTIFACTS[number]} IWasmArtifact */

/** @param {unknown} value @returns {value is INodeError} */
function isNodeError(value) {
    return typeof value === 'object' && value !== null;
}

/** @param {number} value @returns {Buffer} */
function encodeUnsignedLeb128(value) {
    const bytes = [];
    let remaining = value;
    do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining !== 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining !== 0);
    return Buffer.from(bytes);
}

/** @param {Buffer} bytes @param {number} start @returns {IUnsignedLeb128 | null} */
function readUnsignedLeb128(bytes, start) {
    let value = 0;
    let shift = 0;
    let offset = start;
    while (offset < bytes.length && shift <= 28) {
        const byte = bytes[offset++];
        if (byte === undefined) {
            return null;
        }
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) {
            return {
                offset,
                value,
            };
        }
        shift += 7;
    }
    return null;
}

/** @param {string} sourcePath @param {string} relativePath @param {IWasmFingerprintFile[]} files @returns {Promise<void>} */
async function collectFiles(sourcePath, relativePath, files) {
    let metadata;
    try {
        metadata = await lstat(sourcePath);
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    if (metadata.isSymbolicLink()) {
        return;
    }
    if (metadata.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(path.basename(sourcePath))) {
            return;
        }
        const entries = await readdir(sourcePath, {withFileTypes: true});
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            await collectFiles(
                path.join(sourcePath, entry.name),
                path.posix.join(relativePath, entry.name),
                files,
            );
        }
        return;
    }
    if (metadata.isFile()) {
        if (IGNORED_FILE_NAMES.has(path.basename(sourcePath))) {
            return;
        }
        files.push({
            path: sourcePath,
            relativePath,
        });
    }
}

/** @param {string} root @returns {Promise<IWasmFingerprintFile[]>} */
async function getWasmFingerprintInputFiles(root) {
    /** @type {IWasmFingerprintFile[]} */
    const files = [];
    for (const relativePath of WASM_FINGERPRINT_INPUTS) {
        await collectFiles(
            path.join(root, relativePath),
            relativePath,
            files,
        );
    }
    files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    return files;
}

/** @param {IWasmArtifact} artifact @param {IWasmFingerprintOptions} [options] @returns {Promise<string>} */
export async function computeWasmSourceFingerprint(artifact, {
    projectRoot: root = projectRoot,
    rustflags = '',
    rustcCommitHash: configuredRustcCommitHash,
} = {}) {
    const rustcCommitHash = configuredRustcCommitHash ?? await (async () => {
        const {stdout: rustcVersion} = await execFileAsync('rustc', ['-vV'], {
            cwd: root,
            encoding: 'utf8',
        });
        return rustcVersion.match(/^commit-hash:\s*(\S+)/mu)?.[1] ?? rustcVersion.trim();
    })();
    const hash = createHash('sha256');
    hash.update(JSON.stringify({
        artifact: {
            builtFileName: artifact.builtFileName,
            crateName: artifact.crateName,
            manifestPath: artifact.manifestPath,
            publicRelativePath: artifact.publicRelativePath,
            requiredExports: artifact.requiredExports,
            rustflags,
        },
        cargoArgs: [
            'build',
            '--release',
            '--locked',
            '--target',
            'wasm32-unknown-unknown',
            '--lib',
        ],
        schemaVersion: WASM_FINGERPRINT_SCHEMA_VERSION,
        rustcCommitHash,
    }));
    hash.update('\0');

    for (const file of await getWasmFingerprintInputFiles(root)) {
        hash.update(file.relativePath);
        hash.update('\0');
        hash.update(await readFile(file.path));
        hash.update('\0');
    }

    return hash.digest('hex');
}

/** @param {Uint8Array} wasmBytes @param {string} fingerprint @returns {Buffer} */
export function stampWasmArtifact(wasmBytes, fingerprint) {
    const bytes = Buffer.from(wasmBytes);
    if (!bytes.subarray(0, WASM_MAGIC.length).equals(WASM_MAGIC)) {
        throw new Error('Cannot stamp an invalid WASM module');
    }
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
        throw new Error(`Invalid WASM source fingerprint: ${fingerprint}`);
    }

    const name = Buffer.from(WASM_FINGERPRINT_SECTION_NAME, 'utf8');
    const data = Buffer.from(`${FINGERPRINT_PREFIX}${fingerprint}`, 'utf8');
    const payload = Buffer.concat([
        encodeUnsignedLeb128(name.byteLength),
        name,
        data,
    ]);
    return Buffer.concat([
        bytes,
        Buffer.from([0]),
        encodeUnsignedLeb128(payload.byteLength),
        payload,
    ]);
}

/** @param {Uint8Array} wasmBytes @returns {string | null} */
export function getWasmArtifactFingerprint(wasmBytes) {
    const bytes = Buffer.from(wasmBytes);
    if (!bytes.subarray(0, WASM_MAGIC.length).equals(WASM_MAGIC)) {
        return null;
    }

    let offset = WASM_MAGIC.length;
    let fingerprint = null;
    while (offset < bytes.length) {
        const sectionId = bytes[offset++];
        const sectionLength = readUnsignedLeb128(bytes, offset);
        if (!sectionLength) {
            return null;
        }
        const sectionStart = sectionLength.offset;
        const sectionEnd = sectionStart + sectionLength.value;
        if (sectionEnd > bytes.length) {
            return null;
        }
        if (sectionId === 0) {
            const nameLength = readUnsignedLeb128(bytes, sectionStart);
            if (!nameLength) {
                return null;
            }
            const nameEnd = nameLength.offset + nameLength.value;
            if (nameEnd > sectionEnd) {
                return null;
            }
            const name = bytes.subarray(nameLength.offset, nameEnd).toString('utf8');
            if (name === WASM_FINGERPRINT_SECTION_NAME) {
                const value = bytes.subarray(nameEnd, sectionEnd).toString('utf8');
                if (value.startsWith(FINGERPRINT_PREFIX) && /^[0-9a-f]{64}$/u.test(value.slice(FINGERPRINT_PREFIX.length))) {
                    fingerprint = value.slice(FINGERPRINT_PREFIX.length);
                }
            }
        }
        offset = sectionEnd;
    }
    return fingerprint;
}
