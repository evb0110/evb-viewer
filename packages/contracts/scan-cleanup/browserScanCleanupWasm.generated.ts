// Generated from the evb-scan-cleanup Rust WASM entry; do not edit.
// Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_wasm_typescript`.
// Numeric frame fields are little-endian u32 values.

export const SCAN_CLEANUP_WASM_REQUEST_MAGIC = 'ESCW';
export const SCAN_CLEANUP_WASM_REQUEST_VERSION = 1;
export const SCAN_CLEANUP_WASM_OP_RENDER_PREVIEW = 1;
export const SCAN_CLEANUP_WASM_OP_ANALYZE = 2;
export const SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW = 0;
export const SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG = 1;
export const SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8 = 1;
export const SCAN_CLEANUP_WASM_PLANE_KIND_RGB8 = 2;
export const SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES = 28;
export const SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES = 8;
export const SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES = 24;
export const SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES = 5242880;
export const SCAN_CLEANUP_WASM_MAX_REQUEST_BYTES = 1073741824;
export const SCAN_CLEANUP_WASM_MAX_OUTPUT_BYTES = 1073741824;
