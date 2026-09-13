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
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsTestGuestLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import { windowsTestDefaultDeadlines } from '@scripts/windows-test/contracts/windowsTestContracts';
import { isFreshInteractiveWorkerHeartbeat } from '@scripts/windows-test/host/isFreshInteractiveWorkerHeartbeat';
import { GUEST_POWERSHELL_COMMAND } from '@scripts/windows-test/host/guestChannel';

const GUEST_FILE_CHUNK_BYTES = 1024 * 1024;
const GUEST_TRANSPORT_TIMEOUT_MS = windowsTestDefaultDeadlines.guestTransportSeconds * 1_000;
const GUEST_REASSEMBLE_COMMAND = [
    '$ErrorActionPreference = \'Stop\'',
    '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$parent = [IO.Path]::GetDirectoryName([string]$request.Destination)',
    'if (-not [string]::IsNullOrWhiteSpace($parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }',
    '$output = [IO.File]::Open([string]$request.Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)',
    'try { foreach ($part in $request.Parts) { $input = [IO.File]::OpenRead([string]$part); try { $input.CopyTo($output) } finally { $input.Dispose() } } } finally { $output.Dispose() }',
    'foreach ($part in $request.Parts) { Remove-Item -LiteralPath ([string]$part) -Force }',
    '$hash = (Get-FileHash -LiteralPath ([string]$request.Destination) -Algorithm SHA256).Hash.ToLowerInvariant()',
    'Write-Output (\'evb-chunk-sha256=\' + $hash)',
].join('; ');

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
    const pushChunked = async (hostPath: string, guestPath: string, contents: Buffer, expectedSha256: string) => {
        if (options.guest.execute === undefined) {
            throw new Error('The guest channel cannot reassemble chunked staging data.');
        }
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'evb-windows-chunks-'));
        const chunkPaths: string[] = [];
        const guestChunkPaths: string[] = [];
        try {
            for (let offset = 0, index = 0; offset < contents.byteLength; offset += GUEST_FILE_CHUNK_BYTES, index++) {
                const chunk = contents.subarray(offset, Math.min(offset + GUEST_FILE_CHUNK_BYTES, contents.byteLength));
                const chunkHostPath = path.join(temporaryDirectory, `chunk-${index}.bin`);
                const chunkGuestPath = `${guestPath}.chunk-${randomUUID()}`;
                await writeFile(chunkHostPath, chunk);
                const chunkHash = createHash('sha256').update(chunk).digest('hex');
                await options.guest.stageFile(options.target.vmId, chunkHostPath, chunkGuestPath, timeoutMs);
                const readbackPath = path.join(temporaryDirectory, `readback-${index}.bin`);
                if (!await options.guest.pullGuestFile(options.target.vmId, chunkGuestPath, readbackPath, timeoutMs)
                    || createHash('sha256').update(await readFile(readbackPath)).digest('hex') !== chunkHash) {
                    throw new Error(`Chunk ${index} of ${hostPath} failed readback verification.`);
                }
                chunkPaths.push(readbackPath);
                guestChunkPaths.push(chunkGuestPath);
            }
            const outcome = await options.guest.execute(options.target.vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-Command',
                GUEST_REASSEMBLE_COMMAND,
            ], GUEST_TRANSPORT_TIMEOUT_MS, JSON.stringify({
                Destination: guestPath,
                Parts: guestChunkPaths,
            }));
            const hashMatch = /(?:^|\r?\n)evb-chunk-sha256=([0-9a-f]{64})(?:\r?\n|$)/iu.exec(outcome.stdout);
            if (outcome.transportFailure !== null || outcome.exitCode !== 0 || hashMatch?.[1]?.toLowerCase() !== expectedSha256.toLowerCase()) {
                throw new Error(`Chunk reassembly failed for ${hostPath}.`);
            }
        } finally {
            await Promise.all(chunkPaths.map(chunkPath => rm(chunkPath, {force: true})));
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
        }
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
            const contents = await readFile(hostPath);
            if (contents.byteLength > GUEST_FILE_CHUNK_BYTES) {
                await pushChunked(hostPath, guestPath, contents, expectedSha256);
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
