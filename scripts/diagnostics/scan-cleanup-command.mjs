import {spawn} from 'node:child_process';

export function runDiagnosticCommand(
    command,
    args,
    {
        allowFailure = false,
        cwd,
        env = process.env,
        onFailure = ({command: failedCommand, args: failedArgs, code, stderr, stdout}) =>
            new Error(
                [`${failedCommand} ${failedArgs.join(' ')} exited with ${String(code)}`, stderr.trim(), stdout.trim()]
                    .filter(Boolean)
                    .join('\n'),
            ),
        completionEvent = 'close',
        resolveCommand = (value) => value,
        stdioDrainTimeoutMs = 5_000,
    } = {},
) {
    return new Promise((resolveRun, rejectRun) => {
        const resolved = resolveCommand(command);
        const spawnedCommand = typeof resolved === 'string' ? resolved : resolved.command;
        const spawnedArgs = typeof resolved === 'string' ? args : [...resolved.args, ...args];
        const child = spawn(spawnedCommand, spawnedArgs, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let exitCode = null;
        let drainTimeout;
        let settled = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        const settle = (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(drainTimeout);
            if (code !== 0 && !allowFailure) {
                rejectRun(
                    onFailure({
                        args: spawnedArgs,
                        code,
                        command: spawnedCommand,
                        stderr,
                        stdout,
                    }),
                );
                return;
            }
            resolveRun({
                code,
                stderr,
                stdout,
            });
        };
        child.once('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(drainTimeout);
            rejectRun(error);
        });
        child.once('exit', (code) => {
            exitCode = code;
            if (completionEvent === 'exit') {
                settle(code);
                return;
            }
            drainTimeout = setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                settle(code);
            }, stdioDrainTimeoutMs);
            drainTimeout.unref();
        });
        child.once('close', (code) => settle(code ?? exitCode));
    });
}
