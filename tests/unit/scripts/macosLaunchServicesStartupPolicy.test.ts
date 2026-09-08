import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {runPackagedPolicyScript} from '@tests/unit/scripts/helpers/runPackagedPolicyScript';

describe('macOS LaunchServices packaged-startup policy', () => {
    it('installs a quarantined DMG copy and terminates only its tokenized process', async () => {
        const script = await readFile('scripts/verify-macos-launchservices-startup.sh', 'utf8');

        expect(script).toContain('open -n -W -a "$app_path"');
        expect(script).toContain('--user-data-dir="$profile_dir"');
        expect(script).toContain('EVB_LAUNCHSERVICES_DMG_PATH');
        expect(script).toContain('EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST');
        expect(script).toContain('[ "${GITHUB_ACTIONS:-}" = "true" ]');
        expect(script).toContain('[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]');
        expect(script).toContain('if [ "$github_hosted_ci" -ne 1 ]');
        expect(script).toContain('xattr -w com.apple.quarantine');
        expect(script).toContain('hdiutil attach -nobrowse -readonly');
        expect(script).toContain('ditto "$source_app" "$app_path"');
        expect(script).toContain('xattr -p com.apple.quarantine "$app_exec"');
        expect(script).toContain('--env "EVB_AUTOMATION_USER_DATA_DIR=$profile_dir"');
        expect(script).toContain('--env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1"');
        expect(script).toContain('--evb-launchservices-smoke="$token"');
        expect(script).toContain('EVB_LAUNCHSERVICES_ARTIFACT_DIR');
        expect(script).toContain('log_dir="$artifact_dir/electron-logs"');
        expect(script).toContain('--env "EVB_FILE_LOG_DIR=$log_dir"');
        expect(script).toContain('--stdout "$stdout_log"');
        expect(script).toContain('--stderr "$stderr_log"');
        expect(script).not.toContain('rm -rf "$log_dir"');
        expect(script).toContain('index($0, "/Contents/MacOS/EVB Viewer")');
        expect(script).toContain('token_position > executable_position');
        expect(script).toContain('> "$artifact_dir/processes.txt"');
        expect(script).toContain('if [ "$passed" -ne 1 ]');
        expect(script).toContain('grep -F -q "$ready_marker" "$main_log"');
        expect(script).toContain('grep -F -q "$ready_marker" "$stdout_log"');
        expect(script).toContain('grep -F -q "$ready_marker" "$stderr_log"');
        expect(script).toContain('stability_secs=10');
        expect(script).toContain('SECONDS - stable_since');
        expect(script).toContain('kill -0 "$app_pid"');
        expect(script).toContain('LaunchServices kept the tokenized packaged process alive');
        expect(script).toContain('immediately preceding');
        expect(script).not.toMatch(/\bkillall\b|\bpkill\b/u);
        expect(script).not.toContain('/Applications/EVB Viewer.app');
        expect(script).toContain('unregister_bundle "$app_path"');
        expect(script).toContain('unregister_bundle "$source_app"');
        expect(script).toMatch(/unregister_bundle "\$source_app"\s+hdiutil detach "\$mount_point"/u);
    });

    it.skipIf(process.platform !== 'darwin')('denies untrusted CI before any LaunchServices launch', () => {
        const result = runPackagedPolicyScript('scripts/verify-macos-launchservices-startup.sh', [
            'mac',
            'arm64',
        ]);

        expect(result.status).toBe(1);
        expect(result.blockedCommands).toBe('');
        expect(`${result.stdout}${result.stderr}`).toContain('production bundle identity');
    });
});
