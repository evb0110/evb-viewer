import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createGuestPowerShellRunner,
    guestPowerShellArguments,
    guestPowerShellScriptNames,
    GuestPowerShellScriptError,
    POWERSHELL_BASE_ARGUMENTS,
    POWERSHELL_EXECUTABLE,
    type TGuestPowerShellScriptName,
} from '@scripts/windows-test/guest/guestPowerShell';
import type {
    IGuestCommandResult,
    IGuestCommandRunner,
} from '@scripts/windows-test/guest/guestRuntime';

const scriptsDirectory = path.join(process.cwd(), 'scripts', 'windows-test', 'guest', 'powershell');

function fakeExec(result: IGuestCommandResult) {
    const calls: Array<{
        command: string;
        args: readonly string[];
    }> = [];
    const exec: IGuestCommandRunner = { run: (command, args) => {
        calls.push({
            command,
            args,
        });
        return Promise.resolve(result);
    } };
    return {
        calls,
        exec,
    };
}

function runner(result: IGuestCommandResult) {
    const fake = fakeExec(result);
    return {
        calls: fake.calls,
        powerShell: createGuestPowerShellRunner({
            exec: fake.exec,
            scriptsDirectory: 'C:\\evb-test\\worker\\powershell',
            separator: '\\',
        }),
    };
}

describe('guest PowerShell runner', () => {
    it('invokes script files with the hardened argument list', () => {
        expect(POWERSHELL_EXECUTABLE).toBe('powershell.exe');
        expect(guestPowerShellArguments('C:\\scripts\\probe-identity.ps1', ['C:\\App\\EVB Viewer.exe'])).toEqual([
            ...POWERSHELL_BASE_ARGUMENTS,
            'C:\\scripts\\probe-identity.ps1',
            'C:\\App\\EVB Viewer.exe',
        ]);
    });

    it('passes arguments as separate argv entries so nothing is interpolated into PowerShell source', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '{"jobId":1}',
            stderr: '',
        });
        await harness.powerShell.run('hold-file-handle.ps1', [
            '-Path',
            'C:\\evb-test\\work\\run\\inputs\\doc"; Remove-Item C:\\ -Recurse; #.pdf',
        ]);
        const call = harness.calls[0];
        expect(call?.command).toBe('powershell.exe');
        expect(call?.args).toEqual([
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'C:\\evb-test\\worker\\powershell\\hold-file-handle.ps1',
            '-Path',
            'C:\\evb-test\\work\\run\\inputs\\doc"; Remove-Item C:\\ -Recurse; #.pdf',
        ]);
    });

    it('refuses a script name that is not on the allow list', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });
        await expect(harness.powerShell.run('rm-rf.ps1' as TGuestPowerShellScriptName))
            .rejects.toThrow('Unknown guest PowerShell script');
        expect(harness.calls).toHaveLength(0);
    });

    it('turns a failing script into a typed error instead of parsing its output', async () => {
        const harness = runner({
            exitCode: 3,
            stdout: '',
            stderr: 'the input desktop is not available to this session',
        });
        await expect(harness.powerShell.runJson('uia-query.ps1')).rejects.toBeInstanceOf(GuestPowerShellScriptError);
    });

    it('parses JSON from a successful script', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '{"sha256":"abc"}',
            stderr: '',
        });
        expect(await harness.powerShell.runJson('get-file-hash.ps1', [
            '-Path',
            'C:\\file.pdf',
        ])).toEqual({ sha256: 'abc' });
    });
});

