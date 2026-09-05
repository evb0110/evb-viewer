import type {TDocumentRef} from '@contracts/documentRef';

/** The PDF open attempt needs another password. The source remains unopened. */
export interface IPdfNeedsPasswordResult {
    kind: 'pdf-needs-password';
    originalPath: TDocumentRef;
}

/** The PDF uses encryption that the open writer cannot handle. */
export interface IPdfUnsupportedEncryptionResult {
    kind: 'pdf-unsupported-encryption';
    originalPath: TDocumentRef;
}

export type TPdfOpenFileFailureResult = IPdfNeedsPasswordResult | IPdfUnsupportedEncryptionResult;
