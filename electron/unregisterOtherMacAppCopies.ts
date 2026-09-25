import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('mac-app-copies');
const execFileAsync = promisify(execFile);
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
// Matches appId in electron-builder.yml.
const MAC_BUNDLE_ID = 'com.evb.viewer';

async function listRegisteredCopies() {
    const script = `
        ObjC.import('CoreServices');
        const urls = ObjC.castRefToObject($.LSCopyApplicationURLsForBundleIdentifier($('${MAC_BUNDLE_ID}'), null));
        const paths = [];
        for (let index = 0; urls && index < urls.count; index += 1) {
            paths.push(ObjC.unwrap(urls.objectAtIndex(index).path));
        }
        JSON.stringify(paths);
    `;
    const {stdout} = await execFileAsync('osascript', [
        '-l',
        'JavaScript',
        '-e',
        script,
    ], {timeout: 10_000});
    const paths: unknown = JSON.parse(stdout.trim());
    return Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === 'string')
        : [];
}

/**
 * Finder's "Open With" lists every registered copy of the app, so an old DMG
 * copy or a local build shows up beside the installed one. The installed copy
 * unregisters the others; it deletes nothing, and a copy that is launched
 * again registers itself again.
 */
export async function unregisterOtherMacAppCopies() {
    if (process.platform !== 'darwin' || !app.isPackaged) {
        return;
    }
    const currentBundle = dirname(dirname(dirname(process.execPath)));
    if (!currentBundle.startsWith('/Applications/')) {
        return;
    }
    try {
        for (const path of await listRegisteredCopies()) {
            if (path === currentBundle) {
                continue;
            }
            await execFileAsync(LSREGISTER, [
                '-u',
                path,
            ], {timeout: 10_000});
            logger.info(`Unregistered another copy of the app: ${path}`);
        }
    } catch (error) {
        logger.warn(`Failed to unregister other app copies: ${getErrorMessage(error)}`);
    }
}
