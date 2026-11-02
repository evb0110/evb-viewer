import {MAX_BUFFER_BYTES} from '@contracts/browserPageOpsWasm.generated';

/**
 * Whole-input WASM transport ceilings; range-based viewing does not use them.
 * Each is one wasm32 Rust allocation, so neither can exceed isize::MAX there.
 * The parsed document and scratch share the same 4 GiB address space, and an
 * engine that runs out of it reports `too-large` and is discarded.
 */
export const BROWSER_PAGE_OPS_MAX_REQUEST_BYTES = MAX_BUFFER_BYTES;
export const BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES = MAX_BUFFER_BYTES;
