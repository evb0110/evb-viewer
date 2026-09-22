import type { TOpenFileResult } from '@contracts/electronApiDocuments';

/**
 * A generated PDF (combine output, converted image, scan cleanup) is open once
 * its pages load. Waiting for its first paint stalls when the target tab is
 * behind a full-page tool, and the tab's own skeleton already covers the gap.
 * Recovery restores keep waiting for the painted baseline they resume.
 */
export function acceptsDocumentWithoutVisual(result: TOpenFileResult) {
    return result.kind === 'pdf'
        && result.isGenerated === true
        && result.recoveryDirtyBaseline !== true;
}
