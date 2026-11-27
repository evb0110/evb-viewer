import {dirname} from 'path';
import {compact} from 'es-toolkit/array';

function hasDirectoryInPath(command: string) {
    return command.includes('/') || command.includes('\\');
}

export function getCommandDirectory(command: string) {
    if (!hasDirectoryInPath(command)) {
        return null;
    }
    const resolvedDir = dirname(command);
    if (!resolvedDir || resolvedDir === '.') {
        return null;
    }
    return resolvedDir;
}

function resolvePathKey(env: NodeJS.ProcessEnv) {
    const existing = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    if (existing) {
        return existing;
    }
    return process.platform === 'win32' ? 'Path' : 'PATH';
}

export function prependDirectoryToPath(commandDir: string, env: NodeJS.ProcessEnv) {
    const pathKey = resolvePathKey(env);
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const currentPath = env[pathKey] ?? '';
    const normalizedExisting = compact(currentPath.split(delimiter).map((entry) => entry.trim()));

    if (normalizedExisting.includes(commandDir)) {
        return env;
    }

    return {
        ...env,
        [pathKey]: currentPath ? `${commandDir}${delimiter}${currentPath}` : commandDir,
    };
}
