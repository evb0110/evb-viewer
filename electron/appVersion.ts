import packageJson from '@root-package';

const bundledApplicationVersion = packageJson.version.trim();
const embeddedBuildGitSha = normalizeGitSha(process.env.EVB_BUILD_GIT_SHA);

if (!bundledApplicationVersion) {
    throw new Error('The root package.json must define the canonical application version.');
}

/**
 * Packaged builds use Electron's signed bundle metadata. Development runs use
 * the version compiled from the repository manifest because the generic
 * Electron.app bundle otherwise reports the Electron runtime version.
 */
export function resolveApplicationVersion(app: {
    getVersion(): string;
    isPackaged: boolean;
}, buildGitSha = embeddedBuildGitSha) {
    return app.isPackaged
        ? app.getVersion()
        : formatDevelopmentApplicationVersion(buildGitSha);
}

export const canonicalBundledApplicationVersion = bundledApplicationVersion;

function normalizeGitSha(value: string | undefined) {
    const sha = value?.trim().toLowerCase() ?? '';
    // Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in packages/scan-cleanup/core/provenanceStamp.ts.
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha) ? sha : null;
}

function formatDevelopmentApplicationVersion(commitSha: string | null) {
    return commitSha === null
        ? bundledApplicationVersion
        : `${bundledApplicationVersion}+${commitSha}`;
}
