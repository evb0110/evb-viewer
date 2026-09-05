import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { BrowserLogger } from '@app/utils/browserLogger';
import { toTransferableUint8Array } from '@app/platform/browser-api/public';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import { NativePdfSaveRequiredError } from '@app/modules/workspace-shell/public/nativePdfMutationArtifact';

export function createPdfSourceDataReader(deps: {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
}) {
    const {
        pdfData,
        workingCopyPath,
        documentRevisionToken,
    } = deps;
    return async function getSourcePdfData() {
        if (pdfData.value) {
            return toTransferableUint8Array(pdfData.value);
        }
        const path = workingCopyPath.value;
        if (!path) {
            return null;
        }
        if (isNativeDocumentRef(path)) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'missing-native-capability',
                detail: 'Renderer source reads cannot read a native path-backed working copy',
            });
        }
        try {
            const files = getDocumentFilesCapability();
            const before = await files.getDocumentRevision(path);
            const expectedRevision = documentRevisionToken?.value ?? before.token;
            if (before.token !== expectedRevision) {
                throw new Error('Working-copy revision changed before source read');
            }
            const bytes = toTransferableUint8Array(await readDocumentBytes(path));
            const after = await files.getDocumentRevision(path);
            if (after.token !== expectedRevision) {
                throw new Error('Working-copy revision changed during source read');
            }
            return bytes;
        } catch (error) {
            BrowserLogger.warn('pdf-source', 'Failed to read working copy', {
                path,
                error,
            });
            throw error;
        }
    };
}
