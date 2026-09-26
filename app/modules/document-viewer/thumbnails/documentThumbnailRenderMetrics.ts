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

const DEFAULT_THUMBNAIL_RASTER_WIDTH_BUCKET = 32;

function parseCssPixelValue(value: string) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function resolveHorizontalInset(style: IThumbnailStyleLike, ...properties: string[]) {
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

export function resolveThumbnailOutputScale(devicePixelRatio: number, maxOutputScale = 2) {
    return Math.min(
        Math.max(1, maxOutputScale),
        Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
    );
}
