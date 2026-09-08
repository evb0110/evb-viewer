import {spawnSync} from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Denial tests must remain unable to launch apps even if the policy regresses. */
export function runPackagedPolicyScript(script: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const root = mkdtempSync(join(tmpdir(), 'evb-policy-script-'));
    const marker = join(root, 'blocked-commands');
    try {
        for (const command of [
            'open',
            'osascript',
            'xcrun',
            'hdiutil',
        ]) {
            writeFileSync(join(root, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$EVB_TEST_BLOCKED_COMMANDS"\nexit 98\n', {mode: 0o755});
        }
        const result = spawnSync('/bin/bash', [
            script,
            ...args,
        ], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 5_000,
            killSignal: 'SIGKILL',
            env: {
                ...overrides,
                PATH: `${root}:${process.env.PATH ?? '/usr/bin:/bin'}`,
                HOME: root,
                TMPDIR: root,
                CI: 'true',
                GITHUB_ACTIONS: '',
                RUNNER_ENVIRONMENT: '',
                EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST: '',
                EVB_LAUNCHSERVICES_DMG_PATH: join(root, 'absent.dmg'),
                EVB_TEST_BLOCKED_COMMANDS: marker,
            },
        });
        if (result.error) throw new Error(`Policy script ${script} failed: ${result.error.message}`, {cause: result.error});
        return {
            ...result,
            blockedCommands: existsSync(marker) ? readFileSync(marker, 'utf8') : '',
        };
    } finally {
        rmSync(root, {
            recursive: true,
            force: true,
        });
    }
}
