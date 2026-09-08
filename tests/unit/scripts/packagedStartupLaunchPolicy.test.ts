import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {runPackagedPolicyScript} from '@tests/unit/scripts/helpers/runPackagedPolicyScript';

describe('packaged startup launch policy', () => {
    it('routes macOS startup through the dockless packaged runner', async () => {
        const script = await readFile('scripts/verify-packaged-startup.sh', 'utf8');

        expect(script).toContain('artifact_root="${EVB_PACKAGED_STARTUP_ARTIFACT_DIR:-.devkit/test/packaged-core-pdf-smoke}"');
        expect(script).toContain('artifact_dir="$(mktemp -d "$artifact_root/packaged-startup-$platform-$arch.XXXXXX")"');
        expect(script).toContain('log_dir="$artifact_dir/electron-logs"');
        expect(script).toContain('task_dir="$(mktemp -d "${TMPDIR:-/tmp}/evb-packaged-startup-$platform-$arch.XXXXXX")"');
        expect(script).toContain('EVB_FILE_LOG_DIR="$log_dir"');
        expect(script).toContain('node --import tsx scripts/release/runPackagedAutomation.ts');
        expect(script).toContain('--executable "$app_exec"');
        expect(script).toContain('--work-directory "$task_dir"');
        expect(script).toContain('EVB_STARTUP_TRACE=1');
        expect(script).toContain('trap \'forward_signal INT; exit 130\' INT');
        expect(script).toContain('trap \'forward_signal TERM; exit 143\' TERM');
        expect(script).toContain('wait "$runner_pid"');
        expect(script).toContain('trap cleanup EXIT');
        expect(script).toContain('rm -rf "$task_dir"');
        expect(script).not.toContain('rm -rf "$log_dir"');
        expect(script).not.toContain('env -u ELECTRON_RUN_AS_NODE "$app_exec" &');
        expect(script).not.toContain('EVB_AUTOMATION_HIDE_WINDOW=1');
        expect(script).not.toContain('EVB_AUTOMATION_NO_FOCUS=1');
    });

    it.skipIf(process.platform === 'win32')('exits before any app launch for a non-mac target', () => {
        const result = runPackagedPolicyScript('scripts/verify-packaged-startup.sh', [
            'linux',
            'x64',
        ]);
        const output = `${result.stdout}${result.stderr}`;
        expect(result.blockedCommands).toBe('');

        if (process.platform === 'linux') {
            expect(result.status).toBe(1);
            expect(output).toContain('currently implemented only for mac targets');
        } else {
            expect(result.status).toBe(0);
            expect(output).toContain('Skipping startup check');
        }
    });
});
