import {PDF_COMBINE_MAX_OUTPUT_BYTES} from '@contracts/pdfCombineOutputPolicy';

export const BROWSER_DOCUMENT_CHUNK_SIZE = 4 * 1024 * 1024;
// Default byte-returning budget. Viewing uses ranges; whole-input WASM
// operations admit their reads against their own transport budget.
export const BROWSER_MAX_FULL_READ_BYTES = PDF_COMBINE_MAX_OUTPUT_BYTES;
