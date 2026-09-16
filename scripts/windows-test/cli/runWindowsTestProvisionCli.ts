import { readFile } from 'node:fs/promises';
import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    resolveWindowsTestDataRoot,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { loadWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import { createNativeInputProvisioner } from '@scripts/windows-test/host/nativeInputProvisioning';
import {
    destructivePolicyFromConfig,
    selectClonedVmId,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import {
    createProcessCommandRunner,
    createUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import { resolvePreparedStandaloneUtmctl } from '@scripts/windows-test/host/standaloneUtmctl';
import { healWindowsTestGoldenOnHost } from '@scripts/windows-test/host/hostRunner';
import type { IWindowsTestGoldenProvisionHostOptions } from '@scripts/windows-test/host/hostRunner';
import {
    WINDOWS_TEST_PROVISION_USAGE,
    parseWindowsTestProvisionArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import {
    createProcessCliIo,
    isDirectCliInvocation,
} from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { isRecord } from '@contracts/runtimeGuards';

interface IWindowsTestProvisionPlan {
    vmId: string;
    bundlePath: string;
    beforeVmIds: string[];
    steps: Array<Record<string, unknown>>;
    waitForWorker?: boolean;
    timeoutMs?: number;
}

export interface IWindowsTestProvisionCliDependencies {healGolden?: (options: IWindowsTestGoldenProvisionHostOptions) => Promise<{
    alreadyProvisioned: boolean;
    evidencePath: string;
}>;}

function isProvisionPlan(value: Record<string, unknown>): value is Record<string, unknown> & IWindowsTestProvisionPlan {
    return typeof value.vmId === 'string'
        && typeof value.bundlePath === 'string'
        && Array.isArray(value.steps)
        && value.steps.every(entry => isRecord(entry))
        && Array.isArray(value.beforeVmIds)
        && value.beforeVmIds.every(entry => typeof entry === 'string');
}

function parsePlan(value: unknown): IWindowsTestProvisionPlan {
    if (!isRecord(value) || !isProvisionPlan(value)) {
        throw new Error('The provisioning plan is malformed.');
    }
    return value;
}

async function runNativeInputPlan(
    planPath: string,
    dataRoot: string | null,
    env: NodeJS.ProcessEnv,
    io: IWindowsTestCliIo,
) {
    const plan = parsePlan(JSON.parse(await readFile(planPath, 'utf8')));
    const layout = windowsTestHostLayout(dataRoot ?? resolveWindowsTestDataRoot(env));
    const config = await loadWindowsTestHostConfig(layout.configFile);
    const runner = createProcessCommandRunner();
    const utmctl = createUtmctlClient({
        runner,
        utmctlPath: await resolvePreparedStandaloneUtmctl({layout}),
        dataRoot: layout.root,
        // A fresh copy of the source image has no EVBViewerTests state
        // directory yet. Keep the completion protocol in an existing
        // Windows directory until the bootstrap creates the lab tree.
        guestExecStateDirectory: 'C:\\Windows\\Temp',
        temporaryFilePath: label => `${layout.root}/.devkit-${label}`,
    });
    const guest = createUtmctlGuestChannel({
        client: utmctl,
        temporaryFilePath: label => `${layout.root}/.devkit-${label}`,
    });
    const observedVmId = selectClonedVmId(
        plan.beforeVmIds.map(uuid => ({
            uuid,
            status: 'unknown',
            name: '',
        })),
        await utmctl.list(),
    );
    if (observedVmId !== plan.vmId.toLowerCase()) {
        throw new Error('The provisioning plan does not identify the single clone observed by UTM.');
    }
    const provisioner = createNativeInputProvisioner({
        runner,
        guest,
        policy: withOwnedCloneAllowlisted(destructivePolicyFromConfig(config), observedVmId),
        target: {
            vmId: plan.vmId,
            bundlePath: plan.bundlePath,
        },
        ...(plan.timeoutMs === undefined ? {} : {timeoutMs: plan.timeoutMs}),
    });
    for (const [
        index,
        step,
    ] of plan.steps.entries()) {
        if (step.kind === 'keystroke' && typeof step.text === 'string') {
            await provisioner.keystroke(step.text, Array.isArray(step.modifiers) ? step.modifiers as never[] : []);
        } else if (step.kind === 'scanCodes' && Array.isArray(step.codes)) {
            await provisioner.scanCodes(step.codes as number[]);
        } else if (step.kind === 'mouseClick' && typeof step.x === 'number' && typeof step.y === 'number') {
            await provisioner.mouseClick(step.x, step.y);
        } else if (step.kind === 'pushFile' && typeof step.hostPath === 'string' && typeof step.guestPath === 'string') {
            await provisioner.pushFile(step.hostPath, step.guestPath);
            io.write(`step ${index + 1}: guest file staged`);
            continue;
        } else if (step.kind === 'pullEvidence' && typeof step.guestPath === 'string' && typeof step.hostPath === 'string') {
            if (!await provisioner.pullEvidence(step.guestPath, step.hostPath)) {
                throw new Error('Guest evidence file was not available.');
            }
            io.write(`step ${index + 1}: guest evidence pulled`);
            continue;
        } else {
            throw new Error('The provisioning plan contains an invalid input step.');
        }
        const readiness = await provisioner.readiness();
        io.write(`step ${index + 1}: native input sent; guestAgentAvailable=${String(readiness.guestAgentAvailable)}; workerReady=${String(readiness.workerReady)}`);
    }
    if (plan.waitForWorker === true) {
        await provisioner.waitForWorker();
        io.write('worker readiness: confirmed by guest heartbeat');
    }
}

export async function runWindowsTestProvisionCli(
    argv: readonly string[],
    io: IWindowsTestCliIo = createProcessCliIo(),
    dependencies: IWindowsTestProvisionCliDependencies = {},
    env: NodeJS.ProcessEnv = process.env,
) {
    const parsed = parseWindowsTestProvisionArgs(argv);
    if (!parsed.ok) {
        io.writeError(parsed.error);
        io.writeError(WINDOWS_TEST_PROVISION_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    if (parsed.args.help) {
        io.write(WINDOWS_TEST_PROVISION_USAGE);
        return windowsTestExitCodes.passed;
    }

    if (parsed.args.healGolden) {
        try {
            const healGolden = dependencies.healGolden ?? healWindowsTestGoldenOnHost;
            const result = await healGolden({
                dataRoot: parsed.args.dataRoot,
                env,
            });
            if (parsed.args.json) {
                io.write(JSON.stringify({
                    alreadyProvisioned: result.alreadyProvisioned,
                    evidencePath: result.evidencePath,
                }));
            } else {
                io.write(result.alreadyProvisioned
                    ? `Golden image was already interactive-ready; it was left stopped. Evidence: ${result.evidencePath}`
                    : `Golden image was headlessly provisioned and qualified; it was left stopped. Evidence: ${result.evidencePath}`);
            }
            return windowsTestExitCodes.passed;
        } catch {
            // The host routine writes redacted evidence and never returns the
            // generated account secret. Keep the CLI failure line equally
            // strict: no transport detail can accidentally echo a password.
            io.writeError('Windows golden-image healing stopped without claiming qualification. Inspect the redacted provisioning evidence and retry from a granted terminal.');
            return windowsTestExitCodes.infrastructureFailed;
        }
    }

    try {
        await runNativeInputPlan(parsed.args.planPath as string, parsed.args.dataRoot, env, io);
        return windowsTestExitCodes.passed;
    } catch {
        io.writeError('Windows native-input provisioning stopped without claiming guest completion.');
        return windowsTestExitCodes.infrastructureFailed;
    }
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestProvisionCli(process.argv.slice(2));
}
