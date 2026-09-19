import {
    mkdir,
    readdir,
    rm,
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
/** A screenshot per bundle, so an unbounded directory fills a disk quietly. */
const BUG_REPORT_RETAINED_BUNDLES = 20;
/** The directory name this writer produces: an ISO timestamp with safe colons. */
const BUNDLE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/u;

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
 * Keeps the newest bundles and removes the rest. The names are ISO timestamps,
 * so sorting them lexicographically sorts them by time. Only names this writer
 * could have produced are removed, so anything a person left in the directory
 * stays where they put it.
 */
async function pruneOlderBundles(root: string) {
    const entries = await readdir(root, {withFileTypes: true});
    const bundles = entries
        .filter(entry => entry.isDirectory() && BUNDLE_DIRECTORY_PATTERN.test(entry.name))
        .map(entry => entry.name)
        .sort();
    for (const name of bundles.slice(0, Math.max(0, bundles.length - BUG_REPORT_RETAINED_BUNDLES))) {
        await rm(join(root, name), {
            force: true,
            recursive: true,
        });
    }
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
    const root = join(app.getPath('userData'), BUG_REPORT_ROOT_DIRECTORY);
    const directory = join(root, directoryName);
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

    try {
        await pruneOlderBundles(root);
    } catch (error) {
        // Retention is housekeeping. A bundle that is already on disk stays
        // reportable even when the old ones cannot be removed.
        logger.warn(`Bug report retention failed: ${getErrorMessage(error)}`);
    }

    logger.info(`Wrote bug report bundle ${directoryName}`);
    return {
        directoryName,
        screenshotWritten,
        written: true,
    };
}
