import { assertDestructiveTarget } from '@scripts/windows-test/images/vmIdentityGuard';
import type {
    IWindowsTestDestructivePolicy,
    IWindowsTestDestructiveTarget,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';

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
        return {
            guestAgentAvailable,
            workerReady: heartbeat !== null,
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
