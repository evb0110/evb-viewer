export function hasDeveloperIdSigningCredentials(env = process.env) {
    return Boolean(env.CSC_LINK && env.CSC_KEY_PASSWORD);
}

const GATE_POLICY_MANIFEST = Object.freeze({
    release: {
        localChecks: {
            gateGroups: [
                {
                    id: 'lint-static',
                    owner: 'release',
                    scripts: ['check:electron:install', 'check:electron-builder:asar-unpack'],
                },
            ],
            owner: 'release',
        },
        localVerify: {
            gates: [
                {
                    args: ['run', 'release:verify:checks'],
                    command: 'pnpm',
                    id: 'checks',
                    owner: 'release',
                },
                {
                    args: ['run', 'release:verify:package:local'],
                    command: 'pnpm',
                    id: 'package-local',
                    owner: 'release',
                },
            ],
            owner: 'release',
        },
    },
    schemaVersion: 2,
});

/** @param {IGateCommand} gate @returns {IGateCommand} */
function cloneGateCommand(gate) {
    return {
        args: [...gate.args],
        command: gate.command,
    };
}

export function getGatePolicyManifest() {
    return {
        release: {
            localChecks: {
                gateGroups: GATE_POLICY_MANIFEST.release.localChecks.gateGroups.map((group) => ({
                    id: group.id,
                    owner: group.owner,
                    scripts: [...group.scripts],
                })),
                owner: GATE_POLICY_MANIFEST.release.localChecks.owner,
            },
            localVerify: {
                gates: GATE_POLICY_MANIFEST.release.localVerify.gates.map((gate) => ({
                    ...cloneGateCommand(gate),
                    id: gate.id,
                    owner: gate.owner,
                })),
                owner: GATE_POLICY_MANIFEST.release.localVerify.owner,
            },
        },
        schemaVersion: GATE_POLICY_MANIFEST.schemaVersion,
    };
}

export function getLocalReleaseCheckGateScripts() {
    return GATE_POLICY_MANIFEST.release.localChecks.gateGroups.flatMap((group) => group.scripts);
}

export function getLocalReleaseVerifyGateCommands() {
    return GATE_POLICY_MANIFEST.release.localVerify.gates.map(cloneGateCommand);
}

/** @param {IReleaseTarget} target @param {NodeJS.ProcessEnv} [env] @returns {boolean} */
export function expectsUpdaterMetadata(target, env = process.env) {
    if (!target.expectsUpdaterMetadata) {
        return false;
    }

    if (target.platform === 'mac' && !hasMacPublishUpdaterMetadataPolicy(env)) {
        return false;
    }

    return true;
}

/** @param {NodeJS.Platform} [nodePlatform] @returns {'mac' | 'linux' | 'win'} */
export function detectHostReleasePlatform(nodePlatform = process.platform) {
    switch (nodePlatform) {
        case 'darwin':
            return 'mac';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'win';
        default:
            throw new Error(`Unsupported local release platform "${nodePlatform}"`);
    }
}

