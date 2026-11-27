export interface IPdfTextPreviewItem {
    str?: string | null | undefined;
    transform?: number[] | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
    hasEOL?: boolean | null | undefined;
}

export interface IPdfTextPreviewViewport {
    transform: number[];
    width: number;
    height: number;
    scale?: number | null | undefined;
}
