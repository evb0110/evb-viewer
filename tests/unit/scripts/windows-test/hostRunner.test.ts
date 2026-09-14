import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import {
    createPreparedGuestWorkerRefresher,
    resolveWindowsTestCandidate,
    requestWindowsTestStopOnHost,
    runWindowsTestDoctorOnHost,
} from '@scripts/windows-test/host/hostRunner';
import { createProcessCommandRunner } from '@scripts/windows-test/host/utmctlClient';
import { createProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import {
    windowsTestHostLayout,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';

const ARTIFACT = 'candidate-installer-bytes';
const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT).digest('hex');

function hostConfig(artifactPath: string, sha256 = ARTIFACT_SHA256): IWindowsTestHostConfig {
    return {
        schemaVersion: 1,
        testImageRoot: '/tmp/windows-test-images',
        allowedTestVmIds: [],
        goldenImageId: 'win11-arm64-2026-09',
        goldenVmId: '11111111-2222-4333-8444-555555555555',
        personalVmIdsDenied: [],
        candidate: {
            artifactPath,
            sha256,
            fileName: path.basename(artifactPath),
            version: '3.4.5',
            sourceSha: 'b'.repeat(40),
            appArch: 'arm64',
        },
        environment: 'utm-win11-arm64-app-arm64',
        qualifiedLaunchers: ['/Applications/EVB Viewer.app'],
        retention: {
            passDays: 3,
            failureDays: 14,
            maxFailedClones: 0,
            minFreeBytes: 1_024,
        },
    };
}

describe('windows test candidate resolution', () => {
    let root = '';

    afterEach(async () => {
        if (root !== '') {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
    });

    it('keeps the registered identity when the configured artifact still hashes as recorded', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const artifactPath = path.join(root, 'candidate.exe');
        await writeFile(artifactPath, ARTIFACT, 'utf8');
        const config = hostConfig(artifactPath);

        await expect(resolveWindowsTestCandidate(config, artifactPath)).resolves.toEqual(config.candidate);
    });

    it('rejects a configured artifact that was replaced under the same path', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const artifactPath = path.join(root, 'candidate.exe');
        await writeFile(artifactPath, 'different-binary', 'utf8');

        await expect(resolveWindowsTestCandidate(hostConfig(artifactPath), artifactPath))
            .rejects.toThrow(/config\.json records/u);
    });

    it('requires sidecar identity for an artifact path that is not configured', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const configuredPath = path.join(root, 'configured.exe');
        const overridePath = path.join(root, 'override.exe');
        await writeFile(configuredPath, ARTIFACT, 'utf8');
        await writeFile(overridePath, ARTIFACT, 'utf8');
        await writeFile(`${overridePath}.meta.json`, JSON.stringify({
            version: '3.4.6',
            sourceSha: 'c'.repeat(40),
            appArch: 'arm64',
        }), 'utf8');

        await expect(resolveWindowsTestCandidate(hostConfig(configuredPath), overridePath))
            .resolves.toMatchObject({
                artifactPath: overridePath,
                sha256: ARTIFACT_SHA256,
                version: '3.4.6',
                sourceSha: 'c'.repeat(40),
            });
    });
});

describe('prepared guest worker refresh', () => {
    let root = '';

    afterEach(async () => {
        if (root !== '') {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
    });

    it('stages and verifies the worker only when its guest hash differs', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-worker-refresh-'));
        const workerFile = path.join(root, 'guestWorker.cjs');
        await writeFile(workerFile, 'prepared-worker', 'utf8');
        const calls: string[] = [];
        const guest = {
            readGuestText: async () => 'golden-worker',
            stageFile: async (_vmId: string, hostPath: string, guestPath: string) => {
                calls.push(`stage ${hostPath} -> ${guestPath}`);
            },
            verifyStagedFileHash: async (_vmId: string, guestPath: string, expectedSha256: string) => {
                calls.push(`verify ${guestPath} ${expectedSha256}`);
                return true;
            },
        };

        const changed = await createPreparedGuestWorkerRefresher({
            workerFile,
            guest,
        })('vm', 200);

        expect(changed).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain('stage ');
        expect(calls[1]).toContain('verify C:\\EVBViewerTests\\worker\\guestWorker.cjs ');
    });

    it('skips staging when the guest worker already matches the prepared hash', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-worker-refresh-'));
        const workerFile = path.join(root, 'guestWorker.cjs');
        await writeFile(workerFile, 'prepared-worker', 'utf8');
        const calls: string[] = [];
        const guest = {
            readGuestText: async () => 'prepared-worker',
            stageFile: async () => {
                calls.push('stage');
            },
            verifyStagedFileHash: async () => {
                calls.push('verify');
                return true;
            },
        };

        const changed = await createPreparedGuestWorkerRefresher({
            workerFile,
            guest,
        })('vm', 200);

        expect(changed).toBe(false);
        expect(calls).toEqual([]);
    });
});

describe('windows test host utmctl selection', () => {
    let root = '';

    afterEach(async () => {
        if (root !== '') {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
    });

    it('reports a missing prepared cache without falling back to the bundled UTM path', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-host-runner-'));

        const report = await runWindowsTestDoctorOnHost({
            dataRoot: root,
            env: {},
            launcherPath: '/Applications/Utilities/Terminal.app',
        });

        expect(report.ok).toBe(false);
        expect(report.checks).toEqual([expect.objectContaining({
            id: 'utmctl-standalone',
            ok: false,
            remedy: expect.stringContaining('windows:test:prepare'),
        })]);
    });
});

describe('windows test host stop', () => {
    let root = '';

    afterEach(async () => {
        if (root !== '') {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
    });

    it('writes a live-owner cancel request without UTM or a prepared standalone cache', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-host-stop-'));
        const layout = windowsTestHostLayout(root);
        const runId = '20260905T120000Z-0123456789ab';
        const runLayout = windowsTestRunLayout(layout.runsDir, runId);
        await mkdir(runLayout.runDir, {recursive: true});
        const probe = createProcessIdentityProbe(createProcessCommandRunner());
        const ownerStartTime = await probe.startTime(process.pid);
        expect(ownerStartTime).not.toBeNull();
        await writeFile(layout.configFile, JSON.stringify({
            schemaVersion: 1,
            testImageRoot: layout.imagesDir,
            allowedTestVmIds: [],
            goldenImageId: 'win11-arm64-2026-09',
            goldenVmId: '11111111-2222-4333-8444-555555555555',
            personalVmIdsDenied: [],
            candidate: null,
            environment: 'utm-win11-arm64-app-arm64',
            qualifiedLaunchers: ['/bin/zsh'],
            retention: {
                passDays: 3,
                failureDays: 14,
                maxFailedClones: 1,
                minFreeBytes: 1_024,
            },
        }), 'utf8');
        await writeFile(layout.leaseFile, JSON.stringify({
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: null,
            runId,
            ownerPid: process.pid,
            ownerStartTime,
            createdAt: '2026-09-05T12:00:00.000Z',
        }), 'utf8');

        const result = await requestWindowsTestStopOnHost({
            runId,
            reason: 'operator asked for a stop',
            dataRoot: root,
            env: {},
        });

        expect(result.exitCode).toBe(0);
        expect(result.recovered).toBe(false);
        expect(JSON.parse(await readFile(runLayout.cancelRequestFile, 'utf8'))).toMatchObject({
            runId,
            reason: 'operator asked for a stop',
        });
    });
});
