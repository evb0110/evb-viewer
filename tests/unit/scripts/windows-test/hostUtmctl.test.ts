import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    DEFAULT_UTMCTL_PATH,
    STANDALONE_UTMCTL_RELATIVE_PATH,
    UtmctlTransportError,
    classifyUtmctlTransportFailure,
    createUtmctlClient,
    detectsAutomationConsentFailure,
    detectsUtmctlEventFailure,
    parseUtmctlListOutput,
    resolveDefaultUtmctlPath,
} from '@scripts/windows-test/host/utmctlClient';
import type {
    ICommandResult,
    ICommandRunOptions,
    ICommandRunner,
} from '@scripts/windows-test/host/utmctlClient';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';

const TEST_VM_ID = '11111111-2222-4333-8444-555555555555';

interface IRecordedCommand {
    command: string;
    args: string[];
    options: ICommandRunOptions;
}

interface IFakeRunnerOptions {
    completion?: {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
    };
    completionPulls?: string[];
}

function fakeRunner(results: ICommandResult[], fakeOptions: IFakeRunnerOptions = {}) {
    const calls: IRecordedCommand[] = [];
    let completionPullIndex = 0;
    const runner: ICommandRunner = {run: (command, args, runOptions) => {
        calls.push({
            command,
            args,
            options: runOptions,
        });
        const guestPath = args.at(-1);
        const completionMatch = guestPath?.match(/utmctl-exec-([0-9a-f-]+)\.completion\.json$/u) ?? null;
        if (args[0] === 'file' && args[1] === 'pull'
            && completionMatch !== null && runOptions.stdoutFilePath !== undefined) {
            const completionText = fakeOptions.completionPulls?.[completionPullIndex]?.replaceAll(
                '__ID__',
                completionMatch[1] ?? '',
            )
                ?? JSON.stringify({
                    protocol: 'evb-utmctl-exec-v1',
                    id: completionMatch[1],
                    state: 'complete',
                    exitCode: fakeOptions.completion?.exitCode ?? 0,
                    stdout: fakeOptions.completion?.stdout ?? 'ok',
                    stderr: fakeOptions.completion?.stderr ?? '',
                });
            completionPullIndex += 1;
            return writeFile(runOptions.stdoutFilePath, completionText).then(() => result());
        }
        const next = results.shift();
        return Promise.resolve(next ?? {
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
        });
    }};
    return {
        calls,
        runner,
    };
}

function result(overrides: Partial<ICommandResult> = {}): ICommandResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        ...overrides,
    };
}

describe('utmctl list parsing', () => {
    it('reads UUID, status and a display name that contains spaces', () => {
        const entries = parseUtmctlListOutput([
            'UUID                                 Status   Name',
            `${TEST_VM_ID} stopped  Windows 11 Golden Image`,
            '22222222-3333-4444-8555-666666666666 started  personal-vm',
            '',
        ].join('\n'));

        expect(entries).toEqual([
            {
                uuid: TEST_VM_ID,
                status: 'stopped',
                name: 'Windows 11 Golden Image',
            },
            {
                uuid: '22222222-3333-4444-8555-666666666666',
                status: 'started',
                name: 'personal-vm',
            },
        ]);
    });

    it('skips the header and any line that does not start with a UUID', () => {
        expect(parseUtmctlListOutput('UUID Status Name\nnot-a-uuid stopped thing\n')).toEqual([]);
    });
});

