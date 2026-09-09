import {PDF_COMBINE_MAX_OUTPUT_BYTES} from '@contracts/pdfCombineOutputPolicy';

export const DB_NAME = 'evb-viewer-browser-documents';
export const DB_VERSION = 5;
export const DOCUMENTS_STORE = 'documents';
export const DOCUMENT_CHUNKS_STORE = 'document-chunks';
export const WORKSPACE_RECOVERY_STORE = 'workspace-recovery';
export const BROWSER_LIVE_LEASES_STORE = 'browser-live-leases';
export const BROWSER_TRANSFER_AUTHORITY_STORE = 'browser-transfer-authority';
export const BROWSER_DOCUMENT_CHUNK_SIZE = 4 * 1024 * 1024;
// Browser records may be larger and stay chunked, but any operation that asks
// for one complete JavaScript value is limited to the shared small-input
// compatibility budget.
export const BROWSER_MAX_FULL_READ_BYTES = PDF_COMBINE_MAX_OUTPUT_BYTES;
export const BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;
export const BROWSER_MAX_RECENT_FILES = 30;
export const BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES = 512 * 1024 * 1024;
export const BROWSER_CHUNK_WRITE_YIELD_EVERY = 2;
