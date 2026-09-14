import path from 'node:path';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';
import { isVmUuid } from '@scripts/windows-test/contracts/windowsTestContracts';

export const UTM_BUNDLE_EXTENSION = '.utm';

export const UTM_BUNDLE_CONFIG_FILE = 'config.plist';

export function utmBundlePathForName(testImageRoot: string, vmName: string) {
    return path.join(testImageRoot, 'clones', `${vmName}${UTM_BUNDLE_EXTENSION}`);
}

export interface IVmBundleIdentityReader {
    readVmId(bundlePath: string): Promise<string | null>;
    readVmName(bundlePath: string): Promise<string | null>;
}

// `utmctl` never prints a bundle path, so the host reads the UUID and display
// name out of the bundle it located by name and cross-checks both before any
// destructive call.
export function createPlutilBundleIdentityReader(
    runner: ICommandRunner,
    options: {
        plutilPath?: string;
        timeoutMs?: number;
    } = {},
): IVmBundleIdentityReader {
    const plutilPath = options.plutilPath ?? '/usr/bin/plutil';
    const timeoutMs = options.timeoutMs ?? 10_000;
    const readRawValue = async (bundlePath: string, keyPath: string) => {
        const result = await runner.run(plutilPath, [
            '-extract',
            keyPath,
            'raw',
            '-o',
            '-',
            path.join(bundlePath, UTM_BUNDLE_CONFIG_FILE),
        ], {timeoutMs});
        if (result.exitCode !== 0) {
            return null;
        }
        const value = result.stdout.trim();
        return value.length > 0 ? value : null;
    };

    return {
        readVmId: async (bundlePath) => {
            const uuid = (await readRawValue(bundlePath, 'Information.UUID'))?.toLowerCase() ?? null;
            return uuid !== null && isVmUuid(uuid) ? uuid : null;
        },
        readVmName: bundlePath => readRawValue(bundlePath, 'Information.Name'),
    };
}