describe('utmctl transport failure classification', () => {
    it('detects the missing Automation consent OSStatus in either stream', () => {
        expect(detectsAutomationConsentFailure('Error Domain=NSOSStatusErrorDomain Code=-1743')).toBe(true);
        expect(detectsAutomationConsentFailure('Not authorized to send Apple events to UTM.')).toBe(true);
        expect(detectsAutomationConsentFailure('errAEEventNotPermitted')).toBe(true);
        expect(detectsAutomationConsentFailure('command not found')).toBe(false);
    });

    it('classifies consent, timeout and plain transport failures apart', () => {
        expect(classifyUtmctlTransportFailure(result({
            exitCode: 1,
            stderr: 'OSStatus error -1743',
        }))).toBe('automation-consent-missing');
        expect(classifyUtmctlTransportFailure(result({
            exitCode: null,
            timedOut: true,
        }))).toBe('timeout');
        expect(classifyUtmctlTransportFailure(result({
            exitCode: 2,
            stderr: 'no such virtual machine',
        }))).toBe('transport-failed');
        expect(classifyUtmctlTransportFailure(result())).toBeNull();
    });

    it('rejects a zero-exit UTM error event as a transport failure', () => {
        expect(classifyUtmctlTransportFailure(result({stdout: 'Error: guest file was not found'}))).toBe('transport-failed');
    });

    it('does not inspect a streamed file payload as a UTM error event', () => {
        expect(classifyUtmctlTransportFailure(result({stdout: 'Error: this is file content'}), {inspectStdoutEvents: false})).toBeNull();
        expect(classifyUtmctlTransportFailure(result({stderr: 'Error: guest file was not found'}), {inspectStdoutEvents: false})).toBe('transport-failed');
    });

    it('recognizes root error events without matching guest output inside a completion record', () => {
        expect(detectsUtmctlEventFailure('{"event":"Error","message":"guest file was not found"}')).toBe(true);
        expect(detectsUtmctlEventFailure(JSON.stringify({
            protocol: 'evb-utmctl-exec-v1',
            state: 'complete',
            stdout: '{"event":"error"}',
        }))).toBe(false);
    });

    it('explains the consent failure instead of echoing the SSH message', async () => {
        const {runner} = fakeRunner([result({
            exitCode: 1,
            stderr: 'utmctl: Failed to connect. Are you running over SSH? OSStatus -1743',
        })]);
        const client = createUtmctlClient({runner});

        const error = await client.list().catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(UtmctlTransportError);
        expect((error as UtmctlTransportError).kind).toBe('automation-consent-missing');
        expect((error as UtmctlTransportError).message).toContain('Automation');
        expect((error as UtmctlTransportError).message).toContain('System Settings');
    });
});

