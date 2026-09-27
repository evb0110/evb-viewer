export const PINNED_CODEX_CLI_VERSION = '0.157.1';
export const PINNED_CODEX_CLI_RELEASE_TAG = `rust-v${PINNED_CODEX_CLI_VERSION}`;

export interface IPinnedCodexCliArtifact {
    platform: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
    archiveKind: 'tar.gz' | 'zip';
    assetName: string;
    executableEntry: string;
    sha256: string;
    url: string;
}

type TArtifactSeed = Omit<IPinnedCodexCliArtifact, 'url'>;

function createArtifact(seed: TArtifactSeed): IPinnedCodexCliArtifact {
    return {
        ...seed,
        url: `https://github.com/openai/codex/releases/download/${PINNED_CODEX_CLI_RELEASE_TAG}/${seed.assetName}`,
    };
}

export const PINNED_CODEX_CLI_ARTIFACTS: readonly IPinnedCodexCliArtifact[] = [
    createArtifact({
        platform: 'darwin',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-apple-darwin.tar.gz',
        executableEntry: 'codex-aarch64-apple-darwin',
        sha256: '3c45b162b7a76f51325015b1d0a8112c73219b7a9b59cd5762c37c9ba55894fa',
    }),
    createArtifact({
        platform: 'darwin',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-apple-darwin.tar.gz',
        executableEntry: 'codex-x86_64-apple-darwin',
        sha256: '281a9b806b5f62b70d1e2b65101bda369095f2f72fa1231b8e0410f7901c9a20',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-aarch64-unknown-linux-musl',
        sha256: '4c6b1c17c1c5fd0d4fb2951b7481867b95ea732b1feab269c98588b15db16253',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-x86_64-unknown-linux-musl',
        sha256: 'e98c1e8e028e8137fa2d2415c82ec58e7b3701a627e3554aace5b3ca31454af2',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'arm64',
        archiveKind: 'zip',
        assetName: 'codex-aarch64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-aarch64-pc-windows-msvc.exe',
        sha256: '823ee9c9cab2d0d157d5c646b4b5e4c12337bcb94cd8b5fcdaf2abe362ecfb17',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'x64',
        archiveKind: 'zip',
        assetName: 'codex-x86_64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-x86_64-pc-windows-msvc.exe',
        sha256: '9b0cbcd72bcbea43433d18b82a50c09a7065f6bd6c503a3d9606a539283b89bf',
    }),
] as const;

export function resolvePinnedCodexCliArtifact(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
) {
    if (
        (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
        || (arch !== 'arm64' && arch !== 'x64')
    ) {
        return null;
    }
    return PINNED_CODEX_CLI_ARTIFACTS.find(artifact => (
        artifact.platform === platform && artifact.arch === arch
    )) ?? null;
}
