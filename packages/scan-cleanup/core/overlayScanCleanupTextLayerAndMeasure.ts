import {decodeScanCleanupPageOpsResult} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { overlayScanCleanupTextLayer } from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
import {
    assertScanCleanupCompactSourceBudget,
    type IScanCleanupCompactSourceBudget,
} from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';
import type { IScanCleanupRepresentationReport } from '@evb/scan-cleanup/core/types';

/**
 * Overlays the source text once over the finished output. The batches measured
 * the output before this pass, so when the overlay rewrites it, the
 * representation report and the compact-source budget are brought up to date
 * with the file that will be published. Returns the native output loss result.
 */
export async function overlayScanCleanupTextLayerAndMeasure(
    ...args: Parameters<typeof overlayScanCleanupTextLayer>
) {
    const stagedPdfPath = args[3];
    const scratch = args[4];
    const result = await overlayScanCleanupTextLayer(...args);
    if (result === null) {
        return decodeScanCleanupPageOpsResult('');
    }
    const after = await stat(stagedPdfPath);
    const reportPath = join(scratch, 'scan-cleanup-representation-report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as IScanCleanupRepresentationReport;
    report.outputBytes = after.size;
    report.outputToSourceByteRatio = after.size / report.sourceBytes;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assertScanCleanupCompactSourceBudget(
        after.size,
        report.compactSourceBudget as IScanCleanupCompactSourceBudget | null,
    );
    return result;
}
