import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    app,
    type BrowserWindow,
} from 'electron';
import type {
    IHostBugReportBundle,
    IHostBugReportWriteResult,
} from '@contracts/hostPlatformFeature';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('bug-report');
const BUG_REPORT_ROOT_DIRECTORY = 'bug-reports';

const REFUSED: IHostBugReportWriteResult = {
    directoryName: '',
    screenshotWritten: false,
    written: false,
};

/** A directory name a filesystem accepts on every supported platform. */
function buildBundleDirectoryName(now: Date) {
    return now.toISOString().replaceAll(':', '-');
}

/**
 * Writes a development bug report next to the app profile: the renderer's own
 * JSON plus a screenshot of the window it was captured from.
 *
 * The renderer supplies only the JSON body. The timestamp, the directory, and
 * the screenshot are chosen here so a renderer cannot pick a write location,
 * and a packaged build refuses the call outright because the feature exists
 * for development sessions.
 */
export async function writeHostBugReportBundle(
    window: BrowserWindow | null,
    bundle: IHostBugReportBundle,
): Promise<IHostBugReportWriteResult> {
    if (app.isPackaged) {
        return REFUSED;
    }
    if (!window || window.isDestroyed()) {
        return REFUSED;
    }

    const directoryName = buildBundleDirectoryName(new Date());
    const directory = join(app.getPath('userData'), BUG_REPORT_ROOT_DIRECTORY, directoryName);
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, 'report.json'), bundle.reportJson, 'utf-8');

    let screenshotWritten = false;
    try {
        // An explicit content rect is required: an undefined rect captures an
        // empty frame. `stayHidden` keeps an automation window from being
        // revealed by the capture.
        const bounds = window.getContentBounds();
        const image = await window.webContents.capturePage({
            height: bounds.height,
            width: bounds.width,
            x: 0,
            y: 0,
        }, {stayHidden: true});
        if (image.isEmpty()) {
            logger.warn('Bug report screenshot was empty; the window produced no frame');
        } else {
            await writeFile(join(directory, 'screenshot.png'), image.toPNG());
            screenshotWritten = true;
        }
    } catch (error) {
        // A missing screenshot must not lose the report that names the defect.
        logger.warn(`Bug report screenshot failed: ${getErrorMessage(error)}`);
    }

    logger.info(`Wrote bug report bundle ${directoryName}`);
    return {
        directoryName,
        screenshotWritten,
        written: true,
    };
}
