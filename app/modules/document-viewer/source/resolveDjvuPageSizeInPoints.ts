import { DEFAULT_DJVU_SOURCE_DPI } from '@contracts/djvuConversionPolicy';
import { PDF_POINTS_PER_INCH } from '@pdf-core/imageExportResolution';

interface IDjvuPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

export function resolveDjvuPageSizeInPoints(size: IDjvuPageSize) {
    const dpi = typeof size.dpi === 'number' && Number.isFinite(size.dpi) && size.dpi > 0
        ? size.dpi
        : DEFAULT_DJVU_SOURCE_DPI;
    return {
        widthPoints: size.width * PDF_POINTS_PER_INCH / dpi,
        heightPoints: size.height * PDF_POINTS_PER_INCH / dpi,
    };
}
