import { execFile } from 'node:child_process';
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
    afterEach,
    expect,
    it,
    vi,
} from 'vitest';
import { runWindowsTestPrepareCli } from '@scripts/windows-test/cli/runWindowsTestPrepareCli';
import { windowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    loadFixtureManifest,
    verifyFixturePack,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import { prepareWindowsTestHost } from '@scripts/windows-test/host/prepareWindowsTestHost';

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

async function preparation() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-prepare-'));
    roots.push(root);
    const standaloneUtmctlSourcePath = path.join(root, 'installed-utmctl');
    await writeFile(standaloneUtmctlSourcePath, '#!/bin/sh\nprintf utmctl\n', 'utf8');
    await chmod(standaloneUtmctlSourcePath, 0o755);
    return {
        layout: windowsTestHostLayout(root),
        repositoryRoot: process.cwd(),
        standaloneUtmctlSourcePath,
        verifyStandaloneUtmctlSignature: async () => undefined,
        lock: {
            hostId: 'preparation-test',
            pid: process.pid,
            probe: {
                isAlive: () => true,
                startTime: () => Promise.resolve('test-process-start'),
            },
            nowIso: () => new Date().toISOString(),
            sleep: () => Promise.resolve(),
        },
    };
}

it('prepares a standalone guest bundle and verified fixtures without replacing host configuration', async () => {
    const options = await preparation();
    const originalConfig = '{"machine-specific":"preserve"}\n';
    await writeFile(options.layout.configFile, originalConfig);
    const result = await prepareWindowsTestHost(options);
    const manifest = await loadFixtureManifest(result.fixtureManifestFile);
    expect(result.fixtureCount).toBe(14);
    expect(await readFile(options.layout.configFile, 'utf8')).toBe(originalConfig);
    expect(manifest.packs.flatMap(pack => pack.files)).toHaveLength(14);
    const verification = await verifyFixturePack(options.layout.fixturesCacheDir, manifest);
    expect(verification.problems).toEqual([]);
    // Outside the checkout, no host node_modules can mask a missing native
    // dependency or an import-time failure in the Windows bundle.
    const imported = await promisify(execFile)(process.execPath, [
        '-e',
        `require(${JSON.stringify(result.workerFile)}); process.stdout.write("loaded")`,
    ], {
        cwd: options.layout.root,
        timeout: 5_000,
    });
    expect(imported.stdout).toBe('loaded');
}, 30_000);

it('refuses preparation while a run lease exists and preserves its inputs', async () => {
    const options = await preparation();
    await writeFile(options.layout.leaseFile, 'owned-run');
    await expect(prepareWindowsTestHost(options)).rejects.toThrow('lease exists');
    expect(await readFile(options.layout.leaseFile, 'utf8')).toBe('owned-run');
});

it('rejects a declared generated fixture that the generator did not produce', async () => {
    const options = await preparation();
    const manifest = await loadFixtureManifest(path.join(options.repositoryRoot, 'tests/windows/fixtures/manifest.json'));
    const firstPack = manifest.packs[0]!;
    firstPack.files.push({
        ...firstPack.files[0]!,
        id: 'F01-missing',
    });
    const repositoryRoot = path.join(options.layout.root, 'repo');
    const directory = path.join(repositoryRoot, 'tests/windows/fixtures');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(prepareWindowsTestHost({
        ...options,
        repositoryRoot,
    })).rejects.toThrow('F01-missing was not generated');
    await expect(readFile(path.join(options.layout.fixturesCacheDir, 'manifest.json'))).rejects.toThrow();
});

it('preparation CLI writes verified inputs into the requested host root', async () => {
    const { layout } = await preparation();
    const standaloneUtmctlSourcePath = path.join(layout.root, 'installed-utmctl');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runWindowsTestPrepareCli([], { EVB_WINDOWS_TESTS_ROOT: layout.root }, {
        standaloneUtmctlSourcePath,
        verifyStandaloneUtmctlSignature: async () => undefined,
    })).toBe(0);
    const manifest = await loadFixtureManifest(path.join(layout.fixturesCacheDir, 'manifest.json'));
    expect(manifest.packs.flatMap(pack => pack.files)).toHaveLength(14);
    expect((await verifyFixturePack(layout.fixturesCacheDir, manifest)).problems).toEqual([]);
    expect(output.mock.calls.map(call => String(call[0])).join('')).toContain('"fixtureCount": 14');
}, 30_000);

it('preparation CLI reports usage without creating inputs for unknown arguments', async () => {
    const { layout } = await preparation();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const env = { EVB_WINDOWS_TESTS_ROOT: layout.root };
    expect(await runWindowsTestPrepareCli([
        '--',
        '--help',
    ], env)).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(await runWindowsTestPrepareCli(['--unknown'], env)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown preparation argument'));
    await expect(readFile(path.join(layout.fixturesCacheDir, 'manifest.json'))).rejects.toThrow();
});

it('preparation CLI returns infrastructure failure and preserves an active lease', async () => {
    const { layout } = await preparation();
    await writeFile(layout.leaseFile, 'existing-run');
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runWindowsTestPrepareCli([], { EVB_WINDOWS_TESTS_ROOT: layout.root }, {
        standaloneUtmctlSourcePath: path.join(layout.root, 'missing-utmctl'),
        verifyStandaloneUtmctlSignature: async () => undefined,
    })).toBe(3);
    expect(await readFile(layout.leaseFile, 'utf8')).toBe('existing-run');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lease exists'));
});
