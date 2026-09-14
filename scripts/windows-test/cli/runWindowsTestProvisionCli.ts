import { readFile } from 'node:fs/promises';
import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import { windowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { loadWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import { createNativeInputProvisioner } from '@scripts/windows-test/host/nativeInputProvisioning';
import {
    createProcessCommandRunner, createUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import { resolvePreparedStandaloneUtmctl } from '@scripts/windows-test/host/standaloneUtmctl';
import {
    destructivePolicyFromConfig,
    selectClonedVmId,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import { isRecord } from '@contracts/runtimeGuards';
import { isDirectCliInvocation } from '@scripts/windows-test/cli/windowsTestCliIo';

const usage = [
    'Usage: pnpm windows:test:provision --plan <absolute path>',
    '',
    'The plan is local-only. It names one already-owned clone and contains native-input steps.',
    'Output contains only step numbers and guest readiness states. Input text is never printed.',
].join('\n');

function parsePlan(value: unknown) {
    if (!isRecord(value) || typeof value.vmId !== 'string' || typeof value.bundlePath !== 'string' || !Array.isArray(value.steps)
        || !Array.isArray(value.beforeVmIds) || value.beforeVmIds.some(entry => typeof entry !== 'string')) {
        throw new Error('The provisioning plan is malformed.');
    }
    return value as {
        vmId: string;
        bundlePath: string;
        beforeVmIds: string[];
        steps: Array<Record<string, unknown>>;
        waitForWorker?: boolean;
        timeoutMs?: number;
    };
}

export async function runWindowsTestProvisionCli(argv: readonly string[]) {
    if (argv.includes('--help')) {
        process.stdout.write(`${usage}\n`);
        return windowsTestExitCodes.passed;
    }
    const planFlag = argv.indexOf('--plan');
    const candidatePlanPath = planFlag >= 0 ? argv[planFlag + 1] : undefined;
    if (candidatePlanPath === undefined || !candidatePlanPath.startsWith('/')) {
        process.stderr.write(`${usage}\n`);
        return windowsTestExitCodes.usageOrCrash;
    }
    const planPath = candidatePlanPath;
    try {
        const plan = parsePlan(JSON.parse(await readFile(planPath, 'utf8')));
        const layout = windowsTestHostLayout();
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
            ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
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
                process.stdout.write(`step ${index + 1}: guest file staged\n`);
                continue;
            } else if (step.kind === 'pullEvidence' && typeof step.guestPath === 'string' && typeof step.hostPath === 'string') {
                if (!await provisioner.pullEvidence(step.guestPath, step.hostPath)) {
                    throw new Error('Guest evidence file was not available.');
                }
                process.stdout.write(`step ${index + 1}: guest evidence pulled\n`);
                continue;
            } else {
                throw new Error('The provisioning plan contains an invalid input step.');
            }
            const readiness = await provisioner.readiness();
            process.stdout.write(`step ${index + 1}: native input sent; guestAgentAvailable=${String(readiness.guestAgentAvailable)}; workerReady=${String(readiness.workerReady)}\n`);
        }
        if (plan.waitForWorker === true) {
            await provisioner.waitForWorker();
            process.stdout.write('worker readiness: confirmed by guest heartbeat\n');
        }
        return windowsTestExitCodes.passed;
    } catch {
        process.stderr.write('Windows native-input provisioning stopped without claiming guest completion.\n');
        return windowsTestExitCodes.infrastructureFailed;
    }
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestProvisionCli(process.argv.slice(2));
}
