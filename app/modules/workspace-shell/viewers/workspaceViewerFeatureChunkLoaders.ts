export type TWorkspaceViewerFeatureChunkTarget =
    | 'pdfjs'
    | 'page-source';

export type TWorkspaceViewerChunkLoader = () => Promise<unknown>;

/** Async boundaries mounted inside DocumentViewerChassis. */
export const workspaceViewerFeatureChunkLoaders = {
    pdfjs: () => import('@app/modules/pdf-viewer/public/component-exports/pdfViewer'),
    'page-source': () => import('@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue'),
} satisfies Record<TWorkspaceViewerFeatureChunkTarget, TWorkspaceViewerChunkLoader>;
