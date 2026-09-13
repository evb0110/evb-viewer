import { assertDestructiveTarget } from '@scripts/windows-test/images/vmIdentityGuard';
import type {
    IWindowsTestDestructivePolicy,
    IWindowsTestDestructiveTarget,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';
import {
    createHash, randomUUID,
} from 'node:crypto';
import {
    readFile, rm,
} from 'node:fs/promises';
import { windowsTestGuestLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import { isFreshInteractiveWorkerHeartbeat } from '@scripts/windows-test/host/isFreshInteractiveWorkerHeartbeat';

export type TNativeInputModifier = 'command' | 'control' | 'option' | 'shift';

export interface INativeInputProvisioningOptions {
    runner: ICommandRunner;
    guest: IWindowsTestGuestChannel;
    policy: IWindowsTestDestructivePolicy;
    target: IWindowsTestDestructiveTarget;
    timeoutMs?: number;
}

export interface INativeProvisioningReadiness {
    guestAgentAvailable: boolean;
    workerReady: boolean;
}

export interface INativeInputProvisioner {
    readiness(): Promise<INativeProvisioningReadiness>;
    keystroke(text: string, modifiers?: readonly TNativeInputModifier[]): Promise<void>;
    scanCodes(codes: readonly number[]): Promise<void>;
    mouseClick(x: number, y: number): Promise<void>;
    pushFile(hostPath: string, guestPath: string): Promise<void>;
    pullEvidence(guestPath: string, hostPath: string): Promise<boolean>;
    waitForWorker(timeoutMs?: number): Promise<void>;
}

function appleScriptString(value: string) {
    return JSON.stringify(value);
}

function requireAscii(text: string) {
    for (const character of text) {
        if ((character.codePointAt(0) ?? 0) > 0x7f) {
            throw new Error('Native UTM keystrokes accept ASCII text only.');
        }
    }
}

function nativeInputScript(operation: string, vmId: string) {
    return [
        'on run argv',
        'tell application "UTM"',
        operation.replaceAll('(targetVm)', `(virtual machine id ${appleScriptString(vmId)})`),
        'end tell',
        'end run',
    ].join('\n');
}

export function createNativeInputProvisioner(options: INativeInputProvisioningOptions): INativeInputProvisioner {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const readinessStartedAtMs = Date.now();
    const assertTarget = () => assertDestructiveTarget(options.target, options.policy);
    const send = async (operation: string) => {
        await assertTarget();
        const result = await options.runner.run('/usr/bin/osascript', [
            '-e',
            nativeInputScript(operation, options.target.vmId),
        ], { timeoutMs });
        if (result.exitCode !== 0 || result.timedOut) {
            throw new Error('UTM native input was not accepted by the owned clone.');
        }
    };
    const probe = async (): Promise<INativeProvisioningReadiness> => {
        const guestAgentAvailable = await options.guest.ping(options.target.vmId, timeoutMs);
        const heartbeat = guestAgentAvailable
            ? await options.guest.readHeartbeat(options.target.vmId, timeoutMs)
            : null;
        const bootIdText = guestAgentAvailable
            ? await options.guest.readGuestText(options.target.vmId, windowsTestGuestLayout.bootIdFile, timeoutMs)
            : null;
        return {
            guestAgentAvailable,
            workerReady: isFreshInteractiveWorkerHeartbeat(bootIdText, heartbeat, readinessStartedAtMs),
        };
    };

    return {
        readiness: probe,
        keystroke: async (text, modifiers = []) => {
            requireAscii(text);
            await send(`input keystroke (targetVm) text ${appleScriptString(text)} with modifiers {${modifiers.join(', ')}}`);
        },
        scanCodes: async codes => {
            if (codes.some(code => !Number.isInteger(code) || code < 0 || code > 255)) {
                throw new Error('Native UTM scan codes must be byte values.');
            }
            await send(`input scan code (targetVm) codes {${codes.join(', ')}}`);
        },
        mouseClick: async (x, y) => {
            if (![
                x,
                y,
            ].every(value => Number.isFinite(value) && value >= 0)) {
                throw new Error('Native UTM mouse coordinates must be non-negative numbers.');
            }
            await send(`input mouse click (targetVm) at {${x}, ${y}} with mouse button left`);
        },
        pushFile: async (hostPath, guestPath) => {
            await assertTarget();
            const expectedSha256 = createHash('sha256').update(await readFile(hostPath)).digest('hex');
            const verified = options.guest.stageAndVerifyFiles === undefined
                ? false
                : await options.guest.stageAndVerifyFiles(options.target.vmId, [{
                    hostPath,
                    guestPath,
                    expectedSha256,
                }], timeoutMs);
            if (verified) {
                return;
            }
            const readbackPath = `${hostPath}.${randomUUID()}.readback`;
            try {
                await options.guest.stageFile(options.target.vmId, hostPath, guestPath, timeoutMs);
                if (!await options.guest.pullGuestFile(options.target.vmId, guestPath, readbackPath, timeoutMs)) {
                    throw new Error(`The staged guest file ${guestPath} could not be read back.`);
                }
                const actualSha256 = createHash('sha256').update(await readFile(readbackPath)).digest('hex');
                if (actualSha256 !== expectedSha256) {
                    throw new Error(`The staged guest file ${guestPath} failed host readback verification.`);
                }
            } finally {
                await rm(readbackPath, {force: true});
            }
        },
        pullEvidence: async (guestPath, hostPath) => {
            await assertTarget();
            return options.guest.pullGuestFile(options.target.vmId, guestPath, hostPath, timeoutMs);
        },
        waitForWorker: async (deadlineMs = 180_000) => {
            const deadline = Date.now() + deadlineMs;
            while (Date.now() < deadline) {
                if ((await probe()).workerReady) {
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1_000));
            }
            throw new Error('The owned clone did not publish a worker heartbeat before the provisioning deadline.');
        },
    };
}
