import {afterEach, describe, expect, it, vi} from 'vitest';

async function importAppVersion(buildGitSha: string | undefined) {
    vi.stubEnv('EVB_BUILD_GIT_SHA', buildGitSha);
    vi.resetModules();
    return import('@electron/appVersion');
}

describe('application version truth', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('uses signed bundle metadata in packaged builds', async () => {
        const {resolveApplicationVersion} = await importAppVersion(undefined);

        expect(
            resolveApplicationVersion({
                isPackaged: true,
                getVersion: () => '0.1.999',
            }),
        ).toBe('0.1.999');
    });

    it('uses the bare repository version when the build commit is absent', async () => {
        const {canonicalBundledApplicationVersion, resolveApplicationVersion} = await importAppVersion(undefined);

        expect(canonicalBundledApplicationVersion).toMatch(/^0\.1\.\d+$/u);
        expect(
            resolveApplicationVersion({
                isPackaged: false,
                getVersion: () => '42.3.3',
            }),
        ).toBe(canonicalBundledApplicationVersion);
    });

    it('exposes the build commit in generic Electron development runs', async () => {
        const gitSha = 'a'.repeat(40);
        const {canonicalBundledApplicationVersion, resolveApplicationVersion} = await importAppVersion(gitSha);
        const expectedVersion = `${canonicalBundledApplicationVersion}+${gitSha}`;

        expect(
            resolveApplicationVersion({
                isPackaged: false,
                getVersion: () => '42.3.3',
            }),
        ).toBe(expectedVersion);
    });

    it('accepts a full 64-character build commit', async () => {
        const gitSha = 'b'.repeat(64);
        const {canonicalBundledApplicationVersion, resolveApplicationVersion} = await importAppVersion(gitSha);

        expect(
            resolveApplicationVersion({
                isPackaged: false,
                getVersion: () => '42.3.3',
            }),
        ).toBe(`${canonicalBundledApplicationVersion}+${gitSha}`);
    });

    it.each(['a'.repeat(39), 'g'.repeat(40)])('falls back to the bare version for malformed build commit %s', async (gitSha) => {
        const {canonicalBundledApplicationVersion, resolveApplicationVersion} = await importAppVersion(gitSha);

        expect(
            resolveApplicationVersion({
                isPackaged: false,
                getVersion: () => '42.3.3',
            }),
        ).toBe(canonicalBundledApplicationVersion);
    });

    it('trims and lowercases the build commit suffix', async () => {
        const gitSha = 'AB'.repeat(20);
        const {canonicalBundledApplicationVersion, resolveApplicationVersion} = await importAppVersion(`  ${gitSha}\n`);

        expect(
            resolveApplicationVersion({
                isPackaged: false,
                getVersion: () => '42.3.3',
            }),
        ).toBe(`${canonicalBundledApplicationVersion}+${gitSha.toLowerCase()}`);
    });
});
