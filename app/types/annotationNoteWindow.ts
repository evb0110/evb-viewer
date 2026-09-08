import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface IAnnotationNoteWindowState {
    annotationId: string;
    draftText: string;
    minimized: boolean;
    position: IAnnotationNotePosition;
}

/** UI-only projection; semantic annotation data remains in AnnotationStore. */
export interface IAnnotationNoteWindowViewModel extends IAnnotationNoteWindowState {
    pageIndex: number;
    pageNumber: number;
    author: string | null;
    color?: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    markerRect: IAnnotationMarkerRect | null;
    subtype: string | null;
    source: 'pdf' | 'editor' | 'shape';
    hasNote: boolean;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    order: number;
    pendingEmbeddedSave: boolean;
    isMinimized: boolean;
    createdAtMs: number;
}
