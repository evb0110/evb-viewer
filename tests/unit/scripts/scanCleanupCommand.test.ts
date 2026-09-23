import {
    describe,
    expect,
    it,
} from 'vitest';
import {runDiagnosticCommand} from '@scripts/diagnostics/scan-cleanup-command.mjs';

describe('scan-cleanup diagnostic command runner', () => {
    // The grandchild is detached because libuv on Windows otherwise places it in
    // the parent's kill-on-close job, so it would die with the parent instead of
    // holding the inherited streams open. POSIX keeps the same stdio either way.
    it('waits for inherited child streams before resolving', async () => {
        const inheritedChildScript = [
            'setTimeout(() => {',
            '    process.stdout.write(\'late stdout\\n\');',
            '    process.stderr.write(\'late stderr\\n\');',
            '}, 100);',
        ].join('\n');
        const parentScript = [
            'const {spawn} = require(\'node:child_process\');',
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(inheritedChildScript)}], {detached: true, stdio: 'inherit'});`,
            'child.unref();',
        ].join('\n');

        await expect(runDiagnosticCommand(process.execPath, [
            '-e',
            parentScript,
        ])).resolves.toMatchObject({
            code: 0,
            stderr: 'late stderr\n',
            stdout: 'late stdout\n',
        });
    });

    it('supports an explicit interpreter for script command overrides', async () => {
        const script = 'process.stdout.write(process.argv[1]);';
        const commandOptions = {resolveCommand: () => ({
            args: [
                '-e',
                script,
            ],
            command: process.execPath,
        })};

        await expect(runDiagnosticCommand('wrapper.mjs', ['fixture.pdf'], commandOptions)).resolves.toMatchObject({
            code: 0,
            stdout: 'fixture.pdf',
        });
    });

    it('bounds the inherited-stream drain when a grandchild never exits', async () => {
        const grandchildScript = 'setInterval(() => {}, 60_000);';
        const parentScript = [
            'const {spawn} = require(\'node:child_process\');',
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {detached: true, stdio: 'inherit'});`,
            'process.stdout.write(String(child.pid));',
            'child.unref();',
        ].join('\n');

        const startedAt = Date.now();
        let grandchildPid: number | undefined;
        let cleanupError: unknown;
        try {
            const result = await runDiagnosticCommand(process.execPath, [
                '-e',
                parentScript,
            ], {stdioDrainTimeoutMs: 50});
            const parsedPid = Number(result.stdout.trim());
            grandchildPid = Number.isSafeInteger(parsedPid) && parsedPid > 0
                ? parsedPid
                : undefined;
            expect(result).toMatchObject({code: 0});
            expect(grandchildPid).toBeDefined();
            expect(Date.now() - startedAt).toBeLessThan(2_000);
        } finally {
            if (grandchildPid !== undefined) {
                try {
                    process.kill(grandchildPid);
                } catch (error) {
                    const errorCode = error instanceof Error && 'code' in error
                        ? error.code
                        : undefined;
                    if (errorCode !== 'ESRCH') {
                        cleanupError = error;
                    }
                }
            }
        }
        if (cleanupError !== undefined) {
            throw cleanupError;
        }
    });
});
