#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path, {
    basename,
    join,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const DMG_EXTENSION = '.dmg';
const MAC_METADATA_PATTERN = /^latest-mac.*\.yml$/u;

/** @typedef {{env?: NodeJS.ProcessEnv, stdio?: import('node:child_process').StdioOptions}} ISpawnOptions */
/** @typedef {(command: string, args: string[], options?: ISpawnOptions) => string} TCommandRunner */
/** @typedef {{ok: boolean, output: string}} ICommandResult */
/** @typedef {{sha512: string, size: number}} IArtifactFileInfo */
/** @typedef {{sha512: string, size: number | null, url: string}} IUpdaterFileEntry */
/** @typedef {{id?: string, status?: string}} INotaryResponse */
/** @typedef {{arch?: string, env?: NodeJS.ProcessEnv, platform?: string, projectRoot?: string}} IFindAppBuilderOptions */
/** @typedef {{arch?: string, artifactsDir?: string, env?: NodeJS.ProcessEnv, platform?: string, projectRoot?: string}} INotarizeMacDmgOptions */

/** @param {string} rawValue */
function parseYamlScalar(rawValue) {
    const trimmed = rawValue.trim().replace(/\s+#.*$/u, '');
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

/** @param {string} metadataFileName @param {string} artifactPath */
function assertSafeArtifactReference(metadataFileName, artifactPath) {
    if (
        artifactPath.startsWith('/')
        || /^[A-Za-z]:[\\/]/u.test(artifactPath)
        || artifactPath.split(/[\\/]/u).some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(`Unsafe path entry in ${metadataFileName}: ${artifactPath}`);
    }
    return artifactPath;
}

/** @param {string} command @param {string[]} args @param {ISpawnOptions} [options] */
function runCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        env: options.env ?? process.env,
        stdio: options.stdio ?? [
            'ignore',
            'pipe',
            'pipe',
        ],
    });

    if (result.status !== 0) {
        const output = [
            result.stdout,
            result.stderr,
        ].filter(Boolean).join('\n').trim();
        throw new Error(
            `Command failed (${command} ${args.join(' ')}): ${output}`,
        );
    }

    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** @param {string} command @param {string[]} args @param {ISpawnOptions} [options] */
function tryRunCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        env: options.env ?? process.env,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    return {
        ok: result.status === 0,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
}

/** @param {string} output @param {string} context @returns {INotaryResponse} */
function parseNotaryJson(output, context) {
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new Error(`${context} returned non-JSON output: ${output}`, { cause: error });
    }
}

/** @param {string} filePath @returns {IArtifactFileInfo} */
export function computeArtifactFileInfo(filePath) {
    return {
        sha512: createHash('sha512').update(readFileSync(filePath)).digest('base64'),
        size: statSync(filePath).size,
    };
}

