import { hostname } from 'node:os';
import {
    resolveWindowsTestDataRoot,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import { createSystemClock } from '@scripts/windows-test/host/hostClock';
import { defaultRepositoryRoot } from '@scripts/windows-test/host/hostRunner';
import { createProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { prepareWindowsTestHost } from '@scripts/windows-test/host/prepareWindowsTestHost';
import type { TStandaloneUtmctlSignatureVerifier } from '@scripts/windows-test/host/standaloneUtmctl';
import { createProcessCommandRunner } from '@scripts/windows-test/host/utmctlClient';
import { isDirectCliInvocation } from '@scripts/windows-test/cli/windowsTestCliIo';
import { getErrorMessage } from '@contracts/getErrorMessage';

export interface IWindowsTestPrepareCliDependencies {
    standaloneUtmctlSourcePath?: string;
    verifyStandaloneUtmctlSignature?: TStandaloneUtmctlSignatureVerifier;
}

export async function runWindowsTestPrepareCli(
    argv: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    dependencies: IWindowsTestPrepareCliDependencies = {},
) {
    const args = argv.filter(argument => argument !== '--');
    if (args.includes('--help')) {
        process.stdout.write('Usage: pnpm windows:test:prepare\nBuilds the guest worker and fixtures under EVB_WINDOWS_TESTS_ROOT. Does not create or operate VMs.\n');
        return 0;
    }
    if (args.length > 0) {
        process.stderr.write(`Unknown preparation argument: ${args[0] ?? ''}\n`);
        return 1;
    }
    const clock = createSystemClock();
    try {
        const preparationOptions = {
            layout: windowsTestHostLayout(resolveWindowsTestDataRoot(env)),
            repositoryRoot: defaultRepositoryRoot(),
            lock: {
                hostId: hostname(),
                pid: process.pid,
                probe: createProcessIdentityProbe(createProcessCommandRunner()),
                nowIso: () => clock.nowIso(),
                sleep: (milliseconds: number) => clock.sleep(milliseconds),
            },
            ...(dependencies.standaloneUtmctlSourcePath === undefined
                ? {}
                : {standaloneUtmctlSourcePath: dependencies.standaloneUtmctlSourcePath}),
            ...(dependencies.verifyStandaloneUtmctlSignature === undefined
                ? {}
                : {verifyStandaloneUtmctlSignature: dependencies.verifyStandaloneUtmctlSignature}),
        };
        const result = await prepareWindowsTestHost(preparationOptions);
        process.stdout.write(`${JSON.stringify(result, null, 4)}\nPrepared runner files only. Follow docs/contributing/windows-tests/setup-and-repair.md for the lab image, then run windows:test:doctor.\n`);
        return 0;
    } catch (error) {
        process.stderr.write(`${getErrorMessage(error)}\n`);
        return 3;
    }
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestPrepareCli(process.argv.slice(2));
}
