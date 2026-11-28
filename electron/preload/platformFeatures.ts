/**
 * Canonical platform feature imports for Electron preload.
 *
 * In TypeScript and Vitest, this module re-exports the canonical contract
 * feature definitions directly so every capability type is checked against the
 * single source of truth.
 *
 * During `pnpm run build:electron`, `scripts/build-electron.mjs` replaces this
 * module in the `preload.cjs` bundle with build-time-extracted lightweight
 * channel descriptors (path, method channels/timeouts/mappers, event channels/
 * subscriptions), keeping all main-side Valibot request schemas out of
 * `preload.cjs` with zero manual duplication or drift.
 */
export {IMAGE_EXPORT_PLATFORM_FEATURE} from '@contracts/imageExportPlatformFeature';
export {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
export {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
export {OCR_PLATFORM_FEATURE} from '@contracts/ocrPlatformFeature';
export {PAGE_OPS_PLATFORM_FEATURE} from '@contracts/pageOpsPlatformFeature';
export {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
export {SETTINGS_PLATFORM_FEATURE} from '@contracts/settingsPlatformFeature';
export {SHELL_PLATFORM_FEATURE} from '@contracts/shellPlatformFeature';
export {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';
export {HOST_PLATFORM_FEATURE} from '@contracts/hostPlatformFeature';
export {SYSTEM_PLATFORM_FEATURE} from '@contracts/systemPlatformFeature';
export {WINDOW_TABS_PLATFORM_FEATURE} from '@contracts/windowTabsPlatformFeature';
export {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
export {FULL_SCAN_CLEANUP_SUPPORT, SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
