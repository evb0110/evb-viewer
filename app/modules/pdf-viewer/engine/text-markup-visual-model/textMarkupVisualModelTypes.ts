

export interface ITextMarkupRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface ITextMarkupLivePath {
    d: string;
    strokeWidthPdfUnits: number;
}

export interface ITextMarkupLiveVisualPlan {
    paths: ITextMarkupLivePath[];
    viewBox: string;
}
