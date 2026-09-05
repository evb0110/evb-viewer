import { constants } from 'node:fs';
import {
    cp,
    lstat,
    readdir,
    realpath,
    statfs,
} from 'node:fs/promises';
import {
    randomBytes,
    randomUUID,
} from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '@contracts/runtimeGuards';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';

const IMPORT_CLONE_SCRIPT = [
    'on run argv',
    'set bundleFile to POSIX file (item 1 of argv)',
    'tell application id "com.utmapp.UTM"',
    'open bundleFile',
    'end tell',
    'end run',
].join('\n');

async function refuseLinks(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
            throw new Error('The golden bundle contains a symbolic link; qualify a self-contained lab image before cloning.');
        }
        if (entry.isDirectory()) {
            await refuseLinks(path.join(directory, entry.name));
        }
    }
}

// UTM 4.7.5's clone command always writes to UTM's Documents directory.
// Copy the stopped, self-contained lab bundle into the test root instead,
// then open it as a shortcut. The scripting "import new" command also copies
// into Documents, so it must not be used for test-root-owned bundles.
export async function createTestClone(options: {
    config: IWindowsTestHostConfig;
    manifest: IWindowsTestImageManifest;
    cloneName: string;
    runner: ICommandRunner;
    utmctl: IUtmctlClient;
}) {
    const {
        config,
        manifest,
        cloneName,
        runner,
        utmctl,
    } = options;
    if (!/^evb-win-test-\d{8}T\d{6}Z-[a-f0-9]{12}$/u.test(cloneName)) {
        throw new Error('Refusing an invalid Windows test clone name.');
    }
    const root = await realpath(config.testImageRoot);
    const disk = await statfs(root);
    if (disk.bsize * disk.bavail < config.retention.minFreeBytes) {
        throw new Error('The test image root has less free space than the configured reserve.');
    }
    const source = await realpath(manifest.bundlePath);
    const relative = path.relative(root, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !source.endsWith('.utm') || manifest.vmId.toLowerCase() !== config.goldenVmId
        || manifest.imageId !== config.goldenImageId) {
        throw new Error('Golden image identity or bundle location does not match the configured lab image.');
    }
    const registered = await utmctl.list();
    const retained = new Set(registered.filter(entry => entry.name.startsWith('evb-win-test-')).map(entry => entry.name));
    for (const entry of await readdir(root)) {
        if (entry.startsWith('evb-win-test-') && entry.endsWith('.utm')) {
            retained.add(entry.slice(0, -4));
        }
    }
    if (config.retention.maxFailedClones > 0 && retained.size >= config.retention.maxFailedClones) {
        throw new Error('Retained test clones reached the configured limit. Inspect them before starting another run.');
    }
    const golden = registered.find(entry => entry.uuid.toLowerCase() === config.goldenVmId);
    if (!golden || golden.name.trim().toLowerCase() === 'windows'
        || config.personalVmIdsDenied.includes(config.goldenVmId)) {
        throw new Error('Refusing an unregistered or personal golden image.');
    }
    if (await utmctl.status(config.goldenVmId) !== 'stopped') {
        throw new Error('The golden image must be stopped before cloning.');
    }
    const sourceConfig = path.join(source, 'config.plist');
    const runChecked = async (command: string, args: string[]) => {
        const result = await runner.run(command, args, { timeoutMs: 60_000 });
        if (result.exitCode !== 0 || result.timedOut) {
            throw new Error(`Lab clone ${path.basename(command)} failed: ${result.stderr.trim()}`);
        }
        return result.stdout;
    };
    const decoded: unknown = JSON.parse(await runChecked('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        sourceConfig,
    ]));
    if (!isRecord(decoded) || !isRecord(decoded.Information)
        || typeof decoded.Information.UUID !== 'string'
        || decoded.Information.UUID.toLowerCase() !== config.goldenVmId
        || typeof decoded.Information.Name !== 'string'
        || decoded.Information.Name.trim().toLowerCase() === 'windows'
        || decoded.Backend !== 'QEMU'
        || !Array.isArray(decoded.Network) || !Array.isArray(decoded.Drive)) {
        throw new Error('The golden bundle is not the expected QEMU lab image.');
    }
    for (const drive of decoded.Drive) {
        if (!isRecord(drive) || typeof drive.ImageName !== 'string'
            || drive.ImageName.length === 0 || drive.ImageName === '.' || drive.ImageName === '..'
            || /[\\/:]/u.test(drive.ImageName)) {
            throw new Error('The golden image contains external media; remove it before qualifying the complete reset bundle.');
        }
    }
    await refuseLinks(source);
    const destination = path.join(root, `${cloneName}.utm`);
    if (await lstat(destination).catch(() => null)) {
        throw new Error('The clone destination already exists; preserved it without replacement.');
    }
    await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        mode: constants.COPYFILE_FICLONE,
    });
    if (await utmctl.status(config.goldenVmId) !== 'stopped') {
        throw new Error('The golden image started during copying; the incomplete clone was preserved without importing it.');
    }
    const cloneConfig = path.join(destination, 'config.plist');
    const uuid = randomUUID();
    await runChecked('/usr/bin/plutil', [
        '-replace',
        'Information.UUID',
        '-string',
        uuid,
        cloneConfig,
    ]);
    await runChecked('/usr/bin/plutil', [
        '-replace',
        'Information.Name',
        '-string',
        cloneName,
        cloneConfig,
    ]);
    for (let index = 0; index < decoded.Network.length; index += 1) {
        const bytes = randomBytes(6);
        bytes[0] = 2;
        const mac = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(':');
        await runChecked('/usr/bin/plutil', [
            '-replace',
            `Network.${index}.MacAddress`,
            '-string',
            mac,
            cloneConfig,
        ]);
    }
    await runChecked('/usr/bin/osascript', [
        '-e',
        IMPORT_CLONE_SCRIPT,
        destination,
    ]);
    // Opening a bundle schedules an asynchronous import in UTM's UI process.
    // Do not let the coordinator inspect its before/after list too early.
    const registrationDeadline = performance.now() + 30_000;
    do {
        const matches = (await utmctl.list()).filter(entry => entry.uuid.toLowerCase() === uuid);
        if (matches.length === 1 && matches[0]?.name === cloneName) {
            return;
        }
        await delay(200);
    } while (performance.now() < registrationDeadline);
    throw new Error('UTM did not register the copied test bundle with its expected identity; the bundle was preserved.');
}
