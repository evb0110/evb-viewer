import {
    readFile,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';
import {
    isSha256Hex,
    isWindowsTestWorkerHeartbeat,
    windowsTestDefaultDeadlines,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestJob,
    IWindowsTestWorkerHeartbeat,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    windowsTestGuestLayout,
    windowsTestGuestRunPaths,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type {
    IUtmctlClient,
    IUtmctlExecOutcome,
} from '@scripts/windows-test/host/utmctlClient';
import { WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME } from '@scripts/windows-test/host/inputMedia';
import type { IWindowsTestInputMedia } from '@scripts/windows-test/host/inputMedia';

// PowerShell is invoked through a staged script file with separate argv
// entries. Interpolating a guest path or a document name into a command string
// would let file content act as code.
export const GUEST_FILE_HASH_SCRIPT_PATH = `${windowsTestGuestLayout.stateDir}\\verify-file-hash.ps1`;

export const GUEST_FILE_HASH_SCRIPT = [
    'param(',
    '    [Parameter(Mandatory = $true)][string]$TargetPath,',
    '    [Parameter(Mandatory = $true)][string]$ExpectedSha256',
    ')',
    '$ErrorActionPreference = \'Stop\'',
    'if (-not (Test-Path -LiteralPath $TargetPath)) {',
    '    Write-Output \'missing\'',
    '    exit 2',
    '}',
    '$actual = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {',
    '    Write-Output "mismatch $actual"',
    '    exit 3',
    '}',
    'Write-Output "match $actual"',
    'exit 0',
    '',
].join('\n');

export const GUEST_POWERSHELL_COMMAND = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
] as const;

// The path is supplied over stdin, never interpolated into the command. This
// keeps directory creation safe for every guest path the host derives from a
// run id or a prepared fixture name.
const GUEST_MAKE_DIRECTORY_COMMAND = [
    '$ErrorActionPreference = \'Stop\'',
    '$path = [Console]::In.ReadToEnd().Trim()',
    'if ([string]::IsNullOrWhiteSpace($path)) { exit 2 }',
    '[IO.Directory]::CreateDirectory($path) | Out-Null',
].join('; ');

const GUEST_COPY_INPUT_MEDIA_COMMAND = [
    '$ErrorActionPreference = \'Stop\'',
    '$requestText = [Console]::In.ReadToEnd()',
    'if ([string]::IsNullOrWhiteSpace($requestText)) { throw \'Input media request is empty.\' }',
    '$request = $requestText | ConvertFrom-Json',
    'if ([string]::IsNullOrWhiteSpace([string]$request.VolumeName) -or [string]$request.VolumeName -cne \'EVB_INPUTS\') { throw \'Input media volume name is invalid.\' }',
    'if ([string]::IsNullOrWhiteSpace([string]$request.MarkerFileName) -or [IO.Path]::GetFileName([string]$request.MarkerFileName) -cne [string]$request.MarkerFileName) { throw \'Input media marker name is invalid.\' }',
    'if ([string]::IsNullOrWhiteSpace([string]$request.MediaFileName) -or [IO.Path]::GetFileName([string]$request.MediaFileName) -cne [string]$request.MediaFileName) { throw \'Input media file name is invalid.\' }',
    '$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter \'DriveType = 5\' | Where-Object { [string]$_.VolumeName -ceq [string]$request.VolumeName })',
    'if ($volumes.Count -ne 1) { throw (\'Expected exactly one CDRom volume named {0}, found {1}.\' -f $request.VolumeName, $volumes.Count) }',
    '$root = [string]$volumes[0].DeviceID + \'\\\'',
    '$markerPath = Join-Path -Path $root -ChildPath ([string]$request.MarkerFileName)',
    'if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw (\'Input media marker {0} is missing.\' -f $markerPath) }',
    'if ([string]::IsNullOrWhiteSpace([string]$request.MarkerSha256)) { throw \'Input media marker hash is missing.\' }',
    '$markerSha256 = (Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($markerSha256 -cne ([string]$request.MarkerSha256).ToLowerInvariant()) { throw (\'Input media marker hash {0} does not match expected {1}.\' -f $markerSha256, $request.MarkerSha256) }',
    '$sourcePath = Join-Path -Path $root -ChildPath ([string]$request.MediaFileName)',
    'if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw (\'Input media file {0} is missing.\' -f $sourcePath) }',
    '$destinationPath = [string]$request.DestinationPath',
    'if ([string]::IsNullOrWhiteSpace($destinationPath)) { throw \'Input media destination is empty.\' }',
    '$destinationParent = [IO.Path]::GetDirectoryName($destinationPath)',
    'if (-not [string]::IsNullOrWhiteSpace($destinationParent)) { [IO.Directory]::CreateDirectory($destinationParent) | Out-Null }',
    'Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force',
    'Write-Output $destinationPath',
].join('; ');

const GUEST_COPY_VERIFY_INPUT_MEDIA_BATCH_COMMAND = [
    '$ErrorActionPreference = \'Stop\'',
    '$requestText = [Console]::In.ReadToEnd()',
    'if ([string]::IsNullOrWhiteSpace($requestText)) { throw \'Input media batch request is empty.\' }',
    '$request = $requestText | ConvertFrom-Json',
    'if ([string]$request.VolumeName -cne \'EVB_INPUTS\') { throw \'Input media volume name is invalid.\' }',
    'if ([string]$request.MarkerFileName -cne \'EVB_INPUTS.MARKER\') { throw \'Input media marker name is invalid.\' }',
    '$files = @($request.Files | Where-Object { $null -ne $_ })',
    'if ($files.Count -eq 0) { throw \'Input media batch is empty.\' }',
    '$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter \'DriveType = 5\' | Where-Object { [string]$_.VolumeName -ceq [string]$request.VolumeName })',
    'if ($volumes.Count -ne 1) { throw (\'Expected exactly one CDRom volume named {0}, found {1}.\' -f $request.VolumeName, $volumes.Count) }',
    '$root = [string]$volumes[0].DeviceID + \'\\\'',
    '$markerPath = Join-Path -Path $root -ChildPath ([string]$request.MarkerFileName)',
    'if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw (\'Input media marker {0} is missing.\' -f $markerPath) }',
    'if ([string]::IsNullOrWhiteSpace([string]$request.MarkerSha256)) { throw \'Input media marker hash is missing.\' }',
    '$markerSha256 = (Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($markerSha256 -cne ([string]$request.MarkerSha256).ToLowerInvariant()) { throw (\'Input media marker hash {0} does not match expected {1}.\' -f $markerSha256, $request.MarkerSha256) }',
    '$results = @()',
    'foreach ($file in $files) {',
    '    $mediaFileName = [string]$file.MediaFileName',
    '    if ($mediaFileName -notmatch \'^[a-zA-Z0-9._-]+$\' -or $mediaFileName -eq \'.\' -or $mediaFileName -eq \'..\') { throw (\'Input media file name {0} is unsafe.\' -f $mediaFileName) }',
    '    $expectedSha256 = ([string]$file.ExpectedSha256).ToLowerInvariant()',
    '    if ($expectedSha256 -notmatch \'^[0-9a-f]{64}$\') { throw (\'Expected SHA-256 for {0} is invalid.\' -f $mediaFileName) }',
    '    $destinationPath = [string]$file.DestinationPath',
    '    if ([string]::IsNullOrWhiteSpace($destinationPath)) { throw \'Input media destination is empty.\' }',
    '    $sourcePath = Join-Path -Path $root -ChildPath $mediaFileName',
    '    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw (\'Input media file {0} is missing.\' -f $sourcePath) }',
    '    $destinationParent = [IO.Path]::GetDirectoryName($destinationPath)',
    '    if (-not [string]::IsNullOrWhiteSpace($destinationParent)) { [IO.Directory]::CreateDirectory($destinationParent) | Out-Null }',
    '    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force',
    '    $actualSha256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    '    if ($actualSha256 -cne $expectedSha256) { throw (\'Staged input {0} hashes to {1}, expected {2}.\' -f $destinationPath, $actualSha256, $expectedSha256) }',
    '    $results += [ordered]@{ DestinationPath = $destinationPath; ExpectedSha256 = $expectedSha256; ActualSha256 = $actualSha256 }',
    '}',
    'Write-Output (ConvertTo-Json -InputObject ([array]$results) -Compress -Depth 4)',
].join('\n');

function encodePowerShellCommand(command: string) {
    return Buffer.from(command, 'utf16le').toString('base64');
}

function commandFailureDetail(outcome: IUtmctlExecOutcome) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    const status = outcome.transportFailure === null
        ? `guest exit ${String(outcome.exitCode)}`
        : `transport ${outcome.transportFailure}`;
    return detail.length > 0 ? `${status}: ${detail}` : status;
}

function mediaFileNameIsSafe(fileName: string) {
    return /^[a-zA-Z0-9._-]+$/u.test(fileName)
        && fileName !== '.'
        && fileName !== '..';
}

export interface IWindowsTestGuestStageFile {
    hostPath: string;
    guestPath: string;
    expectedSha256: string;
}

interface IWindowsTestGuestStageResult {
    DestinationPath: string;
    ExpectedSha256: string;
    ActualSha256: string;
}

function mediaFileForHostPath(inputMedia: IWindowsTestInputMedia, hostPath: string) {
    const key = path.resolve(hostPath);
    return inputMedia.hostPathToMediaFile.get(key);
}

async function copyFromInputMedia(
    client: IUtmctlClient,
    inputMedia: IWindowsTestInputMedia,
    vmId: string,
    hostPath: string,
    guestPath: string,
    timeoutMs: number,
) {
    const mediaFileName = mediaFileForHostPath(inputMedia, hostPath);
    if (mediaFileName === undefined) {
        return false;
    }
    if (!mediaFileNameIsSafe(mediaFileName)) {
        throw new Error(`The input media file name ${mediaFileName} is unsafe.`);
    }
    const outcome = await client.exec(vmId, [
        ...GUEST_POWERSHELL_COMMAND,
        '-EncodedCommand',
        encodePowerShellCommand(GUEST_COPY_INPUT_MEDIA_COMMAND),
    ], {
        timeoutMs,
        input: `${JSON.stringify({
            VolumeName: WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME,
            MarkerFileName: inputMedia.markerFileName,
            MarkerSha256: inputMedia.markerSha256,
            MediaFileName: mediaFileName,
            DestinationPath: guestPath,
        })}\n`,
    });
    if (outcome.transportFailure !== null || outcome.exitCode !== 0) {
        const detail = commandFailureDetail(outcome);
        throw new Error(`Could not stage ${hostPath} from the EVB_INPUTS media: ${detail}`);
    }
    return true;
}

function parseInputMediaBatchResult(stdout: string): IWindowsTestGuestStageResult[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.trim());
    } catch (error) {
        throw new Error(`The EVB_INPUTS batch returned invalid JSON: ${String(error)}.`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('The EVB_INPUTS batch returned a non-array result.');
    }
    return parsed.map((entry, index) => {
        if (!isRecord(entry)
            || typeof entry.DestinationPath !== 'string'
            || typeof entry.ExpectedSha256 !== 'string'
            || typeof entry.ActualSha256 !== 'string') {
            throw new Error(`The EVB_INPUTS batch result ${index} is malformed.`);
        }
        return {
            DestinationPath: entry.DestinationPath,
            ExpectedSha256: entry.ExpectedSha256,
            ActualSha256: entry.ActualSha256,
        };
    });
}

async function verifyGuestFileHash(
    client: IUtmctlClient,
    vmId: string,
    guestPath: string,
    expectedSha256: string,
    timeoutMs: number,
    scriptAlreadyStaged = false,
) {
    const expected = expectedSha256.toLowerCase();
    if (!scriptAlreadyStaged) {
        await client.pushFile(
            vmId,
            GUEST_FILE_HASH_SCRIPT_PATH,
            GUEST_FILE_HASH_SCRIPT,
            {timeoutMs: HEARTBEAT_READ_TIMEOUT_MS},
        );
    }
    const outcome = await client.exec(vmId, [
        ...GUEST_POWERSHELL_COMMAND,
        '-File',
        GUEST_FILE_HASH_SCRIPT_PATH,
        guestPath,
        expected,
    ], {timeoutMs});
    if (outcome.transportFailure !== null) {
        throw new Error(`Could not verify guest file hash ${guestPath}: ${commandFailureDetail(outcome)}`);
    }
    return outcome.exitCode === 0
        && outcome.stdout.toLowerCase().includes(`match ${expected}`);
}

export interface IWindowsTestGuestChannel {
    ping(vmId: string, timeoutMs: number): Promise<boolean>;
    ensureDirectory(vmId: string, guestPath: string, timeoutMs: number): Promise<void>;
    readHeartbeat(vmId: string, timeoutMs: number): Promise<IWindowsTestWorkerHeartbeat | null>;
    stageFile(vmId: string, hostPath: string, guestPath: string, timeoutMs: number): Promise<void>;
    stageAndVerifyFiles?(
        vmId: string,
        files: readonly IWindowsTestGuestStageFile[],
        timeoutMs: number,
    ): Promise<boolean>;
    stageText(vmId: string, contents: string, guestPath: string, timeoutMs: number): Promise<void>;
    verifyStagedFileHash(
        vmId: string,
        guestPath: string,
        expectedSha256: string,
        timeoutMs: number,
    ): Promise<boolean>;
    writeJob(vmId: string, job: IWindowsTestJob, timeoutMs: number): Promise<void>;
    publishReadyMarker(vmId: string, runId: string, timeoutMs: number): Promise<void>;
    requestGuestCancel(vmId: string, runId: string, timeoutMs: number): Promise<void>;
    readGuestText(vmId: string, guestPath: string, timeoutMs: number): Promise<string | null>;
    pullGuestFile(vmId: string, guestPath: string, hostPath: string, timeoutMs: number): Promise<boolean>;
    execute?(vmId: string, command: readonly string[], timeoutMs: number, input?: string): Promise<IUtmctlExecOutcome>;
}

const HEARTBEAT_READ_TIMEOUT_MS = windowsTestDefaultDeadlines.uiStepSeconds * 1_000;

export function createUtmctlGuestChannel(options: {
    client: IUtmctlClient;
    temporaryFilePath(label: string): string;
    inputMedia?: IWindowsTestInputMedia | undefined;
}): IWindowsTestGuestChannel {
    const readGuestText = async (vmId: string, guestPath: string, timeoutMs: number) => {
        const hostPath = options.temporaryFilePath('guest-read');
        try {
            await options.client.pullFile(vmId, guestPath, hostPath, {timeoutMs});
            return await readFile(hostPath, 'utf8');
        } catch {
            return null;
        } finally {
            await rm(hostPath, {force: true});
        }
    };

    return {
        ping: async (vmId, timeoutMs) => {
            // A file transfer proves QGA readiness without starting two
            // PowerShell processes. Desktop readiness separately requires a
            // fresh heartbeat with this run's boot token and lab marker.
            return await readGuestText(vmId, windowsTestGuestLayout.markerFile, timeoutMs) !== null;
        },
        ensureDirectory: async (vmId, guestPath, timeoutMs) => {
            const outcome = await options.client.exec(vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-Command',
                GUEST_MAKE_DIRECTORY_COMMAND,
            ], {
                timeoutMs,
                input: `${guestPath}\n`,
            });
            if (outcome.transportFailure !== null || outcome.exitCode !== 0) {
                throw new Error(`Could not create guest directory ${guestPath}: ${commandFailureDetail(outcome)}`);
            }
        },
        readHeartbeat: async (vmId, timeoutMs) => {
            const text = await readGuestText(vmId, windowsTestGuestLayout.heartbeatFile, timeoutMs);
            if (text === null) {
                return null;
            }
            try {
                const parsed: unknown = JSON.parse(text);
                return isWindowsTestWorkerHeartbeat(parsed) ? parsed : null;
            } catch {
                return null;
            }
        },
        stageFile: async (vmId, hostPath, guestPath, timeoutMs) => {
            if (options.inputMedia !== undefined
                && await copyFromInputMedia(options.client, options.inputMedia, vmId, hostPath, guestPath, timeoutMs)) {
                return;
            }
            await options.client.pushFile(vmId, guestPath, await readFile(hostPath), {timeoutMs});
        },
        stageAndVerifyFiles: async (vmId, files, timeoutMs) => {
            const inputMedia = options.inputMedia;
            if (inputMedia === undefined) {
                return false;
            }
            const mapped: Array<IWindowsTestGuestStageFile & {mediaFileName: string}> = [];
            const unmapped: IWindowsTestGuestStageFile[] = [];
            for (const file of files) {
                if (!isSha256Hex(file.expectedSha256)) {
                    throw new Error(`The expected SHA-256 for ${file.guestPath} is invalid.`);
                }
                const mediaFileName = mediaFileForHostPath(inputMedia, file.hostPath);
                if (mediaFileName === undefined) {
                    unmapped.push(file);
                    continue;
                }
                if (!mediaFileNameIsSafe(mediaFileName)) {
                    throw new Error(`The input media file name ${mediaFileName} is unsafe.`);
                }
                mapped.push({
                    ...file,
                    mediaFileName,
                });
            }
            if (unmapped.length > 0) {
                await options.client.pushFile(
                    vmId,
                    GUEST_FILE_HASH_SCRIPT_PATH,
                    GUEST_FILE_HASH_SCRIPT,
                    {timeoutMs: HEARTBEAT_READ_TIMEOUT_MS},
                );
            }
            for (const file of unmapped) {
                await options.client.pushFile(vmId, file.guestPath, await readFile(file.hostPath), {timeoutMs});
                const verified = await verifyGuestFileHash(
                    options.client,
                    vmId,
                    file.guestPath,
                    file.expectedSha256,
                    timeoutMs,
                    true,
                );
                if (!verified) {
                    throw new Error(`The staged input ${file.guestPath} did not hash to ${file.expectedSha256}.`);
                }
            }
            if (mapped.length === 0) {
                return files.length > 0;
            }
            const outcome = await options.client.exec(vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-EncodedCommand',
                encodePowerShellCommand(GUEST_COPY_VERIFY_INPUT_MEDIA_BATCH_COMMAND),
            ], {
                timeoutMs,
                input: `${JSON.stringify({
                    VolumeName: WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME,
                    MarkerFileName: inputMedia.markerFileName,
                    MarkerSha256: inputMedia.markerSha256,
                    Files: mapped.map(file => ({
                        MediaFileName: file.mediaFileName,
                        DestinationPath: file.guestPath,
                        ExpectedSha256: file.expectedSha256.toLowerCase(),
                    })),
                })}\n`,
            });
            if (outcome.transportFailure !== null || outcome.exitCode !== 0) {
                throw new Error(`Could not stage the EVB_INPUTS batch: ${commandFailureDetail(outcome)}`);
            }
            const results = parseInputMediaBatchResult(outcome.stdout);
            if (results.length !== mapped.length) {
                throw new Error(`The EVB_INPUTS batch returned ${results.length} results for ${mapped.length} files.`);
            }
            const expectedByDestination = new Map(
                mapped.map(file => [
                    file.guestPath,
                    file.expectedSha256.toLowerCase(),
                ]),
            );
            const seen = new Set<string>();
            for (const result of results) {
                const expected = expectedByDestination.get(result.DestinationPath);
                if (expected === undefined || seen.has(result.DestinationPath)) {
                    throw new Error(`The EVB_INPUTS batch returned an unexpected destination ${result.DestinationPath}.`);
                }
                if (result.ExpectedSha256.toLowerCase() !== expected
                    || result.ActualSha256.toLowerCase() !== expected) {
                    throw new Error(`The EVB_INPUTS batch hash for ${result.DestinationPath} did not match ${expected}.`);
                }
                seen.add(result.DestinationPath);
            }
            if (seen.size !== expectedByDestination.size) {
                throw new Error('The EVB_INPUTS batch omitted one or more expected destinations.');
            }
            return true;
        },
        stageText: async (vmId, contents, guestPath, timeoutMs) => {
            await options.client.pushFile(vmId, guestPath, contents, {timeoutMs});
        },
        verifyStagedFileHash: async (vmId, guestPath, expectedSha256, timeoutMs) => {
            return verifyGuestFileHash(options.client, vmId, guestPath, expectedSha256, timeoutMs);
        },
        writeJob: async (vmId, job, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(job.runId).jobFile,
                `${JSON.stringify(job, null, 4)}\n`,
                {timeoutMs},
            );
        },
        publishReadyMarker: async (vmId, runId, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(runId).readyMarkerFile,
                `${runId}\n`,
                {timeoutMs},
            );
        },
        requestGuestCancel: async (vmId, runId, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(runId).cancelFile,
                `${runId}\n`,
                {timeoutMs},
            );
        },
        readGuestText,
        pullGuestFile: async (vmId, guestPath, hostPath, timeoutMs) => {
            try {
                await options.client.pullFile(vmId, guestPath, hostPath, {timeoutMs});
                return true;
            } catch {
                return false;
            }
        },
        execute: async (vmId, command, timeoutMs, input) => options.client.exec(vmId, command, {
            timeoutMs,
            ...(input === undefined ? {} : {input}),
        }),
    };
}
