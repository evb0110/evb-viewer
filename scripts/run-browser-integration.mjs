import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
// pnpm run SCRIPT -- OPTIONS retains the separator. Vitest treats everything
// after it as positional arguments, so remove it before forwarding the options.
if (args[0] === '--') args.shift();

const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--project',
    'browser-integration',
    ...args,
], { stdio: 'inherit' });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
