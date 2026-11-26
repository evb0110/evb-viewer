/** The browser target every browser WASM tool is built for. */
const WASM_TARGET = 'wasm32-unknown-unknown';
/** The target of browser engines that run on threads over a shared memory. */
const WASM_THREADS_TARGET = 'wasm32-wasip1-threads';

/** @typedef {{relativePath: string, requiredExports: string[]}} IRequiredWebWasmAsset */
/**
 * One browser WASM file built by cargo. `id` keys its recorded build identity;
 * a crate can have several artifacts, one per Rust target. `lowerBulkMemory`
 * replaces its `memory.copy` and `memory.fill` after the link (see
 * scripts/lib/lower-wasm-bulk-memory.mjs).
 * @typedef {{builtFileName: string, crateName: string, id: string, label: string, lowerBulkMemory?: boolean, manifestPath: string, publicRelativePath: string, requiredExports: string[], rustTarget: string, rustflags: string[]}} IWasmArtifact
 */
/** @typedef {{bytes: number, label: string, publicRelativePath: string, sha256: string, url: string}} IPrebuiltWasmFile */

/** @type {IRequiredWebWasmAsset[]} */
export const REQUIRED_WEB_WASM_ASSETS = [
    {
        relativePath: 'wasm/evb-pdf-image-combine.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_pdf_image_combine_alloc',
            'evb_pdf_image_combine_free',
            'evb_pdf_image_combine_build_pdf',
            'evb_pdf_image_combine_output_ptr',
            'evb_pdf_image_combine_output_len',
            'evb_pdf_image_combine_error_ptr',
            'evb_pdf_image_combine_error_len',
        ],
    },
    {
        relativePath: 'wasm/evb-pdf-page-ops.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_pdf_page_ops_alloc',
            'evb_pdf_page_ops_free',
            'evb_pdf_page_ops_run',
            'evb_pdf_page_ops_output_ptr',
            'evb_pdf_page_ops_output_len',
            'evb_pdf_page_ops_error_ptr',
            'evb_pdf_page_ops_error_len',
            'evb_pdf_page_ops_append_admission',
        ],
    },
    {
        relativePath: 'wasm/evb-pdf-search.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_pdf_search_alloc',
            'evb_pdf_search_free',
            'evb_pdf_search_run',
            'evb_pdf_search_output_ptr',
            'evb_pdf_search_output_len',
            'evb_pdf_search_error_ptr',
            'evb_pdf_search_error_len',
        ],
    },
    {
        relativePath: 'wasm/evb-scan-cleanup.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_scan_cleanup_alloc',
            'evb_scan_cleanup_free',
            'evb_scan_cleanup_run',
            'evb_scan_cleanup_output_ptr',
            'evb_scan_cleanup_output_len',
            'evb_scan_cleanup_error_ptr',
            'evb_scan_cleanup_error_len',
        ],
    },
    // The same engine on a Rayon pool of host threads. A WASI reactor: the host
    // calls _initialize once on the main instance and starts each thread
    // instance at wasi_thread_start.
    {
        relativePath: 'wasm/evb-scan-cleanup-threads.wasm',
        requiredExports: [
            'memory',
            '_initialize',
            'wasi_thread_start',
            'evb_wasm_request_allocation_abi_version',
            'evb_scan_cleanup_alloc',
            'evb_scan_cleanup_free',
            'evb_scan_cleanup_run',
            'evb_scan_cleanup_output_ptr',
            'evb_scan_cleanup_output_len',
            'evb_scan_cleanup_error_ptr',
            'evb_scan_cleanup_error_len',
            'evb_scan_cleanup_start_threads',
            'evb_scan_cleanup_thread_fault_ptr',
        ],
    },
    // Emscripten minifies the engine's export names; its pinned digest is the identity.
    {
        relativePath: 'wasm/evb-tesseract.wasm',
        requiredExports: [],
    },
    {
        relativePath: 'wasm/evb-qpdf.wasm',
        requiredExports: [],
    },
    {
        relativePath: 'wasm/evb-djvulibre.wasm',
        requiredExports: [],
    },
];

