import {
    type TWorkspaceViewerChunkLoader,
    type TWorkspaceViewerFeatureChunkTarget,
    workspaceViewerFeatureChunkLoaders,
} from '@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders';

export type { TWorkspaceViewerChunkLoader } from '@app/modules/workspace-shell/viewers/workspaceViewerFeatureChunkLoaders';

export type TWorkspaceViewerChunkTarget = 'chassis' | TWorkspaceViewerFeatureChunkTarget;
export type TWorkspaceViewerChunkLoaders = Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>;

/**
 * Canonical async boundaries for the workspace viewer stack.
 *
 * Both the components that cross these boundaries and the desktop warmup policy use
 * these exact functions. Keeping the imports here prevents a warmup from successfully
 * fetching a sibling chunk while the first document open still has to discover and
 * parse the component it actually mounts.
 */
export const workspaceViewerChunkLoaders = {
    chassis: () => import('@app/modules/workspace-shell/components/DocumentViewerChassis.vue'),
    ...workspaceViewerFeatureChunkLoaders,
} satisfies Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>;

export const PDF_WORKSPACE_VIEWER_CHUNK_TARGETS = [
    'chassis',
    'pdfjs',
] as const satisfies readonly TWorkspaceViewerChunkTarget[];

export const DJVU_WORKSPACE_VIEWER_CHUNK_TARGETS = [
    'chassis',
    'page-source',
] as const satisfies readonly TWorkspaceViewerChunkTarget[];

export const ALL_WORKSPACE_VIEWER_CHUNK_TARGETS = [
    'chassis',
    'pdfjs',
    'page-source',
] as const satisfies readonly TWorkspaceViewerChunkTarget[];
