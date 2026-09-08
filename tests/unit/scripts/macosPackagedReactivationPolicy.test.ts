import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {runPackagedPolicyScript} from '@tests/unit/scripts/helpers/runPackagedPolicyScript';

describe('macOS packaged-reactivation diagnostic policy', () => {
    it('isolates and identifies the exact packaged canary before terminating it', async () => {
        const script = await readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8');

        expect(script).toContain('app_path="${EVB_REACTIVATION_APP_PATH:-release/mac-$arch/EVB Viewer.app}"');
        expect(script).toContain('open -n -a "$app_path"');
        expect(script).toContain('--user-data-dir="$user_data_dir"');
        expect(script).toContain('EVB_REACTIVATION_APP_PATH:-release/mac-$arch/EVB Viewer.app');
        expect(script).toContain('EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST');
        expect(script).toContain('[ "${GITHUB_ACTIONS:-}" = "true" ]');
        expect(script).toContain('[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]');
        expect(script).toContain('if [ "$github_hosted_ci" -ne 1 ]');
        expect(script).toContain('defaults export com.apple.dock "$dock_snapshot"');
        expect(script).toContain('dock_item_preexisted');
        expect(script).toContain('Delete :persistent-apps:$dock_index');
        expect(script).toContain('xcrun swiftc scripts/macos-app-lifecycle-probe.swift');
        expect(script).toContain('--env "EVB_AUTOMATION_USER_DATA_DIR=$user_data_dir"');
        expect(script).toContain('--env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1"');
        expect(script).toContain('--evb-launchservices-smoke="$token"');
        expect(script).toContain('activate_canary\nassert_frontmost_visible_window "cold packaged startup and exact-path activation"');
        expect(script).toContain('"$probe" ready "$app_pid"');
        expect(script).toContain('artifact_dir="$(cd "$artifact_dir" && pwd -P)"');
        expect(script).toContain('index($0, executable) && index($0, token)');
        expect(script).toContain('if is_tokenized_canary; then');
        expect(script).toContain('"$lsregister" -u "$app_path"');
        expect(script).not.toMatch(/\/Applications\/EVB Viewer\.app/u);
        expect(script).not.toMatch(/\bkillall\b|\bpkill\b/u);
    });

    it('requires Accessibility and exercises the foreground recovery matrix', async () => {
        const script = await readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8');

        expect(script).toContain('get UI elements enabled');
        expect(script).toContain('for cycle in $(seq 1 20)');
        expect(script).toContain('"$probe" not-frontmost "$app_pid"');
        expect(script).toContain('"$probe" not-visible "$app_pid"');
        expect(script).toContain('"$probe" minimize "$app_pid"');
        expect(script).toContain('"$probe" hide "$app_pid"');
        expect(script).toContain('"$probe" close "$app_pid"');
        expect(script).toContain('set_canary_minimized');
        expect(script).toContain('hide_canary');
        expect(script).toContain('close_last_canary_window');
        expect(script).toContain('local deadline=$((SECONDS + 55))');
        expect(script).toContain('pgrep -P "$app_pid"');
        expect(script).toContain('closing the last window kept the macOS app alive without a window');
        expect(script).toContain('last-window-closed LaunchServices recovery');
        expect(script).toContain('terminate_canary_and_wait_for_exit');
        expect(script).toContain('explicit application termination exited the app process tree');
        expect(script).toContain('assert_bundle_replaceable');
        expect(script).toContain('exited app bundle can be moved for replacement');
        expect(script).toContain('open -a "$app_path"');
    });

    it.skipIf(process.platform !== 'darwin')('denies untrusted CI before any packaged launch', () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-reactivation-policy-'));
        const appPath = join(root, 'EVB Viewer.app');
        const executablePath = join(appPath, 'Contents', 'MacOS', 'EVB Viewer');
        try {
            mkdirSync(join(appPath, 'Contents', 'MacOS'), {recursive: true});
            writeFileSync(executablePath, '#!/bin/sh\n: > "$0.launched"\nexit 0\n');
            chmodSync(executablePath, 0o755);
            writeFileSync(join(appPath, 'Contents', 'Info.plist'), '<?xml version="1.0"?>'
                + '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>EVB Viewer</string>'
                + '<key>CFBundleIdentifier</key><string>test.evb.denied</string>'
                + '<key>CFBundlePackageType</key><string>APPL</string></dict></plist>');

            const result = runPackagedPolicyScript('scripts/verify-macos-packaged-reactivation.sh', [
                'mac',
                'arm64',
            ], {EVB_REACTIVATION_APP_PATH: appPath});

            expect(result.status).toBe(1);
            expect(result.blockedCommands).toBe('');
            expect(existsSync(`${executablePath}.launched`)).toBe(false);
            expect(`${result.stdout}${result.stderr}`).toContain('production bundle identity');
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('retains isolated logs and requires the packaged-ready marker', async () => {
        const [
            script,
            releaseRunbook,
        ] = await Promise.all([
            readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8'),
            readFile('docs/release-guardrails.md', 'utf8'),
        ]);

        expect(script).toContain('EVB_REACTIVATION_ARTIFACT_DIR');
        expect(script).toContain('EVB_FILE_LOG_DIR=$log_dir');
        expect(script).toContain('printPackagedStartupReadyMarker.ts');
        expect(script).toContain('grep -F -q "$marker" "$main_log"');
        expect(script).toContain('tail -n 200 "$main_log"');
        expect(script).toContain('tail -n 200 "$window_log"');
        expect(releaseRunbook).toContain('bash scripts/verify-macos-packaged-reactivation.sh mac <arm64|x64>');
        expect(releaseRunbook).toContain('does not claim to automate the 30-minute soak');
    });
});