const requiredExportsByRelativePath = new Map(
    REQUIRED_WEB_WASM_ASSETS.map(asset => [
        asset.relativePath,
        asset.requiredExports,
    ]),
);

/** @param {string} relativePath @returns {string[]} */
function getRequiredExports(relativePath) {
    const requiredExports = requiredExportsByRelativePath.get(relativePath);
    if (!requiredExports) {
        throw new Error(`Missing required exports for WASM asset: ${relativePath}`);
    }
    return requiredExports;
}

// The rustc wrapper passes these flags where Cargo cannot see them, so Cargo
// would reuse a crate compiled under one artifact's flags for another artifact
// of the same target; every artifact of a target takes that target's flags.
// getrandom, which only pdf-page-ops depends on, reads its backend from a cfg.
const WASM_TARGET_RUSTFLAGS = [
    '--cfg',
    'getrandom_backend="custom"',
];

/** @type {IWasmArtifact[]} */
export const WASM_ARTIFACTS = [
    {
        builtFileName: 'evb_pdf_image_combine.wasm',
        crateName: 'pdf-image-combine',
        id: 'pdf-image-combine',
        label: 'PDF image combine WASM',
        manifestPath: 'native/pdf-image-combine/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-image-combine.wasm',
        requiredExports: getRequiredExports('wasm/evb-pdf-image-combine.wasm'),
        rustTarget: WASM_TARGET,
        rustflags: WASM_TARGET_RUSTFLAGS,
    },
    {
        builtFileName: 'evb_pdf_page_ops.wasm',
        crateName: 'pdf-page-ops',
        id: 'pdf-page-ops',
        label: 'PDF page ops WASM',
        manifestPath: 'native/pdf-page-ops/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-page-ops.wasm',
        requiredExports: getRequiredExports('wasm/evb-pdf-page-ops.wasm'),
        rustTarget: WASM_TARGET,
        rustflags: WASM_TARGET_RUSTFLAGS,
    },
    {
        builtFileName: 'evb_pdf_search.wasm',
        crateName: 'pdf-search',
        id: 'pdf-search',
        label: 'PDF search WASM',
        manifestPath: 'native/pdf-search/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-search.wasm',
        requiredExports: getRequiredExports('wasm/evb-pdf-search.wasm'),
        rustTarget: WASM_TARGET,
        rustflags: WASM_TARGET_RUSTFLAGS,
    },
    {
        builtFileName: 'evb_scan_cleanup.wasm',
        crateName: 'scan-cleanup',
        id: 'scan-cleanup',
        label: 'Scan cleanup WASM',
        manifestPath: 'native/scan-cleanup/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-scan-cleanup.wasm',
        requiredExports: getRequiredExports('wasm/evb-scan-cleanup.wasm'),
        rustTarget: WASM_TARGET,
        rustflags: WASM_TARGET_RUSTFLAGS,
    },
    {
        builtFileName: 'evb_scan_cleanup.wasm',
        crateName: 'scan-cleanup',
        id: 'scan-cleanup-threads',
        label: 'Threaded scan cleanup WASM',
        // V8 checks bulk memory instructions against each thread's cached
        // memory size, which can lag another thread's growth.
        lowerBulkMemory: true,
        manifestPath: 'native/scan-cleanup/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-scan-cleanup-threads.wasm',
        requiredExports: getRequiredExports('wasm/evb-scan-cleanup-threads.wasm'),
        rustTarget: WASM_THREADS_TARGET,
        // The shared memory starts at a fixed 32 pages, so a host can create it
        // without reading the module, and may grow to the 4 GiB wasm32 limit
        // (the linker otherwise caps it at its initial size). The reactor
        // startup object, which rustc leaves out of a cdylib, sets up libc and
        // exports _initialize; the linker finds it by name in the toolchain.
        rustflags: [
            '-C',
            'link-arg=--initial-memory=2097152',
            '-C',
            'link-arg=--max-memory=4294967296',
            '-C',
            'link-arg=-l:crt1-reactor.o',
        ],
    },
];

