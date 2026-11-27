import {statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {getCliErrorMessage} from './lib/cli-error.mjs';

const require = createRequire(import.meta.url);

function isFile(filePath) {
    try {
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function verifyElectronInstall({loadElectron = () => require('electron'), pathIsFile = isFile} = {}) {
    let electronBinaryPath;

    try {
        electronBinaryPath = loadElectron();
    } catch (error) {
        throw new Error(
            'Electron binary is not installed for this checkout. ' +
                'Run pnpm install with network access, or retry this check after restoring network access. ' +
                `Original error: ${getCliErrorMessage(error)}`,
        );
    }

    if (typeof electronBinaryPath !== 'string' || electronBinaryPath.length === 0) {
        throw new Error('Electron package did not resolve to an executable path');
    }

    if (!pathIsFile(electronBinaryPath)) {
        throw new Error(`Electron executable does not exist at ${electronBinaryPath}`);
    }

    return electronBinaryPath;
}

function main() {
    const electronBinaryPath = verifyElectronInstall();
    process.stdout.write(`Electron install verified: ${electronBinaryPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${getCliErrorMessage(error)}\n`);
        process.exit(1);
    }
}
