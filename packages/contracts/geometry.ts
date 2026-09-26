export interface IPoint2D {
    x: number;
    y: number;
}

export interface IMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type {
    IPageGeometry, IPdfBox,
} from '@contracts/decodePageGeometry';
