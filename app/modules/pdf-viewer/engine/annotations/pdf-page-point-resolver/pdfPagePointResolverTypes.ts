import type {TPageNumber} from '@contracts/pageNumbers';

export interface IPageCandidateLogEntry {
    pageNumber: TPageNumber | null;
    inside: boolean;
    distanceSquared: number;
    rect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
}

export interface IGeometryResolution {
    pageContainer: HTMLElement | null;
    source: 'inside' | 'nearest' | 'none';
    candidates: IPageCandidateLogEntry[] | null;
}

export interface IPagePointResolutionSelection {
    pageContainer: HTMLElement | null;
    selectedSource: string;
    targetConflictsWithElementPoint: boolean;
    targetConflictsWithGeometry: boolean;
    hasTargetConflict: boolean;
}
