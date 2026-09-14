import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    expect,
    it,
} from 'vitest';
import { createTestClone } from '@scripts/windows-test/images/createTestClone';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';

const goldenId = '11111111-2222-4333-8444-555555555555';
const cloneName = 'evb-win-test-20260905T000000Z-0123456789ab';
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

async function fixture() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'evb-clone-test-')));
    roots.push(root);
    const source = path.join(root, 'golden.utm');
    await mkdir(path.join(source, 'Data'), { recursive: true });
    await writeFile(path.join(source, 'Data', 'disk.qcow2'), 'complete-disk');
    await writeFile(path.join(source, 'Data', 'efi_vars.fd'), 'efi-state');
    await writeFile(path.join(source, 'Data', 'tpm.dat'), 'tpm-state');
    await writeFile(path.join(source, 'config.plist'), 'original-config');
    const config: IWindowsTestHostConfig = {
        schemaVersion: 1,
        testImageRoot: root,
        allowedTestVmIds: [],
        goldenImageId: 'lab-image',
        goldenVmId: goldenId,
        personalVmIdsDenied: [],
        candidate: null,
        environment: 'utm-win11-arm64-app-arm64',
        qualifiedLaunchers: ['/Applications/Test.app'],
        retention: {
            passDays: 7,
            failureDays: 30,
            maxFailedClones: 1,
            minFreeBytes: 0,
        },
    };
    const manifest: IWindowsTestImageManifest = {
        schemaVersion: 1,
        imageId: config.goldenImageId,
        vmId: goldenId,
        bundlePath: source,
        createdAt: '2026-09-05T00:00:00Z',
        windowsBuild: 'test',
        osArch: 'arm64',
        utmVersion: '4.7.5',
        qemuVersion: '10.0.2',
        driverVersions: {},
        disks: [{
            diskId: 'system',
            purpose: 'system',
            resetPolicy: 'restore-from-baseline',
        }],
        guestTestMarker: 'lab-marker',
        qualifiedAt: null,
        qualification: null,
    };
    const commands: Array<{
        command: string;
        args: string[]
    }> = [];
    const decoded = {
        Backend: 'QEMU',
        Information: {
            UUID: goldenId,
            Name: 'EVB Lab Golden',
        },
        Network: [{ MacAddress: '02:00:00:00:00:01' }],
        Drive: [{ ImageName: 'disk.qcow2' }],
    };
    const runner: ICommandRunner = { run: async (command, args) => {
        commands.push({
            command,
            args,
        });
        return {
            exitCode: 0,
            stdout: JSON.stringify(decoded),
            stderr: '',
            timedOut: false,
            signal: null,
        };
    } };
    const registration = {
        uuid: goldenId,
        name: 'EVB Lab Golden',
        status: 'stopped',
    };
    const utmctl: IUtmctlClient = {
        list: async () => {
            const cloneId = commands.find(entry => entry.args[1] === 'Information.UUID')?.args[3];
            return cloneId && commands.some(entry => entry.command === '/usr/bin/open')
                ? [
                    registration,
                    {
                        uuid: cloneId,
                        name: cloneName,
                        status: 'stopped',
                    },
                ]
                : [registration];
        },
        status: async () => registration.status,
        version: async () => '4.7.5',
        start: async () => { throw new Error('must not start'); },
        stop: async () => { throw new Error('must not stop'); },
        clone: async () => { throw new Error('must not use UTM default clone directory'); },
        deleteVm: async () => { throw new Error('must not delete'); },
        ipAddress: async () => [],
        exec: async () => { throw new Error('must not execute guest commands'); },
        pushFile: async () => { throw new Error('must not stage files'); },
        pullFile: async () => { throw new Error('must not read guest files'); },
    };
    return {
        root,
        source,
        decoded,
        commands,
        registration,
        options: {
            config,
            manifest,
            runner,
            utmctl,
            cloneName,
        },
    };
}

it('copies disk, EFI and TPM into the test root and changes only the copied identities before import', async () => {
    const harness = await fixture();
    await createTestClone(harness.options);
    const destination = path.join(harness.root, `${cloneName}.utm`);
    for (const file of [
        'disk.qcow2',
        'efi_vars.fd',
        'tpm.dat',
    ]) {
        expect(await readFile(path.join(destination, 'Data', file))).toEqual(await readFile(path.join(harness.source, 'Data', file)));
    }
    expect(await readFile(path.join(harness.source, 'config.plist'), 'utf8')).toBe('original-config');
    const replacements = harness.commands.filter(entry => entry.args[0] === '-replace');
    expect(replacements.map(entry => entry.args[1])).toEqual([
        'Information.UUID',
        'Information.Name',
        'Network.0.MacAddress',
    ]);
    expect(replacements.every(entry => entry.args.at(-1) === path.join(destination, 'config.plist'))).toBe(true);
    expect(replacements[0]?.args[3]).not.toBe(goldenId);
    expect(harness.commands.at(-1)?.command).toBe('/usr/bin/open');
    expect(harness.commands.at(-1)?.args[0]).toBe('-g');
    expect(harness.commands.at(-1)?.args[1]).toBe('-a');
    expect(harness.commands.at(-1)?.args[2]).toBe('/Applications/UTM.app');
    expect(harness.commands.at(-1)?.args.at(-1)).toBe(destination);
});

