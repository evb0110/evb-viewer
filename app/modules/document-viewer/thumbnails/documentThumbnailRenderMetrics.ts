export interface IThumbnailStyleLike {getPropertyValue(property: string): string;}

export interface IResolveThumbnailRenderWidthOptions {
    containerClientWidth: number;
    containerStyle: IThumbnailStyleLike;
    minWidth: number;
    thumbnailStyle: IThumbnailStyleLike | null;
}

export interface IResolveThumbnailItemChromeHeightOptions {
    labelHeight: number;
    thumbnailStyle: IThumbnailStyleLike;
}

export interface IResolveSeededThumbnailMetricsOptions {
    cssWidth: number;
    outputScale: number;
    sourceHeight: number;
    sourceWidth: number;
}

const DEFAULT_THUMBNAIL_RASTER_WIDTH_BUCKET = 32;

export function roundMetric(value: number) {
    return Number(value.toFixed(2));
}

export function parseCssPixelValue(value: string) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveHorizontalInset(style: IThumbnailStyleLike, ...properties: string[]) {
    return properties.reduce((total, property) => {
        const value = style.getPropertyValue(property);
        return total + parseCssPixelValue(value);
    }, 0);
}

export function resolveThumbnailItemChromeHeightFromStyles({
    labelHeight,
    thumbnailStyle,
}: IResolveThumbnailItemChromeHeightOptions) {
    const verticalInset = resolveHorizontalInset(
        thumbnailStyle,
        'padding-top',
        'padding-bottom',
        'border-top-width',
        'border-bottom-width',
    );
    const rowGap = parseCssPixelValue(
        thumbnailStyle.getPropertyValue('row-gap')
        || thumbnailStyle.getPropertyValue('gap'),
    );

    return Math.max(0, verticalInset + rowGap + Math.max(0, labelHeight));
}

export function resolveThumbnailRenderWidthFromStyles({
    containerClientWidth,
    containerStyle,
    minWidth,
    thumbnailStyle,
}: IResolveThumbnailRenderWidthOptions) {
    const containerContentWidth = containerClientWidth - resolveHorizontalInset(
        containerStyle,
        'padding-left',
        'padding-right',
    );
    const thumbnailInset = thumbnailStyle
        ? resolveHorizontalInset(
            thumbnailStyle,
            'padding-left',
            'padding-right',
            'border-left-width',
            'border-right-width',
        )
        : 0;

    return Math.max(minWidth, Math.floor(containerContentWidth - thumbnailInset));
}

export function resolveThumbnailRasterWidth(
    cssWidth: number,
    bucketSize = DEFAULT_THUMBNAIL_RASTER_WIDTH_BUCKET,
) {
    const normalizedBucketSize = Math.max(1, Math.round(bucketSize));
    return Math.max(
        1,
        Math.ceil(Math.max(1, cssWidth) / normalizedBucketSize) * normalizedBucketSize,
    );
}

export function isThumbnailRasterWidthReady(
    cssWidth: number,
    rasterWidth: number,
    bucketSize = DEFAULT_THUMBNAIL_RASTER_WIDTH_BUCKET,
) {
    return rasterWidth >= resolveThumbnailRasterWidth(cssWidth, bucketSize);
}

export function resolveThumbnailOutputScale(devicePixelRatio: number, maxOutputScale = 2) {
    return Math.min(
        Math.max(1, maxOutputScale),
        Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
    );
}

export function resolveSeededThumbnailMetrics({
    cssWidth,
    outputScale,
    sourceHeight,
    sourceWidth,
}: IResolveSeededThumbnailMetricsOptions) {
    const sourceAspectRatio = sourceHeight / sourceWidth;
    if (!Number.isFinite(sourceAspectRatio) || sourceAspectRatio <= 0) {
        return null;
    }

    const normalizedCssWidth = Math.max(1, cssWidth);
    const cssHeight = Math.max(1, normalizedCssWidth * sourceAspectRatio);
    return {
        cssHeight,
        cssWidth: normalizedCssWidth,
        pixelHeight: Math.max(1, Math.round(cssHeight * outputScale)),
        pixelWidth: Math.max(1, Math.round(normalizedCssWidth * outputScale)),
        sourceAspectRatio,
    };
}

export function buildThumbnailRenderTransform(scaleX: number, scaleY: number) {
    return scaleX !== 1 || scaleY !== 1
        ? [
            scaleX,
            0,
            0,
            scaleY,
            0,
            0,
        ]
        : undefined;
}