/** @param {{platform?: NodeJS.Platform, arch?: string}} [options] @returns {IReleaseTarget[]} */
export function getLocalReleaseTargets(options = {}) {
    const platform = detectHostReleasePlatform(options.platform ?? process.platform);
    const arch = options.arch ?? process.arch;

    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Unsupported local release arch "${arch}"`);
    }

    // Local packaging verifies the current host package only. Cross-arch macOS
    // packages require matching bundled native-tool resources and are covered by
    // the GitHub release/build matrix on the corresponding runner architecture.
    const targetArchs = [arch];

    return targetArchs.map((targetArch) => ({
        arch: targetArch,
        expectsUpdaterMetadata: (platform === 'mac' && targetArch === 'arm64') || platform === 'win',
        isPrimaryHostTarget: targetArch === arch,
        platform,
    }));
}

/** @param {IReleaseTarget} target @param {NodeJS.ProcessEnv} [env] @returns {RegExp[]} */
export function getRequiredArtifactPatterns(target, env = process.env) {
    switch (target.platform) {
        case 'mac':
            // Unsigned local mac verification prunes updater metadata; the DMG
            // is the release-critical manual-install artifact in that mode.
            return expectsUpdaterMetadata(target, env) ? [/\.dmg$/, /\.zip$/] : [/\.dmg$/];
        case 'linux':
            return [/\.deb$/];
        case 'win':
            return [/\.exe$/];
        default:
            return [];
    }
}

/** @param {IReleaseTarget} target @param {NodeJS.ProcessEnv} [env] @returns {boolean} */
export function shouldVerifyPackagedStartup(target, env = process.env) {
    return target.platform === 'mac' && hasDeveloperIdSigningCredentials(env);
}

export function hasMacPublishUpdaterMetadataPolicy(env = process.env) {
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'true') {
        return true;
    }
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'false') {
        return false;
    }
    return hasDeveloperIdSigningCredentials(env);
}

/** @param {Iterable<string>} artifactNames @param {NodeJS.ProcessEnv} [env] */
export function assertPublishUpdaterMetadataPolicy(artifactNames, env = process.env) {
    const files = [...artifactNames];
    const hasMacPolicy = hasMacPublishUpdaterMetadataPolicy(env);
    const forbidden = files.filter((fileName) => {
        if (/^latest-mac.*\.yml$/u.test(fileName)) {
            return !hasMacPolicy;
        }
        if (/^latest(?:-win(?:-.*)?)?\.yml$/u.test(fileName)) {
            return false;
        }
        if (/^latest.*\.yml$/u.test(fileName)) {
            return true;
        }
        if (fileName.endsWith('.dmg.blockmap') || fileName.endsWith('.zip.blockmap')) {
            return !hasMacPolicy;
        }
        if (fileName.endsWith('.exe.blockmap')) {
            return false;
        }
        return fileName.endsWith('.blockmap');
    });

    if (forbidden.length > 0) {
        throw new Error('Release artifacts include updater metadata forbidden by publish policy: ' + forbidden.sort().join(', '));
    }
}

/** @param {Iterable<string>} artifactNames @returns {string[]} */
export function getUpdaterMetadataFileNames(artifactNames) {
    return [...artifactNames].filter((fileName) => /^latest.*\.yml$/u.test(fileName));
}

/** @param {string} metadataFileName @param {string} metadataText @returns {string} */
export function parseUpdaterMetadataVersion(metadataFileName, metadataText) {
    const versionLine = metadataText.split(/\r?\n/u).find((line) => /^version:\s*/u.test(line));
    if (!versionLine) {
        throw new Error(`Missing version entry in ${metadataFileName}`);
    }
    const match = versionLine.match(/^version:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
    if (!match) {
        throw new Error(`Unsupported version entry in ${metadataFileName}: ${versionLine}`);
    }
    const version = match[1] ?? match[2] ?? match[3];
    if (version === undefined) {
        throw new Error(`Missing version value in ${metadataFileName}`);
    }
    return version;
}

/** @param {Iterable<string>} artifactNames @param {TReadMetadata} readMetadataText @param {string} expectedVersion */
export function assertUpdaterMetadataVersion(artifactNames, readMetadataText, expectedVersion) {
    for (const metadataFileName of getUpdaterMetadataFileNames(artifactNames)) {
        const actualVersion = parseUpdaterMetadataVersion(metadataFileName, readMetadataText(metadataFileName));
        if (actualVersion !== expectedVersion) {
            throw new Error(`Updater metadata version mismatch in ${metadataFileName}: expected ${expectedVersion}, got ${actualVersion}`);
        }
    }
}

/** @param {string} metadataFileName @param {string} artifactPath @returns {string} */
function assertSafeArtifactReference(metadataFileName, artifactPath) {
    if (
        artifactPath.startsWith('/') ||
        /^[A-Za-z]:[\\/]/u.test(artifactPath) ||
        artifactPath.split(/[\\/]/u).some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(`Unsafe path entry in ${metadataFileName}: ${artifactPath}`);
    }

    return artifactPath;
}

/** @param {string} metadataFileName @param {string} metadataText @returns {string} */
export function parseUpdaterMetadataPath(metadataFileName, metadataText) {
    const pathLine = metadataText.split(/\r?\n/u).find((line) => /^path:\s*/u.test(line));

    if (!pathLine) {
        throw new Error(`Missing path entry in ${metadataFileName}`);
    }

    const match = pathLine.match(/^path:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
    if (!match) {
        throw new Error(`Unsupported path entry in ${metadataFileName}: ${pathLine}`);
    }

    const artifactPath = match[1] ?? match[2] ?? match[3];
    if (artifactPath === undefined) {
        throw new Error(`Missing path value in ${metadataFileName}`);
    }
    return assertSafeArtifactReference(metadataFileName, artifactPath);
}

/** @param {string} metadataFileName @param {string} metadataText @returns {string[]} */
export function parseUpdaterMetadataFileUrls(metadataFileName, metadataText) {
    const urls = [];

    for (const line of metadataText.split(/\r?\n/u)) {
        const match = line.match(/^\s*(?:-\s*)?url:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
        if (!match) {
            continue;
        }
        const artifactPath = match[1] ?? match[2] ?? match[3];
        if (artifactPath !== undefined) {
            urls.push(assertSafeArtifactReference(metadataFileName, artifactPath));
        }
    }

    return urls;
}

/** @param {Iterable<string>} artifactNames @param {TReadMetadata} readMetadataText @returns {boolean} */
export function assertPublishUpdaterMetadataReferences(artifactNames, readMetadataText) {
    const files = [...artifactNames];
    const artifactSet = new Set(files);
    const metadataFileNames = getUpdaterMetadataFileNames(files);

    if (metadataFileNames.length === 0) {
        return false;
    }

    for (const metadataFileName of metadataFileNames) {
        const metadataText = readMetadataText(metadataFileName);
        const referencedArtifacts = new Set([
            parseUpdaterMetadataPath(metadataFileName, metadataText),
            ...parseUpdaterMetadataFileUrls(metadataFileName, metadataText),
        ]);

        for (const artifactPath of referencedArtifacts) {
            if (!artifactSet.has(artifactPath)) {
                throw new Error(
                    `Updater metadata mismatch in ${metadataFileName} -> ${artifactPath} not found. ` +
                        `Available artifacts: ${files.sort().join(', ')}`,
                );
            }
        }
    }

    return true;
}

export function createReleaseVerificationEnvs(baseEnv = process.env) {
    const releaseCiEnv = {
        ...baseEnv,
        CI: 'true',
    };

    return {
        releaseAutomationEnv: {
            ...releaseCiEnv,
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        },
        releaseCiEnv,
    };
}

/** @param {NodeJS.ProcessEnv} [baseEnv] @returns {NodeJS.ProcessEnv} */
export function getReleaseCiEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseCiEnv;
}

/** @param {NodeJS.ProcessEnv} [baseEnv] @returns {NodeJS.ProcessEnv} */
export function getReleaseAutomationEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseAutomationEnv;
}
/** @typedef {{arch: string, expectsUpdaterMetadata: boolean, isPrimaryHostTarget: boolean, platform: 'mac' | 'linux' | 'win'}} IReleaseTarget */
/** @typedef {{args: string[], command: string}} IGateCommand */
/** @typedef {(metadataFileName: string) => string} TReadMetadata */
