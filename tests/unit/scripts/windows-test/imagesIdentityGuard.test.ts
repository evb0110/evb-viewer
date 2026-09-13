import {
    mkdir,
    mkdtemp,
    rm,
    symlink,
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
    assertDestructiveTarget,
    destructivePolicyFromConfig,
    selectClonedVmId,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type {
    IWindowsTestDestructivePolicy,
    WindowsTestIdentityGuardError,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestWorkerHeartbeat } from '@scripts/windows-test/contracts/windowsTestContracts';
import { createNativeInputProvisioner } from '@scripts/windows-test/host/nativeInputProvisioning';

const ALLOWED_VM_ID = '11111111-2222-4333-8444-555555555555';
const GOLDEN_VM_ID = '22222222-3333-4444-8555-666666666666';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';

function listEntry(uuid: string, name: string) {
    return {
        uuid,
        status: 'stopped',
        name,
    };
}

function identityDependencies(
    vmId = ALLOWED_VM_ID,
    vmName = 'evb-win-test-clone',
) {
    return {
        resolvePath: (target: string) => Promise.resolve(target),
        readVmId: () => Promise.resolve(vmId),
        readVmName: () => Promise.resolve(vmName),
    };
}

describe('destructive VM identity guard', () => {
    let baseRoot = '';
    let imageRoot = '';
    let outsideRoot = '';
    let policy: IWindowsTestDestructivePolicy;

    beforeEach(async () => {
        baseRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-images-'));
        imageRoot = path.join(baseRoot, 'images');
        outsideRoot = path.join(baseRoot, 'personal');
        await mkdir(imageRoot, {recursive: true});
        await mkdir(outsideRoot, {recursive: true});
        await mkdir(path.join(imageRoot, 'clone.utm'), {recursive: true});
        await mkdir(path.join(outsideRoot, 'Personal Windows.utm'), {recursive: true});
        policy = {
            allowedTestVmIds: [ALLOWED_VM_ID],
            goldenVmId: GOLDEN_VM_ID,
            personalVmIdsDenied: [PERSONAL_VM_ID],
            testImageRoot: imageRoot,
        };
    });

    afterEach(async () => {
        if (baseRoot === '') {
            return;
        }
        await rm(baseRoot, {
            force: true,
            recursive: true,
        });
        baseRoot = '';
    });

    it('accepts an allowlisted VM whose bundle resolves inside the test image root', async () => {
        await expect(assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID.toUpperCase(),
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
            identityDependencies(ALLOWED_VM_ID),
        )).resolves.toMatchObject({vmId: ALLOWED_VM_ID});
    });

    it('refuses a personal VM by UUID', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: PERSONAL_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-denied');
    });

    it('refuses native input before invoking osascript for a personal VM', async () => {
        const calls: string[] = [];
        const provisioner = createNativeInputProvisioner({
            runner: {run: async command => {
                calls.push(command);
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    signal: null,
                };
            }},
            guest: {
                ping: async () => false,
                readHeartbeat: async () => null,
                ensureDirectory: async () => undefined,
                stageFile: async () => undefined,
                stageAndVerifyFiles: async () => false,
                stageText: async () => undefined,
                verifyStagedFileHash: async () => false,
                writeJob: async () => undefined,
                publishReadyMarker: async () => undefined,
                requestGuestCancel: async () => undefined,
                readGuestText: async () => null,
                pullGuestFile: async () => false,
            },
            policy,
            target: {
                vmId: PERSONAL_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
        });

        await expect(provisioner.scanCodes([28])).rejects.toMatchObject({ refusal: 'vm-id-denied' });
        await expect(provisioner.pushFile('/tmp/command.ps1', 'C:\\EVBViewerTests\\worker\\command.ps1'))
            .rejects.toMatchObject({ refusal: 'vm-id-denied' });
        await expect(provisioner.pullEvidence('C:\\EVBViewerTests\\state\\result.json', '/tmp/result.json'))
            .rejects.toMatchObject({ refusal: 'vm-id-denied' });
        expect(calls).toEqual([]);
    });

    it('keeps agent and worker readiness separate until a heartbeat appears', async () => {
        let heartbeat: IWindowsTestWorkerHeartbeat | null = null;
        const guest = {
            ping: async () => true,
            readHeartbeat: async () => heartbeat,
            ensureDirectory: async () => undefined,
            stageFile: async () => undefined,
            stageAndVerifyFiles: async () => false,
            stageText: async () => undefined,
            verifyStagedFileHash: async () => false,
            writeJob: async () => undefined,
            publishReadyMarker: async () => undefined,
            requestGuestCancel: async () => undefined,
            readGuestText: async () => null,
            pullGuestFile: async () => false,
        };
        const provisioner = createNativeInputProvisioner({
            runner: { run: async () => ({
                exitCode: 0,
                stdout: '',
                stderr: '',
                timedOut: false,
                signal: null,
            }) },
            guest,
            policy,
            target: {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
        });
        await expect(provisioner.readiness()).resolves.toEqual({
            guestAgentAvailable: true,
            workerReady: false,
        });
        heartbeat = {
            schemaVersion: 1,
            bootId: 'boot',
            guestTestMarker: 'marker',
            updatedAt: 'now',
            locked: false,
            worker: {
                userSid: 'sid',
                sessionId: 1,
                integrityLevel: 'medium',
                inputDesktop: 'Default',
                interactive: true,
                workerPid: 1,
                workerStartTime: 'now',
            },
        };
        await expect(provisioner.readiness()).resolves.toEqual({
            guestAgentAvailable: true,
            workerReady: true,
        });
    });

    it('refuses a personal VM by path even when the UUID is allowlisted', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(outsideRoot, 'Personal Windows.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-path-outside-test-image-root');
    });

    it('follows symlinks before deciding that a bundle is inside the root', async () => {
        await symlink(path.join(outsideRoot, 'Personal Windows.utm'), path.join(imageRoot, 'escape.utm'));

        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'escape.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-path-outside-test-image-root');
    });

    it('never accepts a display name in place of a UUID', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: 'Windows 11 Test',
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-not-a-uuid');
    });

    it('refuses the golden image and any UUID outside the allowlist', async () => {
        await expect(assertDestructiveTarget(
            {
                vmId: GOLDEN_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        )).rejects.toThrow(/golden image/u);

        const error = await assertDestructiveTarget(
            {
                vmId: CLONE_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-not-allowlisted');
    });

    it('refuses a bundle whose configuration UUID does not match the requested VM', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
            identityDependencies(CLONE_VM_ID),
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-vm-id-mismatch');
        expect((error as Error).message).toContain('bundle config UUID does not match');
    });

    it('refuses the personal VM display name from bundle configuration', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
            identityDependencies(ALLOWED_VM_ID, 'Windows'),
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-display-name-denied');
        expect((error as Error).message).toContain('personal VM display name');
    });

    it('refuses a bundle whose configuration identity cannot be read', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
            identityDependencies(ALLOWED_VM_ID, ''),
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-identity-unreadable');
    });

    it('refuses a bundle when its display name cannot be read', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
            {
                resolvePath: (target: string) => Promise.resolve(target),
                readVmId: () => Promise.resolve(ALLOWED_VM_ID),
                readVmName: () => Promise.reject(new Error('plutil failed')),
            },
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-identity-unreadable');
    });

    it('widens the allowlist only with the clone it just observed', async () => {
        const widened = withOwnedCloneAllowlisted(policy, CLONE_VM_ID);

        await expect(assertDestructiveTarget(
            {
                vmId: CLONE_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            widened,
            identityDependencies(CLONE_VM_ID),
        )).resolves.toMatchObject({vmId: CLONE_VM_ID});
        expect(() => withOwnedCloneAllowlisted(policy, GOLDEN_VM_ID)).toThrow(/golden/u);
        expect(() => withOwnedCloneAllowlisted(policy, PERSONAL_VM_ID)).toThrow(/denied/u);
    });

    it('derives the policy from the host configuration', () => {
        const config = {
            testImageRoot: '/images',
            allowedTestVmIds: [ALLOWED_VM_ID],
            goldenVmId: GOLDEN_VM_ID,
            personalVmIdsDenied: [PERSONAL_VM_ID],
        } as IWindowsTestHostConfig;

        expect(destructivePolicyFromConfig(config)).toMatchObject({
            goldenVmId: GOLDEN_VM_ID,
            testImageRoot: '/images',
        });
    });
});

describe('clone list difference', () => {
    it('accepts exactly one new registered UUID', () => {
        expect(selectClonedVmId(
            [listEntry(GOLDEN_VM_ID, 'golden')],
            [
                listEntry(GOLDEN_VM_ID, 'golden'),
                listEntry(CLONE_VM_ID, 'evb-win-test-clone'),
            ],
        )).toBe(CLONE_VM_ID);
    });

    it('refuses an ambiguous clone result', () => {
        expect(() => selectClonedVmId([listEntry(GOLDEN_VM_ID, 'golden')], [listEntry(GOLDEN_VM_ID, 'golden')]))
            .toThrow(/exactly one new registered VM UUID/u);
        expect(() => selectClonedVmId(
            [listEntry(GOLDEN_VM_ID, 'golden')],
            [
                listEntry(GOLDEN_VM_ID, 'golden'),
                listEntry(CLONE_VM_ID, 'evb-win-test-clone'),
                listEntry(ALLOWED_VM_ID, 'someone else clone'),
            ],
        )).toThrow(/exactly one new registered VM UUID/u);
    });
});