it('refuses the personal display name before copying or importing', async () => {
    const harness = await fixture();
    harness.registration.name = 'Windows';
    await expect(createTestClone(harness.options)).rejects.toThrow('personal golden');
    expect(harness.commands).toEqual([]);
});

it('refuses external media, symlinks and an existing destination', async () => {
    const external = await fixture();
    external.decoded.Drive[0]!.ImageName = '../external.qcow2';
    await expect(createTestClone(external.options)).rejects.toThrow('external media');
    const linked = await fixture();
    await symlink('/tmp', path.join(linked.source, 'outside'));
    await expect(createTestClone(linked.options)).rejects.toThrow('symbolic link');
    const existing = await fixture();
    existing.options.config.retention.maxFailedClones = 2;
    await mkdir(path.join(existing.root, `${cloneName}.utm`));
    await expect(createTestClone(existing.options)).rejects.toThrow('already exists');
    expect(existing.commands.some(entry => entry.command.endsWith('open'))).toBe(false);
});

it('counts a preserved unregistered clone against the retention limit', async () => {
    const harness = await fixture();
    await mkdir(path.join(harness.root, 'evb-win-test-20260904T000000Z-0123456789ab.utm'));
    await expect(createTestClone(harness.options)).rejects.toThrow('Retained test clones');
    expect(harness.commands).toEqual([]);
});

it('does not count the promoted golden bundle as a retained clone', async () => {
    const harness = await fixture();
    const promoted = path.join(harness.root, 'evb-win-test-promoted.utm');
    await rename(harness.source, promoted);
    harness.options.manifest.bundlePath = promoted;
    await createTestClone(harness.options);
    expect(harness.commands.some(entry => entry.args.includes(cloneName))).toBe(true);
});

it('copies input media into the clone and inserts only a read-only USB CD drive in the clone config', async () => {
    const harness = await fixture();
    const inputMediaPath = path.join(harness.root, 'input-media.iso');
    await writeFile(inputMediaPath, 'input media bytes', 'utf8');
    await createTestClone({
        ...harness.options,
        inputMediaPath,
    });

    const destination = path.join(harness.root, `${cloneName}.utm`);
    expect(await readFile(path.join(destination, 'Data', 'evb-test-inputs.iso'), 'utf8')).toBe('input media bytes');
    expect(await readFile(inputMediaPath, 'utf8')).toBe('input media bytes');
    const driveInsert = harness.commands.find(entry => entry.args[0] === '-insert' && entry.args[1] === 'Drive.1');
    expect(harness.commands.filter(entry => entry.args[0] === '-insert' && entry.args[1] === 'Drive.1')).toHaveLength(1);
    expect(driveInsert?.args.slice(0, 4)).toEqual([
        '-insert',
        'Drive.1',
        '-json',
        expect.any(String),
    ]);
    expect(JSON.parse(driveInsert?.args[3] ?? '{}')).toMatchObject({
        ImageName: 'evb-test-inputs.iso',
        ImageType: 'CD',
        Interface: 'USB',
        InterfaceVersion: 1,
        ReadOnly: true,
    });
    expect(harness.commands.some(entry => entry.command.endsWith('open'))).toBe(true);
});

it('rejects symbolic-link and non-regular input media before touching UTM', async () => {
    const linked = await fixture();
    const linkedTarget = path.join(linked.root, 'media-source.iso');
    await writeFile(linkedTarget, 'media', 'utf8');
    const linkedPath = path.join(linked.root, 'linked-input.iso');
    await symlink(linkedTarget, linkedPath);
    await expect(createTestClone({
        ...linked.options,
        inputMediaPath: linkedPath,
    })).rejects.toThrow('symbolic link');
    expect(linked.commands).toEqual([]);

    const directory = await fixture();
    const directoryPath = path.join(directory.root, 'input-directory');
    await mkdir(directoryPath);
    await expect(createTestClone({
        ...directory.options,
        inputMediaPath: directoryPath,
    })).rejects.toThrow('not a regular file');
    expect(directory.commands).toEqual([]);
});

it('refuses an input-media destination already present in the golden bundle', async () => {
    const harness = await fixture();
    await writeFile(path.join(harness.source, 'Data', 'evb-test-inputs.iso'), 'existing media', 'utf8');
    const inputMediaPath = path.join(harness.root, 'input-media.iso');
    await writeFile(inputMediaPath, 'new media', 'utf8');

    await expect(createTestClone({
        ...harness.options,
        inputMediaPath,
    })).rejects.toThrow('input media destination already exists');
    expect(harness.commands.some(entry => entry.command.endsWith('open'))).toBe(false);
});