describe('utmctl client commands', () => {
    it('uses the prepared standalone executable when preparation created it', async () => {
        const dataRoot = '/tmp/evb-windows-tests';
        const preparedPath = path.join(dataRoot, STANDALONE_UTMCTL_RELATIVE_PATH);
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({
            runner,
            dataRoot,
            fileExists: filePath => filePath === preparedPath,
        });

        await client.list();

        expect(calls[0]?.command).toBe(preparedPath);
    });

    it('refuses to resolve before standalone preparation', () => {
        expect(() => resolveDefaultUtmctlPath({
            dataRoot: '/tmp/evb-windows-tests',
            fileExists: () => false,
        })).toThrow('verified standalone utmctl copy is unavailable');
    });

    it('uses the uppercase UUID expected by UTM for every VM operation', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({ runner });
        const vmId = 'abcdef01-abcd-4abc-8abc-abcdef012345';

        await client.status(vmId);
        await client.start(vmId);
        await client.stop(vmId, 'request');
        await client.stop(vmId, 'force');
        await client.clone(vmId, 'evb-win-test-clone');
        await client.deleteVm(vmId);
        await client.ipAddress(vmId);
        await client.exec(vmId, ['whoami.exe']);
        await client.pushFile(vmId, 'C:\\EVBViewerTests\\inbox\\job.json', '{}');
        await client.pullFile(vmId, 'C:\\EVBViewerTests\\outbox\\result.json', '/tmp/result.json');

        expect(calls.length).toBeGreaterThanOrEqual(10);
        for (const call of calls) {
            expect(call.args).toContain(vmId.toUpperCase());
            expect(call.args).not.toContain(vmId);
        }
        expect(calls.find(call => call.args[0] === 'start')?.args).toEqual([
            'start',
            vmId.toUpperCase(),
        ]);
    });

    it('spells stop, clone and delete with the qualified UTM flags', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({
            runner,
            utmctlPath: DEFAULT_UTMCTL_PATH,
        });

        await client.stop(TEST_VM_ID, 'request');
        await client.stop(TEST_VM_ID, 'force');
        await client.clone(TEST_VM_ID, 'evb-win-test-clone');
        await client.deleteVm(TEST_VM_ID);

        expect(calls.map(call => call.args)).toEqual([
            [
                'stop',
                '--request',
                TEST_VM_ID,
            ],
            [
                'stop',
                '--force',
                TEST_VM_ID,
            ],
            [
                'clone',
                TEST_VM_ID,
                '--name',
                'evb-win-test-clone',
            ],
            [
                'delete',
                TEST_VM_ID,
            ],
        ]);
        expect(calls[0]?.command).toBe(DEFAULT_UTMCTL_PATH);
    });

    it('supervises exec with an explicit timeout and never reports success itself', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([], {completion: {
            exitCode: 0,
            stdout: 'ok',
        }});
        const client = createUtmctlClient({runner});

        const outcome = await client.exec(TEST_VM_ID, [
            'powershell.exe',
            '-Command',
            'exit 0',
        ], {timeoutMs: 1_234});

        expect(calls[0]?.options.timeoutMs).toBeLessThanOrEqual(1_234);
        expect(calls[0]?.args).toEqual([
            'file',
            'push',
            TEST_VM_ID,
            expect.stringMatching(/utmctl-exec-[0-9a-f-]+\.request\.json$/u),
        ]);
        expect(calls.some(call => call.args[0] === 'exec')).toBe(true);
        expect(outcome).toMatchObject({
            exitCode: 0,
            stdout: 'ok',
            transportFailure: null,
        });
        expect(outcome).not.toHaveProperty('ok');
        const launchCall = calls.find(call => call.args[0] === 'exec');
        expect(launchCall?.options.timeoutMs).toBeLessThan(1_234);
        const bootstrap = Buffer.from(launchCall?.args.at(-1) ?? '', 'base64').toString('utf16le');
        const guestTimeout = Number.parseInt(/\$timeoutMs = (\d+)/u.exec(bootstrap)?.[1] ?? '', 10);
        expect(guestTimeout).toBeGreaterThan(0);
        expect(guestTimeout).toBeLessThan(1_234);
    });

    it('reports a killed exec as a timeout rather than a guest failure', async () => {
        const {runner} = fakeRunner([result({
            exitCode: null,
            timedOut: true,
            signal: 'SIGKILL',
        })]);
        const client = createUtmctlClient({runner});

        expect(await client.exec(TEST_VM_ID, ['powershell.exe'], {timeoutMs: 10})).toMatchObject({
            timedOut: true,
            transportFailure: 'timeout',
        });
    });

    it('waits for a unique guest completion record and returns the guest result', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([], {completionPulls: [
            '',
            JSON.stringify({
                protocol: 'evb-utmctl-exec-v1',
                id: 'stale-record',
                state: 'complete',
                exitCode: 0,
                stdout: 'stale',
                stderr: '',
            }),
            JSON.stringify({
                protocol: 'evb-utmctl-exec-v1',
                id: '__ID__',
                state: 'complete',
                exitCode: 37,
                stdout: 'EVB-QGA-PROBE\n',
                stderr: 'guest stderr\n',
            }),
        ]});
        const client = createUtmctlClient({
            runner,
            guestExecPollIntervalMs: 0,
            sleep: () => Promise.resolve(),
        });

        const outcome = await client.exec(TEST_VM_ID, [
            'powershell.exe',
            '-Command',
            'Write-Output EVB-QGA-PROBE; exit 37',
        ], {
            input: 'forwarded input\n',
            timeoutMs: 1_234,
        });

        expect(outcome).toEqual({
            exitCode: 37,
            stdout: 'EVB-QGA-PROBE\n',
            stderr: 'guest stderr\n',
            timedOut: false,
            signal: null,
            transportFailure: null,
        });
        const requestCall = calls.find(call => call.args[0] === 'file' && call.args[1] === 'push');
        expect(requestCall?.options.input).toContain('forwarded input\\n');
        const request = JSON.parse(String(requestCall?.options.input)) as {
            protocol: string;
            id: string;
            command: string;
            arguments: string[];
            input: string;
        };
        expect(request).toMatchObject({
            protocol: 'evb-utmctl-exec-v1',
            command: 'powershell.exe',
            arguments: [
                '-Command',
                'Write-Output EVB-QGA-PROBE; exit 37',
            ],
            input: 'forwarded input\n',
        });
        expect(request.id).toMatch(/^[0-9a-f-]+$/u);
        const bootstrapCall = calls.find(call => call.args[0] === 'exec');
        expect(bootstrapCall?.args).toContain('-EncodedCommand');
        const encodedBootstrap = bootstrapCall?.args.at(-1);
        expect(encodedBootstrap).toBeDefined();
        const bootstrap = Buffer.from(encodedBootstrap ?? '', 'base64').toString('utf16le');
        expect(bootstrap).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        expect(bootstrap).toContain('$command = [string]$request.command');
        expect(bootstrap).toContain('Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8');
        expect(bootstrap).toContain('$arguments = @($request.arguments | ForEach-Object');
        expect(bootstrap).toContain('$powerShellPrefix = ([char]36).ToString()');
        expect(bootstrap).toContain('$argument -ieq "-EncodedCommand"');
        expect(bootstrap).toContain('[Convert]::FromBase64String([string]$arguments[$argumentIndex + 1])');
        expect(bootstrap).toContain('$argument -ieq "-Command"');
        expect(bootstrap).toContain('$argument -ieq "-File"');
        expect(bootstrap).toContain('$isPowerShell');
        expect(bootstrap).toContain('$commandParts += [string]$arguments[$commandArgumentIndex]');
        expect(bootstrap).toContain('[Text.Encoding]::Unicode.GetBytes($commandText)');
        expect(bootstrap).toContain('$powerShellPrefix = ([char]36).ToString() + "ProgressPreference = [System.Management.Automation.ActionPreference]::SilentlyContinue');
        expect(bootstrap).toContain('$ErrorActionPreference = [System.Management.Automation.ActionPreference]::Stop');
        expect(bootstrap).toContain('ConvertTo-PowerShellLiteral');
        expect(bootstrap).toContain('$process.StandardInput.BaseStream.Write');
        expect(bootstrap).toContain('$completed = $process.WaitForExit($timeoutMs)');
    });

    it('normalizes an existing encoded PowerShell command before guest launch', async () => {
        const script = '[Console]::Out.Write("Ж"); exit 37';
        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        const {
            calls,
            runner,
        } = fakeRunner([], {completion: {
            exitCode: 37,
            stdout: 'Ж',
        }});
        const client = createUtmctlClient({runner});

        await expect(client.exec(TEST_VM_ID, [
            'powershell.exe',
            '-EncodedCommand',
            encodedScript,
        ], {input: 'Ж\n'})).resolves.toMatchObject({
            exitCode: 37,
            stdout: 'Ж',
            transportFailure: null,
        });

        const requestCall = calls.find(call => call.args[0] === 'file' && call.args[1] === 'push');
        const request = JSON.parse(String(requestCall?.options.input)) as {arguments: string[]};
        expect(request.arguments).toEqual([
            '-EncodedCommand',
            encodedScript,
        ]);

        const bootstrapCall = calls.find(call => call.args[0] === 'exec');
        const bootstrap = Buffer.from(bootstrapCall?.args.at(-1) ?? '', 'base64').toString('utf16le');
        expect(bootstrap).toContain('$argument -ieq "-EncodedCommand"');
        expect(bootstrap).toContain('[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$arguments[$argumentIndex + 1]))');
        expect(bootstrap).toContain('$powerShellPrefix + "[Console]::InputEncoding = [Text.Encoding]::UTF8;');
    });

    it('keeps Unicode -File paths and arguments inside the encoded guest request', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([], {completion: {
            exitCode: 37,
            stdout: 'EVB:Ж\n',
        }});
        const client = createUtmctlClient({runner});

        await expect(client.exec(TEST_VM_ID, [
            'powershell.exe',
            '-File',
            'C:\\EVBViewerTests\\Ж test.ps1',
            '',
            '-WorkerPid',
            '123',
            'quoted "argument" Ж',
        ], {input: 'Ж\n'})).resolves.toMatchObject({
            exitCode: 37,
            stdout: 'EVB:Ж\n',
            transportFailure: null,
        });

        const requestCall = calls.find(call => call.args[0] === 'file' && call.args[1] === 'push');
        const request = JSON.parse(String(requestCall?.options.input)) as {
            arguments: string[];
            input: string;
        };
        expect(request.arguments).toEqual([
            '-File',
            'C:\\EVBViewerTests\\Ж test.ps1',
            '',
            '-WorkerPid',
            '123',
            'quoted "argument" Ж',
        ]);
        expect(request.input).toBe('Ж\n');

        const bootstrapCall = calls.find(call => call.args[0] === 'exec');
        const bootstrap = Buffer.from(bootstrapCall?.args.at(-1) ?? '', 'base64').toString('utf16le');
        expect(bootstrap).toContain('$argument -ieq "-File"');
        expect(bootstrap).toContain('ConvertTo-PowerShellLiteral ([string]$arguments[$argumentIndex + 1])');
        expect(bootstrap).toContain('ConvertTo-PowerShellArgument ([string]$arguments[$scriptArgumentIndex])');
        expect(bootstrap).toContain('$scriptText += "; exit " + ([char]36).ToString()');
        expect(bootstrap).toContain('$value -eq "--"');
        expect(bootstrap).toContain('[Text.Encoding]::UTF8.GetBytes([string]$request.input)');
    });

    it('classifies a guest bootstrap error completion as infrastructure failure', async () => {
        const {runner} = fakeRunner([], {completionPulls: [JSON.stringify({
            protocol: 'evb-utmctl-exec-v1',
            id: '__ID__',
            state: 'error',
            exitCode: null,
            stdout: '',
            stderr: 'The guest process did not start.',
        })]});
        const client = createUtmctlClient({runner});

        await expect(client.exec(TEST_VM_ID, ['missing-command.exe'])).resolves.toMatchObject({
            exitCode: null,
            stderr: 'The guest process did not start.',
            timedOut: false,
            transportFailure: 'transport-failed',
        });
    });

    it('classifies a guest bootstrap timeout as a timeout', async () => {
        const {runner} = fakeRunner([], {completionPulls: [JSON.stringify({
            protocol: 'evb-utmctl-exec-v1',
            id: '__ID__',
            state: 'timeout',
            exitCode: null,
            stdout: '',
            stderr: 'guest command timed out',
        })]});
        const client = createUtmctlClient({runner});

        await expect(client.exec(TEST_VM_ID, ['slow-command.exe'])).resolves.toMatchObject({
            exitCode: null,
            stderr: 'guest command timed out',
            timedOut: true,
            transportFailure: 'timeout',
        });
    });

    it('streams file pull straight to a host file so binary payloads survive', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({runner});

        await client.pushFile(TEST_VM_ID, 'C:\\EVBViewerTests\\inbox\\job.json', '{}');
        await client.pullFile(TEST_VM_ID, 'C:\\EVBViewerTests\\outbox\\result.json', '/tmp/result.json');

        expect(calls[0]?.args).toEqual([
            'file',
            'push',
            TEST_VM_ID,
            'C:\\EVBViewerTests\\inbox\\job.json',
        ]);
        expect(calls[0]?.options.input).toBe('{}');
        expect(calls[1]?.options.stdoutFilePath).toBe('/tmp/result.json');
    });

    it('rejects a zero-exit file pull that carries an Error event on stderr', async () => {
        const {runner} = fakeRunner([result({stderr: 'Error: guest file was not found'})]);
        const client = createUtmctlClient({runner});

        const error = await client.pullFile(
            TEST_VM_ID,
            'C:\\EVBViewerTests\\outbox\\missing.json',
            '/tmp/missing-result.json',
        ).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(UtmctlTransportError);
        expect((error as UtmctlTransportError).kind).toBe('transport-failed');
        expect((error as UtmctlTransportError).message).toContain('guest file was not found');
    });

    it('rejects a zero-exit file pull when UTM reports a guest file lock on stderr', async () => {
        const {runner} = fakeRunner([result({stderr: 'Error from event: failed to open file: process cannot access the file because it is being used by another process.'})]);
        const client = createUtmctlClient({runner});

        await expect(client.pullFile(
            TEST_VM_ID,
            'C:\\EVBViewerTests\\state\\locked.txt',
            '/tmp/locked-result.json',
        )).rejects.toMatchObject({kind: 'transport-failed'});
    });

    it('rejects a zero-exit command when UTM reports that the guest agent is unavailable', () => {
        expect(classifyUtmctlTransportFailure({
            ...result(),
            stderr: 'Error from event: The operation couldn’t be completed. (OSStatus error -2700.)\nThe QEMU guest agent is not running or not installed on the guest.\n',
        })).toBe('transport-failed');
    });

    it('creates run-scoped guest directories with the path supplied as stdin data', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({runner});
        const guest = createUtmctlGuestChannel({
            client,
            temporaryFilePath: () => '/tmp/unused-guest-read',
        });

        await guest.ensureDirectory(
            TEST_VM_ID,
            'C:\\EVBViewerTests\\staging\\run-01\\fixtures',
            1_234,
        );

        expect(calls[0]?.args[0]).toBe('file');
        expect(calls[0]?.options.input).toContain('C:\\\\EVBViewerTests\\\\staging\\\\run-01\\\\fixtures');
        expect(calls[0]?.options.timeoutMs).toBeLessThanOrEqual(1_234);
        const request = JSON.parse(String(calls[0]?.options.input)) as {arguments: string[]};
        expect(request.arguments.at(-1)).toContain('[IO.Directory]::CreateDirectory($path)');
        expect(request.arguments.at(-1)).not.toContain('New-Item -ItemType Directory -LiteralPath');
    });

    it('copies mapped files from the verified EVB_INPUTS media through an encoded guest command', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-guest-media-test-'));
        try {
            const hostPath = path.join(root, 'large-input.bin');
            await writeFile(hostPath, 'host copy must not be pushed', 'utf8');
            const {
                calls,
                runner,
            } = fakeRunner([], {completion: {
                exitCode: 0,
                stdout: 'C:\\EVBViewerTests\\staging\\run-01\\fixtures\\large-input.bin',
            }});
            const client = createUtmctlClient({runner});
            const guest = createUtmctlGuestChannel({
                client,
                temporaryFilePath: () => path.join(root, 'unused-guest-read'),
                inputMedia: {
                    isoPath: path.join(root, 'input.iso'),
                    volumeName: 'EVB_INPUTS',
                    markerFileName: 'EVB_INPUTS.MARKER',
                    markerSha256: 'a'.repeat(64),
                    hostPathToMediaFile: new Map([[
                        path.resolve(hostPath),
                        'b'.repeat(64),
                    ]]),
                },
            });

            await guest.stageFile(
                TEST_VM_ID,
                hostPath,
                'C:\\EVBViewerTests\\staging\\run-01\\fixtures\\large-input.bin',
                180_000,
            );

            const requestCall = calls.find(call => call.args[0] === 'file'
                && call.args[1] === 'push'
                && String(call.options.input).includes('b'.repeat(64)));
            expect(requestCall).toBeDefined();
            const request = JSON.parse(String(requestCall?.options.input)) as {
                arguments: string[];
                input: string;
            };
            expect(request.arguments).toContain('-EncodedCommand');
            const encoded = request.arguments.at(-1) ?? '';
            const script = Buffer.from(encoded, 'base64').toString('utf16le');
            expect(script).toContain('Get-CimInstance Win32_LogicalDisk');
            expect(script).toContain('DriveType = 5');
            expect(script).toContain('$volumes.Count -ne 1');
            expect(script).toContain('[IO.Path]::GetDirectoryName($destinationPath)');
            expect(script).toContain('[IO.Directory]::CreateDirectory($destinationParent)');
            expect(script).not.toContain('New-Item -ItemType Directory -LiteralPath');
            expect(request.input).toContain('"MediaFileName":"' + 'b'.repeat(64));
            expect(request.input).toContain('"MarkerSha256":"' + 'a'.repeat(64) + '"');
            expect(calls.some(call => call.args.at(-1) === 'C:\\EVBViewerTests\\staging\\run-01\\fixtures\\large-input.bin')).toBe(false);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });

    it('copies and verifies a mapped media batch in one supervised guest command', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-guest-media-batch-test-'));
        try {
            const firstHostPath = path.join(root, 'first-input.bin');
            const secondHostPath = path.join(root, 'second-input.bin');
            await writeFile(firstHostPath, 'first source', 'utf8');
            await writeFile(secondHostPath, 'second source', 'utf8');
            const firstSha256 = '1'.repeat(64);
            const secondSha256 = '2'.repeat(64);
            const firstGuestPath = 'C:\\EVBViewerTests\\staging\\run-01\\first-input.bin';
            const secondGuestPath = 'C:\\EVBViewerTests\\staging\\run-01\\second-input.bin';
            const {
                calls,
                runner,
            } = fakeRunner([], {completion: {
                exitCode: 0,
                stdout: JSON.stringify([
                    {
                        DestinationPath: firstGuestPath,
                        ExpectedSha256: firstSha256,
                        ActualSha256: firstSha256,
                    },
                    {
                        DestinationPath: secondGuestPath,
                        ExpectedSha256: secondSha256,
                        ActualSha256: secondSha256,
                    },
                ]),
            }});
            const guest = createUtmctlGuestChannel({
                client: createUtmctlClient({runner}),
                temporaryFilePath: () => path.join(root, 'unused-guest-read'),
                inputMedia: {
                    isoPath: path.join(root, 'input.iso'),
                    volumeName: 'EVB_INPUTS',
                    markerFileName: 'EVB_INPUTS.MARKER',
                    markerSha256: 'a'.repeat(64),
                    hostPathToMediaFile: new Map([
                        [
                            path.resolve(firstHostPath),
                            firstSha256,
                        ],
                        [
                            path.resolve(secondHostPath),
                            secondSha256,
                        ],
                    ]),
                },
            });

            await expect(guest.stageAndVerifyFiles?.(TEST_VM_ID, [
                {
                    hostPath: firstHostPath,
                    guestPath: firstGuestPath,
                    expectedSha256: firstSha256,
                },
                {
                    hostPath: secondHostPath,
                    guestPath: secondGuestPath,
                    expectedSha256: secondSha256,
                },
            ], 120_000)).resolves.toBe(true);

            const requestCalls = calls.filter(call => call.args[0] === 'file'
                && call.args[1] === 'push'
                && String(call.options.input).includes('Files'));
            expect(requestCalls).toHaveLength(1);
            const request = JSON.parse(String(requestCalls[0]?.options.input)) as {
                arguments: string[];
                input: string;
            };
            expect(request.arguments).toContain('-EncodedCommand');
            const encoded = request.arguments.at(-1) ?? '';
            const script = Buffer.from(encoded, 'base64').toString('utf16le');
            expect(script).toContain('foreach ($file in $files)');
            expect(script).toContain('Get-FileHash -LiteralPath $destinationPath');
            const batch = JSON.parse(request.input) as {Files: Array<{
                MediaFileName: string;
                DestinationPath: string;
                ExpectedSha256: string;
            }>;};
            expect(batch.Files).toEqual([
                {
                    MediaFileName: firstSha256,
                    DestinationPath: firstGuestPath,
                    ExpectedSha256: firstSha256,
                },
                {
                    MediaFileName: secondSha256,
                    DestinationPath: secondGuestPath,
                    ExpectedSha256: secondSha256,
                },
            ]);
            expect(calls.filter(call => call.args[0] === 'file' && call.args[1] === 'push'
                && [
                    firstGuestPath,
                    secondGuestPath,
                ].includes(String(call.args.at(-1))))).toHaveLength(0);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });

    it('fails a mapped media batch without falling back to QGA', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-guest-media-batch-failure-test-'));
        try {
            const hostPath = path.join(root, 'input.bin');
            await writeFile(hostPath, 'batch source', 'utf8');
            const {
                calls,
                runner,
            } = fakeRunner([], {completion: {
                exitCode: 1,
                stderr: 'Input media marker hash does not match expected value.',
            }});
            const guest = createUtmctlGuestChannel({
                client: createUtmctlClient({runner}),
                temporaryFilePath: () => path.join(root, 'unused-guest-read'),
                inputMedia: {
                    isoPath: path.join(root, 'input.iso'),
                    volumeName: 'EVB_INPUTS',
                    markerFileName: 'EVB_INPUTS.MARKER',
                    markerSha256: 'a'.repeat(64),
                    hostPathToMediaFile: new Map([[
                        path.resolve(hostPath),
                        '3'.repeat(64),
                    ]]),
                },
            });

            await expect(guest.stageAndVerifyFiles?.(TEST_VM_ID, [{
                hostPath,
                guestPath: 'C:\\EVBViewerTests\\staging\\run-01\\input.bin',
                expectedSha256: '3'.repeat(64),
            }], 120_000)).rejects.toThrow('EVB_INPUTS batch');
            expect(calls.some(call => call.args[0] === 'file'
                && call.args[1] === 'push'
                && call.args.at(-1) === 'C:\\EVBViewerTests\\staging\\run-01\\input.bin')).toBe(false);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        0,
        2,
    ])('does not fall back to QGA when the mapped EVB_INPUTS media has %s matching volume(s)', async foundVolumes => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-guest-media-failure-test-'));
        try {
            const hostPath = path.join(root, 'input.bin');
            await writeFile(hostPath, 'small source', 'utf8');
            const {
                calls,
                runner,
            } = fakeRunner([], {completion: {
                exitCode: 1,
                stderr: `Expected exactly one CDRom volume named EVB_INPUTS, found ${foundVolumes}.`,
            }});
            const client = createUtmctlClient({runner});
            const guest = createUtmctlGuestChannel({
                client,
                temporaryFilePath: () => path.join(root, 'unused-guest-read'),
                inputMedia: {
                    isoPath: path.join(root, 'input.iso'),
                    volumeName: 'EVB_INPUTS',
                    markerFileName: 'EVB_INPUTS.MARKER',
                    markerSha256: 'a'.repeat(64),
                    hostPathToMediaFile: new Map([[
                        path.resolve(hostPath),
                        'b'.repeat(64),
                    ]]),
                },
            });

            await expect(guest.stageFile(TEST_VM_ID, hostPath, 'C:\\EVBViewerTests\\staging\\run-01\\input.bin', 1_000))
                .rejects.toThrow('EVB_INPUTS media');
            expect(calls.some(call => call.args.at(-1) === 'C:\\EVBViewerTests\\staging\\run-01\\input.bin')).toBe(false);
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