const PREBUILT_WASM_BASE_URL = 'https://github.com/evb0110/evb-viewer/releases/download/runtime-binaries-v2';

/**
 * Browser files built by a pinned toolchain outside cargo, fetched by digest.
 * The browser OCR engine is scripts/build-tesseract-wasm.sh output; rebuilding
 * it with the same toolchain reproduces these bytes.
 * @type {IPrebuiltWasmFile[]}
 */
export const PREBUILT_WASM_FILES = [
    {
        bytes: 2536662,
        label: 'Tesseract OCR engine WASM',
        publicRelativePath: 'public/wasm/evb-tesseract.wasm',
        sha256: 'affb1417875bbea1df8980fc55b3a5f95f4bb6d0638410cf1f40314e5f6bcbd1',
        url: `${PREBUILT_WASM_BASE_URL}/evb-tesseract-5.5.3-r2.wasm`,
    },
    {
        bytes: 70908,
        label: 'Tesseract OCR engine module',
        publicRelativePath: 'public/wasm/evb-tesseract.mjs',
        sha256: 'f82b9c7173d9ccc34db0d45ebf49db690dcb905b6be5caee295ff8e24b84a848',
        url: `${PREBUILT_WASM_BASE_URL}/evb-tesseract-5.5.3-r1.mjs`,
    },
    // scripts/build-qpdf-wasm.sh, the desktop's qpdf for browser repair and rewrites.
    {
        bytes: 2587783,
        label: 'qpdf engine WASM',
        publicRelativePath: 'public/wasm/evb-qpdf.wasm',
        sha256: 'dded30522af651ab3c7cf62be7b49e242a5576c3d38f08bbe89b00eb45204286',
        url: `${PREBUILT_WASM_BASE_URL}/evb-qpdf-12.3.2-r1.wasm`,
    },
    {
        bytes: 82818,
        label: 'qpdf engine module',
        publicRelativePath: 'public/wasm/evb-qpdf.mjs',
        sha256: '588c8d50aba83da884a48dbcfb15cd74589403f2086f94ea3d8da5f1d2eb530d',
        url: `${PREBUILT_WASM_BASE_URL}/evb-qpdf-12.3.2-r1.mjs`,
    },
    // scripts/build-djvulibre-wasm.sh, the unified DjVuLibre engine for web and desktop.
    {
        bytes: 991767,
        label: 'DjVuLibre engine WASM',
        publicRelativePath: 'public/wasm/evb-djvulibre.wasm',
        sha256: '00062edad0b74ef8b84c7d8b1103c45dbb2bf48238af4b127355422d35c4374c',
        url: `${PREBUILT_WASM_BASE_URL}/evb-djvulibre-3.5.30-r1.wasm`,
    },
    {
        bytes: 25350,
        label: 'DjVuLibre engine module',
        publicRelativePath: 'public/wasm/evb-djvulibre.mjs',
        sha256: '33ecc6df4253452617f4169cb39168f3a75e3a9220a971fe1910fafeb15c005a',
        url: `${PREBUILT_WASM_BASE_URL}/evb-djvulibre-3.5.30-r1.mjs`,
    },
];

/** Every browser WASM file under public/, built or fetched. */
export const BROWSER_WASM_PUBLIC_PATHS = [
    ...WASM_ARTIFACTS.map(artifact => artifact.publicRelativePath),
    ...PREBUILT_WASM_FILES.map(file => file.publicRelativePath),
];

/** @param {string} crateName @returns {IWasmArtifact[]} */
export function getWasmArtifactsByCrateName(crateName) {
    const artifacts = WASM_ARTIFACTS.filter(entry => entry.crateName === crateName);
    if (artifacts.length === 0) {
        throw new Error(`Unknown WASM artifact crate: ${crateName}`);
    }
    return artifacts;
}
