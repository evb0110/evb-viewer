export interface IImagePlacementDimensions {
    width: number;
    height: number;
}

export interface IImagePlacementContainerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IImagePlacementRectPx {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type TImagePlacementResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
