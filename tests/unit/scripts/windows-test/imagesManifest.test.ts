import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    isQualifiedWindowsTestImage,
    isWindowsTestImageManifest,
    loadWindowsTestImageManifest,
    parseWindowsTestImageManifest,
} from '@scripts/windows-test/images/imageManifest';
import {
    UTM_BUNDLE_CONFIG_FILE,
    createPlutilBundleIdentityReader,
    utmBundlePathForName,
} from '@scripts/windows-test/images/vmBundleLocator';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';

const IMAGE_VM_ID = '11111111-2222-4333-8444-555555555555';

function manifest(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        imageId: 'win11-arm64-2026-09',
        vmId: IMAGE_VM_ID,
        bundlePath: '/Volumes/WindowsTests/images/golden.utm',
        createdAt: '2026-09-01T10:00:00.000Z',
        windowsBuild: '10.0.26100.1',
        osArch: 'arm64',
        utmVersion: '4.7.5',
        qemuVersion: '9.1.0',
        driverVersions: {'qemu-guest-agent': '108.0.0.0'},
        disks: [
            {
                diskId: 'system',
                purpose: 'Windows system disk',
                resetPolicy: 'restore-from-baseline',
            },
            {
                diskId: 'evidence',
                purpose: 'Evidence scratch disk',
                resetPolicy: 'recreate-empty',
            },
        ],
        guestTestMarker: 'evb-windows-test-marker-2026-09',
        qualifiedAt: '2026-09-02T09:00:00.000Z',
        qualification: {
            qualifiedBy: 'windows-lane',
            runnerVersion: '2026-09-04.1',
            coldResetCycles: 3,
            notes: 'Three cold resets produced identical baselines.',
        },
        ...overrides,
    };
}

describe('windows test image manifest', () => {
    it('accepts a qualified manifest', () => {
        const parsed = parseWindowsTestImageManifest(manifest(), '/tmp/manifest.json');

        expect(parsed.imageId).toBe('win11-arm64-2026-09');
        expect(isQualifiedWindowsTestImage(parsed)).toBe(true);
    });

    it('treats an unqualified image as usable data but not qualified', () => {
        const parsed = parseWindowsTestImageManifest(manifest({
            qualifiedAt: null,
            qualification: null,
        }), '/tmp/manifest.json');

        expect(isQualifiedWindowsTestImage(parsed)).toBe(false);
    });

    it('rejects a manifest without disks, a marker or a VM UUID', () => {
        expect(isWindowsTestImageManifest(manifest({disks: []}))).toBe(false);
        expect(isWindowsTestImageManifest(manifest({guestTestMarker: ''}))).toBe(false);
        expect(isWindowsTestImageManifest(manifest({vmId: 'Windows 11 Golden'}))).toBe(false);
        expect(isWindowsTestImageManifest(manifest({disks: [{
            diskId: 'system',
            purpose: 'system',
            resetPolicy: 'sometimes',
        }]}))).toBe(false);
    });

    it('loads a manifest from disk and reports malformed JSON', async () => {
        const dataRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-manifest-'));
        try {
            const manifestFile = path.join(dataRoot, 'manifest.json');
            await writeFile(manifestFile, JSON.stringify(manifest()), 'utf8');
            await expect(loadWindowsTestImageManifest(manifestFile)).resolves.toMatchObject({vmId: IMAGE_VM_ID});

            await writeFile(manifestFile, 'not json', 'utf8');
            await expect(loadWindowsTestImageManifest(manifestFile)).rejects.toThrow(/is not valid JSON/u);
        } finally {
            await rm(dataRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});

describe('UTM bundle location', () => {
    let calls: string[][] = [];

    beforeEach(() => {
        calls = [];
    });

    afterEach(() => {
        calls = [];
    });

    it('derives the bundle path from the display name inside the test image root', () => {
        expect(utmBundlePathForName('/Volumes/WindowsTests/images', 'evb-win-test-clone'))
            .toBe(path.join('/Volumes/WindowsTests/images', 'clones', 'evb-win-test-clone.utm'));
    });

    it('reads the bundle UUID out of the UTM configuration plist', async () => {
        const runner: ICommandRunner = {run: (command, args) => {
            calls.push([
                command,
                ...args,
            ]);
            return Promise.resolve({
                exitCode: 0,
                stdout: `${IMAGE_VM_ID.toUpperCase()}\n`,
                stderr: '',
                timedOut: false,
                signal: null,
            });
        }};

        const reader = createPlutilBundleIdentityReader(runner);

        expect(await reader.readVmId('/Volumes/WindowsTests/images/golden.utm')).toBe(IMAGE_VM_ID);
        expect(calls[0]?.at(-1)).toBe(path.join('/Volumes/WindowsTests/images/golden.utm', UTM_BUNDLE_CONFIG_FILE));
    });

    it('reads the bundle display name out of the UTM configuration plist', async () => {
        const runner: ICommandRunner = {run: (command, args) => {
            calls.push([
                command,
                ...args,
            ]);
            return Promise.resolve({
                exitCode: 0,
                stdout: 'Windows test clone\n',
                stderr: '',
                timedOut: false,
                signal: null,
            });
        }};

        const reader = createPlutilBundleIdentityReader(runner);

        expect(await reader.readVmName('/Volumes/WindowsTests/images/clone.utm')).toBe('Windows test clone');
        expect(calls[0]).toContain('Information.Name');
    });

    it('returns null when plutil cannot read the bundle', async () => {
        const runner: ICommandRunner = {run: () => Promise.resolve({
            exitCode: 1,
            stdout: '',
            stderr: 'not a plist',
            timedOut: false,
            signal: null,
        })};

        expect(await createPlutilBundleIdentityReader(runner).readVmId('/tmp/missing.utm')).toBeNull();
    });
});
