import { getHostCapability } from '@app/utils/getHostCapability';
import {
    buildViewerBugReport,
    readDocumentSourcePath,
} from '@app/modules/viewer-invariants/buildViewerBugReport';

/**
 * Writes the bundle through the host capability. The main process owns the
 * timestamp, the directory, and the screenshot, so this side only decides what
 * the report says.
 *
 * Building the report is a pure DOM read and lives apart from this write, so
 * what a bundle may contain can be judged without the platform API.
 */
export async function captureViewerBugReport(appVersion: string) {
    const report = buildViewerBugReport(appVersion);
    return getHostCapability().writeBugReportBundle({
        reportJson: JSON.stringify(report, null, 2),
        sourcePath: readDocumentSourcePath(),
    });
}
