import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 45_000];
const TRANSIENT_ERROR_PATTERNS = [
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ECONNREFUSED/i,
    /socket hang up/i,
    /network timeout/i,
    /request.*failed/i,
    /fetch.*failed/i,
    /5\d\d.*(github|electron|npm|registry)/i,
];

const installArgs = process.argv.slice(2);

if (installArgs.length === 0) {
    installArgs.push('--frozen-lockfile');
}

function runPnpmInstall() {
    return new Promise((resolve) => {
        const chunks = [];
        const child = spawn('pnpm', ['install', ...installArgs], {
            env: process.env,
            shell: process.platform === 'win32',
            stdio: ['inherit', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
            chunks.push(chunk);
            process.stdout.write(chunk);
        });

        child.stderr.on('data', (chunk) => {
            chunks.push(chunk);
            process.stderr.write(chunk);
        });

        child.on('error', (error) => {
            chunks.push(Buffer.from(error.stack ?? error.message));
            resolve({
                code: 1,
                output: chunks.join(''),
            });
        });

        child.on('close', (code) => {
            resolve({
                code: code ?? 1,
                output: chunks.join(''),
            });
        });
    });
}

function isTransientInstallFailure(output) {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    process.stdout.write(`pnpm install attempt ${attempt}/${MAX_ATTEMPTS}\n`);

    const result = await runPnpmInstall();

    if (result.code === 0) {
        process.exit(0);
    }

    if (attempt === MAX_ATTEMPTS || !isTransientInstallFailure(result.output)) {
        process.exit(result.code);
    }

    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1);
    process.stderr.write(`pnpm install failed with a transient network error; retrying in ${delayMs / 1000}s\n`);
    await delay(delayMs);
}
