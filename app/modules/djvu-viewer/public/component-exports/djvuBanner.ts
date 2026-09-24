/**
 * Granular entry point so shell components can statically import just the banner.
 * The banner reserves layout space on the first frame of a DjVu open, so it must never
 * sit behind an async chunk — but a static import of the module-wide `public` barrel
 * would drag the whole DjVu viewer into the eager bundle. Keep this file free of other
 * exports (policy overview: `workspace-shell/viewers/warmupDesktopViewerChunks.ts`).
 */
export { default as DjvuBanner } from '@app/modules/djvu-viewer/components/DjvuBanner.vue';
