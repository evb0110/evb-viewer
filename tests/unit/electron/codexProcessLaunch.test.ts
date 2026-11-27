import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    codexProcessLaunchRuntime,
    resolveCodexProcessLaunch,
    shouldUseCodexCommandShell,
} from '@electron/features/agent/codexProcessLaunch';

describe('Codex process launch', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([['C:\\Users\\viewer\\codex.cmd'], ['C:\\Tools\\codex.bat']])(
        'uses a sibling PowerShell shim without a command shell for %s',
        (codexPath) => {
            vi.spyOn(codexProcessLaunchRuntime, 'existsSync').mockReturnValue(true);
            expect(shouldUseCodexCommandShell(codexPath, 'win32')).toBe(true);
            const launch = resolveCodexProcessLaunch(codexPath, ['--config', 'path=C:\\Users\\A & B\\profile (1)\\data'], 'win32');
            expect(launch.shell).toBe(false);
            expect(launch.command).toMatch(/powershell\.exe$/iu);
            expect(launch.args).toEqual(
                expect.arrayContaining([
                    '-File',
                    codexPath.replace(/\.(?:bat|cmd)$/iu, '.ps1'),
                    '--config',
                    'path=C:\\Users\\A & B\\profile (1)\\data',
                ]),
            );
        },
    );

    it('rejects a batch shim without a safe argv-preserving companion', () => {
        vi.spyOn(codexProcessLaunchRuntime, 'existsSync').mockReturnValue(false);
        expect(() => resolveCodexProcessLaunch('C:\\Tools & Scripts\\codex.cmd', ['--version'], 'win32')).toThrow(
            'requires a sibling PowerShell shim',
        );
    });

    it.each([
        ['C:\\Tools\\codex.exe', 'win32' as const],
        ['/usr/local/bin/codex', 'linux' as const],
        ['/Applications/Codex.app/Contents/Resources/codex', 'darwin' as const],
    ])('launches native executable %s directly', (codexPath, platform) => {
        expect(resolveCodexProcessLaunch(codexPath, ['app-server'], platform).shell).toBe(false);
    });
});