describe('guest PowerShell script files', () => {
    let fileNames: string[] = [];
    const sources = new Map<string, string>();

    beforeAll(async () => {
        fileNames = (await readdir(scriptsDirectory)).sort((left, right) => left.localeCompare(right));
        for (const fileName of fileNames) {
            sources.set(fileName, await readFile(path.join(scriptsDirectory, fileName), 'utf8'));
        }
    });

    it('ships exactly the scripts the runner allows', () => {
        expect(fileNames).toEqual([...guestPowerShellScriptNames].sort((left, right) => left.localeCompare(right)));
    });

    it('declares parameters, strict mode and fail-fast error handling in every script', () => {
        for (const [
            fileName,
            source,
        ] of sources) {
            expect(source, fileName).toMatch(/^param\(/mu);
            expect(source, fileName).toContain('Set-StrictMode -Version Latest');
            expect(source, fileName).toContain('$ErrorActionPreference = \'Stop\'');
            expect(source, fileName).toMatch(/^<#/u);
        }
    });

    it('keeps credentials out of the tree', () => {
        for (const [
            fileName,
            source,
        ] of sources) {
            expect(source.toLowerCase(), fileName).not.toContain('convertto-securestring');
            expect(source.toLowerCase(), fileName).not.toMatch(/\$password|-password\b|net user /u);
        }
    });

    it('gives the file-handle helper a bounded lifetime and a readiness handshake', () => {
        const source = sources.get('hold-file-handle.ps1') ?? '';
        expect(source).toContain('[string]$Path');
        expect(source).toContain('[int]$DurationSeconds');
        expect(source).toContain('[string]$ReadyFile');
        expect(source).toContain('ValidateRange(1, 600)');
        expect(source).toContain('[System.IO.FileShare]::None');
    });

    it('documents the logon task as an admin provisioning step with an interactive token', () => {
        const source = sources.get('register-worker-logon-task.ps1') ?? '';
        expect(source).toContain('run once by an administrator');
        expect(source).toContain('-LogonType Interactive');
        expect(source).toContain('-RunLevel Limited');
        expect(source).toContain('New-ScheduledTaskTrigger -AtLogOn');
        expect(source).toContain('no credentials');
    });

    it('keeps standard-account recovery input-only and outside the administrator group', () => {
        const source = sources.get('ensure-standard-test-user.ps1') ?? '';
        expect(source).toContain('[Console]::In.ReadLine()');
        expect(source).toContain('Remove-LocalGroupMember -Group Administrators');
        expect(source).toContain('Add-LocalGroupMember -Group Users');
    });

    it('repairs the guest-agent service without copying event messages', () => {
        const source = sources.get('ensure-guest-agent-service.ps1') ?? '';
        expect(source).toContain('Set-Service -Name qemu-ga -StartupType Automatic');
        expect(source).toContain('sc.exe failure qemu-ga');
        expect(source).toContain('eventIds');
        expect(source).not.toContain('Message');
    });

    it('keeps the no-input startup payload tied to the guest root and marker', async () => {
        const command = await readFile(path.join(scriptsDirectory, '..', 'autostart-worker.cmd'), 'utf8');
        const policy = await readFile(path.join(scriptsDirectory, '..', 'machine-startup-scripts.ini'), 'utf8');
        expect(command).toContain('C:\\EVBViewerTests');
        expect(command).toContain('autostart-marker.json');
        expect(command).toContain('guestWorker.cjs');
        expect(policy).toContain('0CmdLine=evb-worker.cmd');
    });

    it('registers a hidden PowerShell startup action with the worker paths and account', () => {
        const source = sources.get('register-worker-logon-task.ps1') ?? '';
        expect(source).toContain('\'start-worker-logon.ps1\'');
        expect(source).toContain('\'disable-test-audio.ps1\'');
        expect(source).toContain('\'configure-test-printer.ps1\'');
        expect(source).toContain('WindowsPowerShell\\v1.0\\powershell.exe');
        expect(source).toContain('\'-WindowStyle\'');
        expect(source).toContain('\'-ExpectedUserName\'');
        expect(source).toContain('$disableArguments');
        expect(source).toContain('$audioPolicyProcess.ExitCode');
        expect(source).toContain('-Execute $powerShellExecutable');
        expect(source).not.toContain('-Execute $NodeExecutable');
    });

    it('guards startup with the exact lab marker and interactive standard-user checks', () => {
        const source = sources.get('start-worker-logon.ps1') ?? '';
        const helper = sources.get('test-lab-helpers.ps1') ?? '';
        expect(source).toContain('ChildPath \'test-lab-helpers.ps1\'');
        expect(source).toContain('Get-LabMarker -StateDirectory $stateDirectory');
        expect(helper).toContain('ChildPath \'test-marker.json\'');
        expect(helper).toContain('exactly imageId and guestTestMarker');
        expect(source).toContain('$stateDirectory = Join-Path -Path $GuestRoot -ChildPath \'state\'');
        expect(source).toContain('$ExpectedUserName');
        expect(source).toContain('[Environment]::UserInteractive');
        expect(source).toContain('$process.SessionId -eq 0');
        expect(source).toContain('[EvbInputDesktop]::Name()');
        expect(source).toContain('WindowsBuiltInRole]::Administrator');
        expect(source).toContain('audio-mute.json');
        expect(source).toContain('printer-policy.json');
    });

    it('provisions a permanent disabled and stopped Audiosrv policy from an admin context', () => {
        const source = sources.get('disable-test-audio.ps1') ?? '';
        const helper = sources.get('test-lab-helpers.ps1') ?? '';
        expect(source).toContain('$serviceName = \'Audiosrv\'');
        expect(source).toContain('ChildPath \'test-lab-helpers.ps1\'');
        expect(source).toContain('Get-LabMarker -StateDirectory $stateDirectory');
        expect(source).toContain('Set-Service -Name $serviceName -StartupType Disabled');
        expect(source).toContain('Stop-Service -Name $serviceName -Force');
        expect(source).toContain('Get-CimInstance -ClassName Win32_Service');
        expect(source).toContain('serviceStartMode');
        expect(source).toContain('serviceState');
        expect(source).toContain('audio-service-policy.json');
        expect(source).toContain('WindowsBuiltInRole]::Administrator');
        expect(helper).toContain('exactly imageId and guestTestMarker');
        expect(source).not.toContain('SetMute');
        expect(source).not.toContain('IMMDeviceEnumerator');
    });

    it('fails closed unless Audiosrv remains disabled and stopped at logon', () => {
        const source = sources.get('mute-test-audio.ps1') ?? '';
        expect(source).toContain('Get-CimInstance -ClassName Win32_Service -Filter "Name = \'Audiosrv\'"');
        expect(source).toContain('$serviceStartMode -ceq \'Disabled\'');
        expect(source).toContain('$serviceState -ceq \'Stopped\'');
        expect(source).toContain('audio-mute.json');
        expect(source).toContain('standard');
        expect(source).not.toContain('EvbCoreAudio');
        expect(source).not.toContain('IAudioEndpointVolume');
        expect(source).not.toContain('SetMute');
    });

    it('configures and verifies A4 printer output before the worker starts', () => {
        const source = sources.get('configure-test-printer.ps1') ?? '';
        expect(source).toContain('Microsoft Print to PDF');
        expect(source).toContain('Set-PrintConfiguration');
        expect(source).toContain('-PaperSize A4');
        expect(source).toContain('printer-policy.json');
        expect(source).toContain('printer-policy-ok');
        expect(source).toContain('WindowsBuiltInRole]::Administrator');
    });

    it('supervises both helper and worker processes without showing consoles', () => {
        const source = sources.get('start-worker-logon.ps1') ?? '';
        expect(source).toContain('audio-mute.stdout.log');
        expect(source).toContain('audio-mute.stderr.log');
        expect(source).toContain('printer-policy.stdout.log');
        expect(source).toContain('printer-policy.stderr.log');
        expect(source).toContain('worker.stdout.log');
        expect(source).toContain('worker.stderr.log');
        expect(source).toContain('-WindowStyle Hidden');
        expect(source).toContain('-PassThru -Wait');
        expect(source).toContain('exit $workerExitCode');
    });

    it('reports a missing interactive desktop in words the adapters recognize', () => {
        for (const fileName of [
            'uia-query.ps1',
            'uia-action.ps1',
        ]) {
            expect(sources.get(fileName) ?? '', fileName).toContain('input desktop');
        }
    });

    it('emits JSON arrays even when a query matches nothing', () => {
        for (const fileName of [
            'get-print-jobs.ps1',
            'uia-query.ps1',
        ]) {
            expect(sources.get(fileName) ?? '', fileName).toContain('$json = \'[]\'');
        }
    });
});
