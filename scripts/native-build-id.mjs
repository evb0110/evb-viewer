import { createHash } from 'node:crypto';
import {
    existsSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import path from 'node:path';

export const NATIVE_TOOL_CRATES = [
    'pdf-image-combine',
    'pdf-page-ops',
    'pdf-search',
    'scan-cleanup',
];

const WORKSPACE_FILES = [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
];

/** @param {string} nativeRoot @param {string} crateName @returns {string[]} */
function crateClosure(nativeRoot, crateName) {
    const closure = new Set();
    const pending = [crateName];
    while (pending.length > 0) {
        const name = /** @type {string} */ (pending.pop());
        if (closure.has(name)) {
            continue;
        }
        closure.add(name);
        const manifest = readFileSync(path.join(nativeRoot, name, 'Cargo.toml'), 'utf8');
        for (const match of manifest.matchAll(/\bpath\s*=\s*"\.\.\/([^"/]+)"/gu)) {
            pending.push(/** @type {string} */ (match[1]));
        }
    }
    return [...closure].sort();
}

/** @param {string} directory @returns {string[]} */
function listFiles(directory) {
    return readdirSync(directory, {
        recursive: true,
        withFileTypes: true,
    })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name));
}

/**
 * Hash of the sources one native tool is compiled from: the workspace manifests
 * and the manifest, build script and `src/` of every workspace crate it links.
 * `build-native-tool.mjs` compiles it into the binary and `build-electron.mjs`
 * embeds it in the app, which compares the two before first use. The browser
 * WASM builds reuse it to decide whether `public/wasm` is current.
 *
 * @param {string} projectRoot
 * @param {string} crateName
 * @returns {string}
 */
export function computeNativeBuildId(projectRoot, crateName) {
    const nativeRoot = path.join(projectRoot, 'native');
    const files = WORKSPACE_FILES.map(name => path.join(nativeRoot, name));
    for (const name of crateClosure(nativeRoot, crateName)) {
        files.push(path.join(nativeRoot, name, 'Cargo.toml'), ...listFiles(path.join(nativeRoot, name, 'src')));
        const buildScript = path.join(nativeRoot, name, 'build.rs');
        if (existsSync(buildScript)) {
            files.push(buildScript);
        }
    }
    const hash = createHash('sha256');
    for (const file of files.map(filePath => path.relative(nativeRoot, filePath).split(path.sep).join('/')).sort()) {
        hash.update(`${file}\0`);
        hash.update(readFileSync(path.join(nativeRoot, file)));
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}

/** Build IDs keyed by binary name, as the app embeds them. @param {string} projectRoot @returns {Record<string, string>} */
export function computeNativeBuildIds(projectRoot) {
    return Object.fromEntries(NATIVE_TOOL_CRATES.map(crateName => [
        `evb-${crateName}`,
        computeNativeBuildId(projectRoot, crateName),
    ]));
}