/** @param {string} metadataFileName @param {string} metadataText @returns {IUpdaterFileEntry[]} */
export function parseMacUpdaterFileEntries(metadataFileName, metadataText) {
    /** @type {IUpdaterFileEntry[]} */
    const entries = [];
    /** @type {IUpdaterFileEntry | null} */
    let currentEntry = null;
    let inFiles = false;

    function pushCurrentEntry() {
        if (currentEntry === null) {
            return;
        }
        if (!currentEntry.sha512) {
            throw new Error(`Missing sha512 for ${currentEntry.url} in ${metadataFileName}`);
        }
        if (currentEntry.size === null) {
            throw new Error(`Missing size for ${currentEntry.url} in ${metadataFileName}`);
        }
        entries.push(currentEntry);
        currentEntry = null;
    }

    for (const line of metadataText.split(/\r?\n/u)) {
        if (/^files:\s*(?:#.*)?$/u.test(line)) {
            inFiles = true;
            continue;
        }

        if (!inFiles) {
            continue;
        }

        const urlMatch = line.match(/^ {2}- url:\s*(.+)$/u);
        if (urlMatch) {
            pushCurrentEntry();
            currentEntry = {
                sha512: '',
                size: null,
                url: assertSafeArtifactReference(
                    metadataFileName,
                    parseYamlScalar(urlMatch[1] ?? ''),
                ),
            };
            continue;
        }

        if (/^\S/u.test(line)) {
            pushCurrentEntry();
            inFiles = false;
            continue;
        }

        if (currentEntry === null) {
            continue;
        }

        const fieldMatch = line.match(/^ {4}(sha512|size):\s*(.+)$/u);
        if (!fieldMatch) {
            continue;
        }

        if (fieldMatch[1] === 'sha512') {
            currentEntry.sha512 = parseYamlScalar(fieldMatch[2] ?? '');
            continue;
        }

        const size = Number.parseInt(parseYamlScalar(fieldMatch[2] ?? ''), 10);
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Invalid size for ${currentEntry.url} in ${metadataFileName}: ${fieldMatch[2]}`);
        }
        currentEntry.size = size;
    }

    pushCurrentEntry();
    return entries;
}

/** @param {string} metadataFileName @param {string} metadataText @param {string} key @returns {string | null} */
function parseTopLevelScalar(metadataFileName, metadataText, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = metadataText.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, 'mu'));
    if (!match) {
        return null;
    }
    const value = parseYamlScalar(match[1] ?? '');
    return key === 'path'
        ? assertSafeArtifactReference(metadataFileName, value)
        : value;
}

/** @param {string} metadataText @param {string} key @param {string} value */
function replaceTopLevelScalar(metadataText, key, value) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`^${escapedKey}:\\s*.+$`, 'mu');
    if (!pattern.test(metadataText)) {
        return `${metadataText.replace(/\s*$/u, '')}\n${key}: ${value}\n`;
    }
    return metadataText.replace(pattern, `${key}: ${value}`);
}

/** @param {string} metadataFileName @param {string} metadataText @param {string} artifactName @param {IArtifactFileInfo} fileInfo */
export function updateMacUpdaterMetadataArtifactInfo(metadataFileName, metadataText, artifactName, fileInfo) {
    const lines = metadataText.split(/\r?\n/u);
    const output = [];
    let found = false;
    let inFiles = false;
    let inTargetEntry = false;
    let replacedSha512 = false;
    let replacedSize = false;

    function flushTargetEntry() {
        if (!inTargetEntry) {
            return;
        }
        if (!replacedSha512) {
            output.push(`    sha512: ${fileInfo.sha512}`);
        }
        if (!replacedSize) {
            output.push(`    size: ${fileInfo.size}`);
        }
        inTargetEntry = false;
        replacedSha512 = false;
        replacedSize = false;
    }

    for (const line of lines) {
        if (/^files:\s*(?:#.*)?$/u.test(line)) {
            inFiles = true;
            output.push(line);
            continue;
        }

        if (inFiles) {
            const urlMatch = line.match(/^ {2}- url:\s*(.+)$/u);
            if (urlMatch) {
                flushTargetEntry();
                inTargetEntry = parseYamlScalar(urlMatch[1] ?? '') === artifactName;
                found = found || inTargetEntry;
                output.push(line);
                continue;
            }

            if (/^\S/u.test(line)) {
                flushTargetEntry();
                inFiles = false;
                output.push(line);
                continue;
            }

            if (inTargetEntry && /^ {4}sha512:\s*/u.test(line)) {
                output.push(`    sha512: ${fileInfo.sha512}`);
                replacedSha512 = true;
                continue;
            }

            if (inTargetEntry && /^ {4}size:\s*/u.test(line)) {
                output.push(`    size: ${fileInfo.size}`);
                replacedSize = true;
                continue;
            }
        }

        output.push(line);
    }

    flushTargetEntry();

    if (!found) {
        throw new Error(`Updater metadata ${metadataFileName} does not reference ${artifactName}`);
    }

    let updatedText = output.join('\n');
    if (parseTopLevelScalar(metadataFileName, updatedText, 'path') === artifactName) {
        updatedText = replaceTopLevelScalar(updatedText, 'sha512', fileInfo.sha512);
    }
    return updatedText;
}

/** @param {{artifactNames?: string[] | undefined, artifactsDir?: string, readArtifactInfo?: ((artifactName: string) => IArtifactFileInfo) | undefined, readMetadataText?: ((metadataFileName: string) => string) | undefined}} [options] */
export function assertMacUpdaterMetadataHashes({
    artifactNames,
    artifactsDir = 'release',
    readArtifactInfo = artifactName => computeArtifactFileInfo(join(resolve(process.cwd(), artifactsDir), artifactName)),
    readMetadataText = metadataFileName => readFileSync(join(resolve(process.cwd(), artifactsDir), metadataFileName), 'utf8'),
} = {}) {
    const files = artifactNames ?? readdirSync(resolve(process.cwd(), artifactsDir));
    const metadataFileNames = files.filter(fileName => MAC_METADATA_PATTERN.test(fileName));

    for (const metadataFileName of metadataFileNames) {
        const metadataText = readMetadataText(metadataFileName);
        for (const entry of parseMacUpdaterFileEntries(metadataFileName, metadataText)) {
            const actualInfo = readArtifactInfo(entry.url);
            if (entry.sha512 !== actualInfo.sha512) {
                throw new Error(`Updater metadata hash mismatch in ${metadataFileName} -> ${entry.url}`);
            }
            if (entry.size !== actualInfo.size) {
                throw new Error(`Updater metadata size mismatch in ${metadataFileName} -> ${entry.url}`);
            }
        }

        const topLevelPath = parseTopLevelScalar(metadataFileName, metadataText, 'path');
        const topLevelSha512 = parseTopLevelScalar(metadataFileName, metadataText, 'sha512');
        if (topLevelPath && topLevelSha512) {
            const actualInfo = readArtifactInfo(topLevelPath);
            if (topLevelSha512 !== actualInfo.sha512) {
                throw new Error(`Updater metadata top-level hash mismatch in ${metadataFileName} -> ${topLevelPath}`);
            }
        }
    }

    return metadataFileNames.length > 0;
}

/** @param {NodeJS.ProcessEnv} env */
function hasNotaryCredentials(env) {
    return Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
}

/** @param {NodeJS.ProcessEnv} env */
function getNotaryCredentialArgs(env) {
    if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
        throw new Error('Apple notarization credentials are required');
    }
    return [
        '--key',
        env.APPLE_API_KEY,
        '--key-id',
        env.APPLE_API_KEY_ID,
        '--issuer',
        env.APPLE_API_ISSUER,
    ];
}

/** @param {string} rootDir @param {number} [depth] @returns {string | null} */
function findFirstAppBundle(rootDir, depth = 0) {
    if (depth > 4 || !existsSync(rootDir)) {
        return null;
    }

    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory() && entry.name.endsWith('.app')) {
            return entryPath;
        }
        if (entry.isDirectory()) {
            const nestedMatch = findFirstAppBundle(entryPath, depth + 1);
            if (nestedMatch) {
                return nestedMatch;
            }
        }
    }

    return null;
}

/** @param {string} artifactsDir @param {NodeJS.ProcessEnv} env */
function resolveDmgSigningIdentity(artifactsDir, env) {
    if (env.CSC_NAME?.trim()) {
        return env.CSC_NAME.trim();
    }

    const appPath = findFirstAppBundle(artifactsDir);
    if (appPath) {
        const metadata = runCommand('codesign', [
            '-dv',
            '--verbose=4',
            appPath,
        ], { env });
        const authorityMatch = metadata.match(/^Authority=(Developer ID Application:.+)$/mu);
        if (authorityMatch) {
            const authority = authorityMatch[1];
            if (authority !== undefined) {
                return authority.trim();
            }
        }
    }

    const identities = tryRunCommand('security', [
        'find-identity',
        '-v',
        '-p',
        'codesigning',
    ], { env });
    const identityMatch = identities.output.match(/\)\s+([A-Fa-f0-9]{40})\s+"Developer ID Application:[^"]+"/u);
    return identityMatch?.[1] ?? null;
}

/** @param {string} projectRoot @param {IFindAppBuilderOptions} [options] */
export function findAppBuilderExecutable(projectRoot, {
    arch = process.arch,
    env = process.env,
    platform = process.platform,
} = {}) {
    if (env.APP_BUILDER_BINARY && existsSync(env.APP_BUILDER_BINARY)) {
        return env.APP_BUILDER_BINARY;
    }

    const binRoot = join(projectRoot, 'node_modules', '.pnpm');
    const packageDir = readdirSync(binRoot)
        .filter(entry => entry.startsWith('app-builder-bin@'))
        .sort()
        .at(-1);
    if (!packageDir) {
        throw new Error('app-builder-bin is not installed');
    }

    const packageRoot = join(binRoot, packageDir, 'node_modules', 'app-builder-bin');
    const platformPart = platform === 'darwin'
        ? 'mac'
        : platform === 'win32'
            ? 'win'
            : 'linux';
    const archPart = arch === 'x64'
        ? 'amd64'
        : arch;
    const candidates = platform === 'darwin'
        ? [join(packageRoot, platformPart, `app-builder_${archPart}`)]
        : platform === 'win32'
            ? [join(packageRoot, platformPart, arch, 'app-builder.exe')]
            : [join(packageRoot, platformPart, arch, 'app-builder')];
    if (platform === process.platform && arch === process.arch) {
        // Resolved on demand so dependency-free release jobs can import this module.
        candidates.unshift(createRequire(import.meta.url)('app-builder-bin').appBuilderPath);
    }

    const executable = candidates.find(candidate => existsSync(candidate));
    if (!executable) {
        throw new Error(`No app-builder executable found for ${platform}-${arch}`);
    }
    // npm packages can lose the executable bit when installed through pnpm;
    // make the checked-in release tool dependency runnable before spawning it.
    chmodSync(executable, 0o755);
    return executable;
}

/** @param {string} dmgPath @param {string | null} signingIdentity @param {NodeJS.ProcessEnv} env */
function ensureSignedDmg(dmgPath, signingIdentity, env) {
    const signatureMetadata = tryRunCommand('codesign', [
        '-dv',
        '--verbose=4',
        dmgPath,
    ], { env });
    if (
        signatureMetadata.ok
        && /^Authority=Developer ID Application:/mu.test(signatureMetadata.output)
    ) {
        return;
    }

    if (!signingIdentity) {
        throw new Error(`Cannot sign ${dmgPath}; no Developer ID Application identity found`);
    }

    process.stdout.write(`[mac-dmg] Signing ${basename(dmgPath)}.\n`);
    runCommand('codesign', [
        '--force',
        '--sign',
        signingIdentity,
        '--timestamp',
        dmgPath,
    ], {
        env,
        stdio: 'inherit',
    });
}

/** @param {string} dmgPath @param {NodeJS.ProcessEnv} env */
function notarizeAndStapleDmg(dmgPath, env) {
    const existingTicket = tryRunCommand('xcrun', [
        'stapler',
        'validate',
        dmgPath,
    ], { env });
    if (existingTicket.ok) {
        process.stdout.write(`[mac-dmg] ${basename(dmgPath)} already has a valid stapled ticket.\n`);
        return;
    }

    process.stdout.write(`[mac-dmg] Submitting ${basename(dmgPath)} to Apple notary service.\n`);
    const submission = parseNotaryJson(runCommand('xcrun', [
        'notarytool',
        'submit',
        dmgPath,
        ...getNotaryCredentialArgs(env),
        '--output-format',
        'json',
        '--no-progress',
    ], { env }), 'notarytool submit');
    if (!submission.id) {
        throw new Error(`notarytool submit did not return a submission id: ${JSON.stringify(submission)}`);
    }

    process.stdout.write(`[mac-dmg] Waiting for notarization submission ${submission.id}.\n`);
    const notarization = waitForNotarization(submission.id, env);
    if (notarization.status !== 'Accepted') {
        throw new Error(`Notarization submission ${submission.id} finished with status ${notarization.status}`);
    }

    process.stdout.write(`[mac-dmg] Stapling ${basename(dmgPath)}.\n`);
    runCommand('xcrun', [
        'stapler',
        'staple',
        dmgPath,
    ], {
        env,
        stdio: 'inherit',
    });
    runCommand('xcrun', [
        'stapler',
        'validate',
        dmgPath,
    ], {
        env,
        stdio: 'inherit',
    });
}

/** @param {string} submissionId @param {NodeJS.ProcessEnv} env @returns {INotaryResponse} */
function waitForNotarization(submissionId, env) {
    const args = [
        ...getNotaryCredentialArgs(env),
        '--output-format',
        'json',
        '--no-progress',
    ];

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const waitResult = tryRunCommand('xcrun', [
            'notarytool',
            'wait',
            submissionId,
            ...args,
            '--timeout',
            '8m',
        ], { env });
        if (waitResult.ok) {
            return parseNotaryJson(waitResult.output, 'notarytool wait');
        }

        const infoResult = tryRunCommand('xcrun', [
            'notarytool',
            'info',
            submissionId,
            ...args,
        ], { env });
        if (infoResult.ok) {
            const info = parseNotaryJson(infoResult.output, 'notarytool info');
            if (info.status && info.status !== 'In Progress') {
                if (info.status === 'Invalid') {
                    const logResult = tryRunCommand('xcrun', [
                        'notarytool',
                        'log',
                        submissionId,
                        ...args,
                    ], { env });
                    throw new Error(`Notarization submission ${submissionId} was Invalid: ${logResult.output}`);
                }
                return info;
            }
        }

        if (attempt === 4) {
            throw new Error(`Timed out waiting for notarization submission ${submissionId}: ${waitResult.output}`);
        }
        process.stdout.write(`[mac-dmg] Notary wait attempt ${attempt} timed out; retrying ${submissionId}.\n`);
    }

    throw new Error(`Timed out waiting for notarization submission ${submissionId}`);
}

/** @param {string} dmgPath @param {string} projectRoot @param {NodeJS.ProcessEnv} env @param {{arch?: string, platform?: string}} [options] @returns {IArtifactFileInfo} */
function regenerateDmgBlockmap(dmgPath, projectRoot, env, {
    arch = process.arch,
    platform = process.platform,
} = {}) {
    const appBuilder = findAppBuilderExecutable(projectRoot, {
        arch,
        env,
        platform,
    });
    const blockmapPath = `${dmgPath}.blockmap`;
    process.stdout.write(`[mac-dmg] Regenerating ${basename(blockmapPath)}.\n`);
    const output = runCommand(appBuilder, [
        'blockmap',
        '--input',
        dmgPath,
        '--output',
        blockmapPath,
    ], { env });
    return /** @type {IArtifactFileInfo} */ (JSON.parse(output));
}

/** @param {string} artifactsDir @param {string} dmgPath @param {IArtifactFileInfo} fileInfo */
function updateMacMetadataFiles(artifactsDir, dmgPath, fileInfo) {
    const artifactName = basename(dmgPath);
    const metadataFileNames = readdirSync(artifactsDir)
        .filter(fileName => MAC_METADATA_PATTERN.test(fileName));

    let updateCount = 0;
    for (const metadataFileName of metadataFileNames) {
        const metadataPath = join(artifactsDir, metadataFileName);
        const metadataText = readFileSync(metadataPath, 'utf8');
        if (!parseMacUpdaterFileEntries(metadataFileName, metadataText).some(entry => entry.url === artifactName)) {
            continue;
        }

        writeFileSync(
            metadataPath,
            updateMacUpdaterMetadataArtifactInfo(metadataFileName, metadataText, artifactName, fileInfo),
        );
        updateCount += 1;
    }

    if (metadataFileNames.length > 0 && updateCount === 0) {
        throw new Error(`No macOS updater metadata references ${artifactName}`);
    }
}

/** @param {INotarizeMacDmgOptions} [options] */
export function notarizeMacDmgArtifacts({
    arch = process.arch,
    artifactsDir = 'release',
    env = process.env,
    platform = process.platform,
    projectRoot = process.cwd(),
} = {}) {
    const resolvedArtifactsDir = resolve(projectRoot, artifactsDir);
    if (platform !== 'darwin') {
        process.stdout.write('[mac-dmg] Skipping DMG notarization on non-macOS host.\n');
        return {
            processed: 0,
            skipped: true,
        };
    }
    if (!existsSync(resolvedArtifactsDir)) {
        process.stdout.write(`[mac-dmg] Skipping DMG notarization; ${artifactsDir}/ does not exist.\n`);
        return {
            processed: 0,
            skipped: true,
        };
    }
    if (!hasNotaryCredentials(env)) {
        process.stdout.write('[mac-dmg] APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER not set; skipping DMG notarization.\n');
        return {
            processed: 0,
            skipped: true,
        };
    }

    const dmgPaths = readdirSync(resolvedArtifactsDir)
        .filter(fileName => fileName.endsWith(DMG_EXTENSION))
        .map(fileName => join(resolvedArtifactsDir, fileName))
        .sort();
    if (dmgPaths.length === 0) {
        process.stdout.write('[mac-dmg] No DMG artifacts found; nothing to notarize.\n');
        return {
            processed: 0,
            skipped: true,
        };
    }

    const signingIdentity = resolveDmgSigningIdentity(resolvedArtifactsDir, env);
    for (const dmgPath of dmgPaths) {
        ensureSignedDmg(dmgPath, signingIdentity, env);
        notarizeAndStapleDmg(dmgPath, env);
        const fileInfo = regenerateDmgBlockmap(dmgPath, projectRoot, env, {
            arch,
            platform,
        });
        updateMacMetadataFiles(resolvedArtifactsDir, dmgPath, fileInfo);
    }

    assertMacUpdaterMetadataHashes({ artifactsDir: resolvedArtifactsDir });
    return {
        processed: dmgPaths.length,
        skipped: false,
    };
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    notarizeMacDmgArtifacts({ artifactsDir: process.argv[2] ?? 'release' });
}
