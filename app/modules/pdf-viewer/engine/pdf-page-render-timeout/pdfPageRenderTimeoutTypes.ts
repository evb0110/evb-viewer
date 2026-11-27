import type {TPageNumber} from '@contracts/pageNumbers';

export type TPageRenderStallStage =
    'page-load' | 'canvas-prepare' | 'canvas-render' | 'text-layer' | 'annotation-layer' | 'annotation-editor-layer';

export interface IPageRenderStallPayload {
    pageNumber: TPageNumber;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}

export interface IPageRenderTimeoutError extends Error {
    pageNumber: TPageNumber;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}
