interface IDjvuPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

const POINTS_PER_INCH = 72;

export function resolveDjvuPageSizeInPoints(size: IDjvuPageSize) {
    const dpi = typeof size.dpi === 'number' && Number.isFinite(size.dpi) && size.dpi > 0
        ? size.dpi
        : 300;
    return {
        widthPoints: size.width * POINTS_PER_INCH / dpi,
        heightPoints: size.height * POINTS_PER_INCH / dpi,
    };
}
