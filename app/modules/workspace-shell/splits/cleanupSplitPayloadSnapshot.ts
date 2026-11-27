import type {TSplitPayload} from '@contracts/windowTabs';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';

export async function cleanupSplitPayloadSnapshot(
    payload: TSplitPayload | null | undefined,
    options: {
        logSection: string;
        context: string;
        metadata?: Record<string, unknown>;
    },
) {
    if (!payload || payload.kind !== 'pdfSnapshot') {
        return false;
    }

    try {
        await getDocumentWorkingCopyCapability().cleanupFile(payload.snapshotPath);
        return true;
    } catch (error) {
        BrowserLogger.warn(options.logSection, 'Failed to cleanup split payload snapshot', {
            context: options.context,
            snapshotPath: payload.snapshotPath,
            ...options.metadata,
            error,
        });
        return false;
    }
}
