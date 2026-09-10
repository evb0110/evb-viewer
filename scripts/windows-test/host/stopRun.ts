import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    mkdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    isWindowsTestRunId,
    windowsTestExitCodes,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestExitCode } from '@scripts/windows-test/contracts/windowsTestContracts';
import { windowsTestRunLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import {
    evaluateHostLease,
    readHostLease,
} from '@scripts/windows-test/host/hostLease';
import { withHostLock } from '@scripts/windows-test/host/hostLock';
import type { IHostLockDependencies } from '@scripts/windows-test/host/hostLock';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { WINDOWS_TEST_CLONE_NAME_PREFIX } from '@scripts/windows-test/host/runCoordinator';
import type { IUtmctlClient } from '@scripts/windows-test/host/utmctlClient';
import type { IUtmInputCaptureGuard } from '@scripts/windows-test/host/utmInputCapture';
import { utmBundlePathForName } from '@scripts/windows-test/images/vmBundleLocator';
import {
    WindowsTestIdentityGuardError,
    assertDestructiveTarget,
    destructivePolicyFromConfig,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestIdentityGuardDependencies } from '@scripts/windows-test/images/vmIdentityGuard';

export interface IWindowsTestStopRequest {
    runId: string;
    reason: string;
}

export interface IWindowsTestStopDependencies {
    layout: IWindowsTestHostLayout;
    config: IWindowsTestHostConfig;
    utmctl: IUtmctlClient;
    probe: IHostProcessIdentityProbe;
    lock: IHostLockDependencies;
    nowIso(): string;
    identityGuard?: IWindowsTestIdentityGuardDependencies;
    inputCapture?: IUtmInputCaptureGuard;
}

export interface IWindowsTestStopResult {
    exitCode: TWindowsTestExitCode;
    messages: string[];
    recovered: boolean;
}

async function stopOwnedClone(
    request: IWindowsTestStopRequest,
    dependencies: IWindowsTestStopDependencies,
    vmId: string,
) {
    const cloneName = `${WINDOWS_TEST_CLONE_NAME_PREFIX}${request.runId}`;
    const policy = withOwnedCloneAllowlisted(
        destructivePolicyFromConfig(dependencies.config),
        vmId,
    );
    const registered = await dependencies.utmctl.list();
    const normalizedVmId = vmId.toLowerCase();
    const registeredWithVmId = registered.filter(entry => entry.uuid.toLowerCase() === normalizedVmId);
    const registeredVm = registeredWithVmId[0];
    const registeredWithExpectedName = registered.filter(entry => entry.name === cloneName);
    if (registeredVm === undefined
        || registeredVm.name !== cloneName
        || registeredWithVmId.length !== 1
        || registeredWithExpectedName.length !== 1
        || registeredWithExpectedName[0] !== registeredVm) {
        const detail = registeredVm === undefined
            ? 'the lease UUID is not registered'
            : registeredVm.name !== cloneName
                ? 'the registered UUID has an unexpected name'
                : registeredWithVmId.length !== 1
                    ? 'the registered UUID is ambiguous'
                    : 'the expected run name is ambiguous';
        throw new WindowsTestIdentityGuardError(
            'registered-vm-mismatch',
            `Refusing stale-owner recovery: ${detail}.`,
        );
    }
    // The guard runs before the stop so a lease that names a personal machine
    // can never be acted upon (invariant I1).
    await assertDestructiveTarget(
        {
            vmId,
            bundlePath: utmBundlePathForName(dependencies.config.testImageRoot, cloneName),
        },
        policy,
        dependencies.identityGuard,
    );
    await dependencies.inputCapture?.ensureReleased(vmId);
    await dependencies.utmctl.stop(vmId, 'request');
    const status = await dependencies.utmctl.status(vmId).catch(() => 'unknown');
    if (status !== 'stopped') {
        await dependencies.utmctl.stop(vmId, 'force');
        const statusAfterForce = await dependencies.utmctl.status(vmId).catch(() => 'unknown');
        if (statusAfterForce !== 'stopped') {
            throw new Error(`Owned clone ${vmId} did not acknowledge stopped status after a forced stop; retaining the host exclusion.`);
        }
    }
}

export async function requestWindowsTestStop(
    request: IWindowsTestStopRequest,
    dependencies: IWindowsTestStopDependencies,
): Promise<IWindowsTestStopResult> {
    if (!isWindowsTestRunId(request.runId)) {
        return {
            exitCode: windowsTestExitCodes.usageOrCrash,
            messages: [`${JSON.stringify(request.runId)} is not a Windows test run ID; expected YYYYMMDDTHHMMSSZ-<12 hex>.`],
            recovered: false,
        };
    }
    const runLayout = windowsTestRunLayout(dependencies.layout.runsDir, request.runId);
    const runDirStat = await stat(runLayout.runDir).catch(() => null);
    if (runDirStat === null) {
        return {
            exitCode: windowsTestExitCodes.usageOrCrash,
            messages: [`Run ${request.runId} has no directory under ${dependencies.layout.runsDir}.`],
            recovered: false,
        };
    }

    const messages: string[] = [];
    await mkdir(runLayout.runDir, {recursive: true});
    await writeFile(
        runLayout.cancelRequestFile,
        `${JSON.stringify({
            runId: request.runId,
            requestedAt: dependencies.nowIso(),
            reason: request.reason,
        }, null, 4)}\n`,
        'utf8',
    );
    messages.push(`Wrote a cancel request for run ${request.runId}.`);

    const lease = await readHostLease(dependencies.layout.leaseFile);
    if (lease === null || lease.runId !== request.runId) {
        messages.push('No live lease holds this run; the cancel request stays on disk for the owner to observe.');
        return {
            exitCode: windowsTestExitCodes.passed,
            messages,
            recovered: false,
        };
    }

    const state = await evaluateHostLease(lease, dependencies.probe);
    if (state === 'held') {
        messages.push(`Run ${request.runId} is still owned by pid ${lease.ownerPid}; it will observe the cancel request and tear down its own clone.`);
        return {
            exitCode: windowsTestExitCodes.passed,
            messages,
            recovered: false,
        };
    }

    let recovered = false;
    try {
        await withHostLock(dependencies.layout.lockFile, dependencies.lock, async () => {
            const current = await readHostLease(dependencies.layout.leaseFile);
            if (current === null || current.runId !== request.runId) {
                messages.push('The stale lease disappeared before recovery started.');
                return;
            }
            if (await evaluateHostLease(current, dependencies.probe) === 'held') {
                messages.push('The lease owner reappeared; leaving recovery to it.');
                return;
            }
            if (current.vmId === null) {
                throw new Error(`Stale run ${current.runId} has no bound clone identity; retaining the host exclusion.`);
            }
            await stopOwnedClone(request, dependencies, current.vmId);
            messages.push(`Stopped the orphaned clone ${current.vmId} and retained it for inspection.`);
            await rm(dependencies.layout.leaseFile, {force: true});
            messages.push('Released the stale lease; the incomplete run directory was preserved.');
            recovered = true;
        });
    } catch (error) {
        messages.push(`Stale-owner recovery failed: ${getErrorMessage(error)}.`);
        return {
            exitCode: windowsTestExitCodes.infrastructureFailed,
            messages,
            recovered: false,
        };
    }

    return {
        exitCode: windowsTestExitCodes.passed,
        messages,
        recovered,
    };
}
