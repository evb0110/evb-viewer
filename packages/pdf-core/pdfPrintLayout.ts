import {
    degrees,
    PDFArray,
    PDFDocument,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFStream,
    concatTransformationMatrix,
    drawObject,
    popGraphicsState,
    pushGraphicsState,
    rectangle,
    clip,
} from 'pdf-lib';
import type {
    PDFEmbeddedPage,
    PDFPage,
    PageBoundingBox,
} from 'pdf-lib';
import { uniq } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import {
    parsePageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { IPdfPageBox } from '@pdf-core/pdfPageBoxes';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core/pdfPageBoxes';

// Removal condition: pdf-page-ops gains an N-source Form XObject composition
// operation that preserves the print layout behavior covered by this module.

export interface IBuildPrintablePdfDataOptions {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export interface IPrintablePageMetric {
    width: number;
    height: number;
}

interface IPrintEmbeddedPage {
    pageNumber: number;
    width: number;
    height: number;
    displayWidth: number;
    displayHeight: number;
    rotation: TPdfPageRotation;
    embeddedPage: PDFEmbeddedPage;
}

type TPdfPageRotation = 0 | 90 | 180 | 270;

interface IPreferredSinglePagePrintSheet {
    key: 'a4' | 'letter';
    width: number;
    height: number;
    fitScale: number;
    aspectDelta: number;
}

const SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD = 0.97;
const SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD = 0.1;
const SINGLE_PAGE_PRINT_SAFE_MARGIN_PT = 0;
const STANDARD_SINGLE_PAGE_PRINT_SHEETS = [
    {
        key: 'a4' as const,
        width: 595.28,
        height: 841.89,
    },
    {
        key: 'letter' as const,
        width: 612,
        height: 792,
    },
] as const;

function normalizeTotalPages(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

function buildAllPageNumbers(totalPages: number) {
    return range(1, totalPages + 1).map(pageNumber => requirePageNumber(pageNumber, totalPages));
}

export function normalizePrintPageNumbers(
    pageNumbers: number[] | undefined,
    totalPages: number,
) {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    if (normalizedTotalPages <= 0) {
        return [];
    }

    if (!pageNumbers || pageNumbers.length === 0) {
        return buildAllPageNumbers(normalizedTotalPages);
    }

    return uniq(pageNumbers)
        .flatMap((page) => {
            const pageNumber = parsePageNumber(page, normalizedTotalPages);
            return pageNumber === null ? [] : [pageNumber];
        })
        .sort((left, right) => left - right);
}

function resolvePdfLibPageViewBox(page: PDFPage): IPdfPageBox {
    const mediaBox = resolvePdfLibMediaBox(page);
    return resolvePdfLibCropBox(page, mediaBox) ?? mediaBox;
}

function resolvePdfNumber(value: PDFNumber | undefined, fallback: number) {
    return value?.asNumber() ?? fallback;
}

function resolveAppearanceStream(
    annotation: PDFDict,
) {
    const appearance = annotation.lookupMaybe(PDFName.of('AP'), PDFDict);
    const normalAppearance = appearance?.lookup(PDFName.of('N'));

    if (normalAppearance instanceof PDFStream) {
        return normalAppearance;
    }

    if (!(normalAppearance instanceof PDFDict)) {
        return undefined;
    }

    const state = annotation.lookupMaybe(PDFName.of('AS'), PDFName);
    if (state) {
        const stateAppearance = normalAppearance.lookup(state);
        if (stateAppearance instanceof PDFStream) {
            return stateAppearance;
        }

        return undefined;
    }

    return undefined;
}

function flattenPrintableAnnotationAppearances(
    sourcePdf: PDFDocument,
    pageNumbers: number[],
) {
    const flagsName = PDFName.of('F');
    const annotsName = PDFName.of('Annots');
    const bboxName = PDFName.of('BBox');
    const matrixName = PDFName.of('Matrix');

    for (const pageNumber of pageNumbers) {
        const page = sourcePdf.getPage(pageNumber - 1);
        const visibleBox = resolvePdfLibPageViewBox(page);
        const annotations = page.node.Annots();
        if (!annotations) {
            continue;
        }

        for (let index = 0; index < annotations.size(); index += 1) {
            const annotation = annotations.lookup(index, PDFDict);
            const flags = annotation.lookupMaybe(flagsName, PDFNumber)?.asNumber() ?? 0;
            const isPrintable = (flags & 4) !== 0 && (flags & (1 | 2 | 32)) === 0;
            if (!isPrintable) {
                continue;
            }

            const appearance = resolveAppearanceStream(annotation);
            if (!appearance) {
                throw new Error(`Printable annotation on page ${pageNumber} has no normal appearance`);
            }

            const bboxArray = appearance.dict.lookupMaybe(bboxName, PDFArray);
            const bboxValues = bboxArray
                ? [
                    0,
                    1,
                    2,
                    3,
                ].map(index => bboxArray.lookupMaybe(index, PDFNumber))
                : [];
            if (bboxValues.length !== 4 || bboxValues.some(value => !value)) {
                throw new Error(`Printable annotation on page ${pageNumber} has an invalid appearance BBox`);
            }

            const rect = annotation.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asRectangle();
            if (!rect) {
                throw new Error(`Printable annotation on page ${pageNumber} has an invalid Rect`);
            }
            const bboxLeft = bboxValues[0]!.asNumber();
            const bboxBottom = bboxValues[1]!.asNumber();
            const bboxRight = bboxValues[2]!.asNumber();
            const bboxTop = bboxValues[3]!.asNumber();
            const matrixArray = appearance.dict.lookupMaybe(matrixName, PDFArray);
            const matrixValues = matrixArray
                ? [
                    0,
                    1,
                    2,
                    3,
                    4,
                    5,
                ].map(index => matrixArray.lookupMaybe(index, PDFNumber))
                : [];
            const matrix = [
                1,
                0,
                0,
                1,
                0,
                0,
            ].map((fallback, matrixIndex) => resolvePdfNumber(matrixValues[matrixIndex], fallback));
            const a = matrix[0]!;
            const b = matrix[1]!;
            const c = matrix[2]!;
            const d = matrix[3]!;
            const e = matrix[4]!;
            const f = matrix[5]!;
            const appearanceCorners: Array<[number, number]> = [
                [
                    bboxLeft,
                    bboxBottom,
                ],
                [
                    bboxLeft,
                    bboxTop,
                ],
                [
                    bboxRight,
                    bboxBottom,
                ],
                [
                    bboxRight,
                    bboxTop,
                ],
            ];
            const transformedCorners = appearanceCorners.map(([
                x,
                y,
            ]): [number, number] => [
                a * x + c * y + e,
                b * x + d * y + f,
            ]);
            const transformedLeft = Math.min(...transformedCorners.map(([x]) => x));
            const transformedBottom = Math.min(...transformedCorners.map(([
                , y,
            ]) => y));
            const transformedRight = Math.max(...transformedCorners.map(([x]) => x));
            const transformedTop = Math.max(...transformedCorners.map(([
                , y,
            ]) => y));
            const transformedWidth = transformedRight - transformedLeft;
            const transformedHeight = transformedTop - transformedBottom;
            if (!(transformedWidth > 0) || !(transformedHeight > 0)) {
                throw new Error(`Printable annotation on page ${pageNumber} has a degenerate appearance BBox`);
            }

            const appearanceKey = page.node.newXObjectKey('PrintAnnot');
            const appearanceRef = sourcePdf.context.getObjectRef(appearance) ?? sourcePdf.context.register(appearance);
            page.node.setXObject(appearanceKey, appearanceRef);
            page.pushOperators(
                pushGraphicsState(),
                rectangle(
                    rect.x - visibleBox.x,
                    rect.y - visibleBox.y,
                    rect.width,
                    rect.height,
                ),
                clip(),
                concatTransformationMatrix(
                    rect.width / transformedWidth * a,
                    rect.width / transformedWidth * b,
                    rect.height / transformedHeight * c,
                    rect.height / transformedHeight * d,
                    rect.x - visibleBox.x + rect.width / transformedWidth * (e - transformedLeft),
                    rect.y - visibleBox.y + rect.height / transformedHeight * (f - transformedBottom),
                ),
                drawObject(appearanceKey),
                popGraphicsState(),
            );
        }

        page.node.delete(annotsName);
    }
}

function toPageBoundingBox(box: IPdfPageBox): PageBoundingBox {
    return {
        left: box.x,
        bottom: box.y,
        right: box.x + box.width,
        top: box.y + box.height,
    };
}

function normalizePdfPageRotation(angle: number): TPdfPageRotation {
    const normalizedAngle = ((angle % 360) + 360) % 360;

    if (normalizedAngle === 90 || normalizedAngle === 180 || normalizedAngle === 270) {
        return normalizedAngle;
    }

    return 0;
}

function resolveDisplayedPageDimensions(
    width: number,
    height: number,
    rotation: TPdfPageRotation,
) {
    return rotation === 90 || rotation === 270
        ? {
            width: height,
            height: width,
        }
        : {
            width,
            height,
        };
}

export function buildPrintSpreadGroups(
    pageNumbers: number[],
    viewMode: TPdfViewMode,
) {
    const normalizedPages = uniq(pageNumbers)
        .filter(page => Number.isInteger(page) && page >= 1)
        .sort((left, right) => left - right);

    if (normalizedPages.length === 0) {
        return [];
    }

    if (viewMode === 'single') {
        return normalizedPages.map(pageNumber => [pageNumber]);
    }

    const groups: number[][] = [];
    let index = 0;

    if (viewMode === 'facing-first-single') {
        groups.push([normalizedPages[0]!]);
        index = 1;
    }

    while (index < normalizedPages.length) {
        const currentPage = normalizedPages[index]!;
        const nextPage = normalizedPages[index + 1];

        if (typeof nextPage === 'number') {
            groups.push([
                currentPage,
                nextPage,
            ]);
            index += 2;
            continue;
        }

        groups.push([currentPage]);
        index += 1;
    }

    return groups;
}

export function canPrintSourcePdfDirectly(
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
    return options.viewMode === 'single'
        && options.orientation === 'auto'
        && (!options.pageNumbers || options.pageNumbers.length === 0);
}

function buildSpreadSlots(
    groups: number[][],
    embeddedPagesByNumber: Map<number, IPrintEmbeddedPage>,
    viewMode: TPdfViewMode,
) {
    return groups.map((group, groupIndex) => {
        const pages = group.map((pageNumber) => {
            const embeddedPage = embeddedPagesByNumber.get(pageNumber);
            if (!embeddedPage) {
                throw new Error(`Missing printable page ${pageNumber}`);
            }
            return embeddedPage;
        });

        if (viewMode === 'single' || pages.length > 1) {
            return pages;
        }

        const page = pages[0];
        if (!page) {
            throw new Error('Missing printable spread page');
        }

        return viewMode === 'facing-first-single' && groupIndex === 0
            ? [
                null,
                page,
            ]
            : [
                page,
                null,
            ];
    });
}

function resolvePreferredSinglePagePrintSheet(
    naturalWidth: number,
    naturalHeight: number,
    orientation: TPrintOrientation = 'auto',
): IPreferredSinglePagePrintSheet {
    const isLandscape = orientation === 'landscape'
        ? true
        : orientation === 'portrait'
            ? false
            : naturalWidth > naturalHeight;
    const pageAspect = Math.max(naturalWidth, naturalHeight) / Math.max(1, Math.min(naturalWidth, naturalHeight));

    let bestSheet: IPreferredSinglePagePrintSheet | null = null;

    for (const candidate of STANDARD_SINGLE_PAGE_PRINT_SHEETS) {
        const candidateWidth = isLandscape ? candidate.height : candidate.width;
        const candidateHeight = isLandscape ? candidate.width : candidate.height;
        const fitScale = Math.min(
            candidateWidth / Math.max(1, naturalWidth),
            candidateHeight / Math.max(1, naturalHeight),
        );
        const candidateAspect = Math.max(candidateWidth, candidateHeight) / Math.max(1, Math.min(candidateWidth, candidateHeight));
        const aspectDelta = Math.abs(candidateAspect - pageAspect);

        if (!bestSheet) {
            bestSheet = {
                key: candidate.key,
                width: candidateWidth,
                height: candidateHeight,
                fitScale,
                aspectDelta,
            };
            continue;
        }

        if (
            fitScale > bestSheet.fitScale + 0.0001
            || (
                Math.abs(fitScale - bestSheet.fitScale) <= 0.0001
                && aspectDelta < bestSheet.aspectDelta
            )
        ) {
            bestSheet = {
                key: candidate.key,
                width: candidateWidth,
                height: candidateHeight,
                fitScale,
                aspectDelta,
            };
        }
    }

    if (!bestSheet) {
        throw new Error('Missing standard print sheet');
    }

    return bestSheet;
}

function shouldNormalizeSinglePageForPrint(sheet: IPreferredSinglePagePrintSheet) {
    return sheet.fitScale < SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD
        || sheet.aspectDelta > SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD;
}

function resolveDefaultA4PrintSheet(
    naturalWidth: number,
    naturalHeight: number,
    orientation: TPrintOrientation = 'auto',
) {
    const a4Sheet = STANDARD_SINGLE_PAGE_PRINT_SHEETS[0];
    const isLandscape = orientation === 'landscape'
        ? true
        : orientation === 'portrait'
            ? false
            : naturalWidth > naturalHeight;

    return {
        width: isLandscape ? a4Sheet.height : a4Sheet.width,
        height: isLandscape ? a4Sheet.width : a4Sheet.height,
    };
}

async function embedPrintablePages(
    targetPdf: PDFDocument,
    sourcePdf: PDFDocument,
    pageNumbers: number[],
) {
    // Keep pdf-lib until pdf-page-ops can embed arbitrary source pages as
    // reusable Form XObjects for print imposition.
    const sourcePages = pageNumbers.map(pageNumber => sourcePdf.getPage(pageNumber - 1));
    const blankContentsRef = sourcePdf.context.register(
        sourcePdf.context.flateStream(new Uint8Array()),
    );

    for (const sourcePage of sourcePages) {
        // pdf-lib cannot embed a valid blank page without a Contents entry.
        // The source document is detached in memory, so this stays print-only.
        if (!sourcePage.node.get(PDFName.of('Contents'))) {
            sourcePage.node.set(PDFName.of('Contents'), blankContentsRef);
        }
    }

    const visibleBoxes = sourcePages.map(resolvePdfLibPageViewBox);
    const rotations = sourcePages.map(sourcePage => normalizePdfPageRotation(sourcePage.getRotation().angle));
    const embeddedPages = await targetPdf.embedPages(
        sourcePages,
        visibleBoxes.map(toPageBoundingBox),
    );

    return embeddedPages.map((embeddedPage, index) => {
        const pageNumber = pageNumbers[index];
        if (!pageNumber) {
            throw new Error('Unable to prepare printable page');
        }

        const visibleBox = visibleBoxes[index]!;
        const rotation = rotations[index]!;
        const displayedDimensions = resolveDisplayedPageDimensions(
            visibleBox.width,
            visibleBox.height,
            rotation,
        );

        return {
            pageNumber,
            width: visibleBox.width,
            height: visibleBox.height,
            displayWidth: displayedDimensions.width,
            displayHeight: displayedDimensions.height,
            rotation,
            embeddedPage,
        };
    });
}

function drawEmbeddedPrintablePage(
    targetPage: PDFPage,
    page: IPrintEmbeddedPage,
    x: number,
    y: number,
    scale: number,
) {
    const width = page.width * scale;
    const height = page.height * scale;
    let drawX = x;
    let drawY = y;
    let drawRotation = 0;

    // PDF /Rotate is clockwise, while drawPage rotates counterclockwise.
    switch (page.rotation) {
        case 0:
            break;
        case 90:
            drawY += width;
            drawRotation = -90;
            break;
        case 180:
            drawX += width;
            drawY += height;
            drawRotation = 180;
            break;
        case 270:
            drawX += height;
            drawRotation = 90;
            break;
    }

    targetPage.drawPage(page.embeddedPage, {
        x: drawX,
        y: drawY,
        width,
        height,
        rotate: degrees(drawRotation),
    });
}

async function buildPaperFittedSinglePagePdf(
    targetPdf: PDFDocument,
    sourcePdf: PDFDocument,
    pageNumbers: number[],
    orientation: TPrintOrientation,
) {
    const embeddedPages = await embedPrintablePages(targetPdf, sourcePdf, pageNumbers);

    for (let index = 0; index < pageNumbers.length; index += 1) {
        const embeddedPage = embeddedPages[index];
        const pageNumber = pageNumbers[index];
        if (!embeddedPage || typeof pageNumber !== 'number') {
            throw new Error('Unable to prepare printable page');
        }

        const preferredSheet = resolveDefaultA4PrintSheet(
            embeddedPage.displayWidth,
            embeddedPage.displayHeight,
            orientation,
        );
        const availableWidth = Math.max(
            1,
            preferredSheet.width - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const availableHeight = Math.max(
            1,
            preferredSheet.height - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const drawScale = Math.min(
            availableWidth / Math.max(1, embeddedPage.displayWidth),
            availableHeight / Math.max(1, embeddedPage.displayHeight),
        );
        const targetPage = targetPdf.addPage([
            preferredSheet.width,
            preferredSheet.height,
        ]);
        const drawWidth = embeddedPage.displayWidth * drawScale;
        const drawHeight = embeddedPage.displayHeight * drawScale;
        drawEmbeddedPrintablePage(
            targetPage,
            embeddedPage,
            (preferredSheet.width - drawWidth) / 2,
            (preferredSheet.height - drawHeight) / 2,
            drawScale,
        );
    }
}

function shouldNormalizeSinglePagePdfForPrint(
    sourcePdf: PDFDocument,
    normalizedPageNumbers: number[],
) {
    return normalizedPageNumbers.some((pageNumber) => {
        const sourcePage = sourcePdf.getPage(pageNumber - 1);
        const {
            width,
            height,
        } = resolvePdfLibPageViewBox(sourcePage);
        const rotation = normalizePdfPageRotation(sourcePage.getRotation().angle);
        const displayedDimensions = resolveDisplayedPageDimensions(width, height, rotation);
        return shouldNormalizeSinglePageForPrint(
            resolvePreferredSinglePagePrintSheet(
                displayedDimensions.width,
                displayedDimensions.height,
            ),
        );
    });
}

export async function shouldPrintSourcePdfDirectly(
    sourcePdfData: Uint8Array,
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
    if (!canPrintSourcePdfDirectly(options)) {
        return false;
    }

    const sourcePdf = await PDFDocument.load(sourcePdfData, { updateMetadata: false });
    const normalizedPageNumbers = normalizePrintPageNumbers(options.pageNumbers, sourcePdf.getPageCount());
    if (normalizedPageNumbers.length === 0) {
        return false;
    }

    return !shouldNormalizeSinglePagePdfForPrint(sourcePdf, normalizedPageNumbers);
}

export function shouldPrintPageMetricsDirectly(
    pageMetrics: readonly IPrintablePageMetric[],
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
    if (!canPrintSourcePdfDirectly(options)) {
        return false;
    }

    if (pageMetrics.length === 0) {
        return null;
    }

    return !pageMetrics.some(metric => shouldNormalizeSinglePageForPrint(
        resolvePreferredSinglePagePrintSheet(metric.width, metric.height),
    ));
}

export async function buildPrintablePdfData(
    sourcePdfData: Uint8Array,
    options: IBuildPrintablePdfDataOptions,
) {
    const sourcePdf = await PDFDocument.load(sourcePdfData, { updateMetadata: false });
    const totalPages = sourcePdf.getPageCount();
    const normalizedPageNumbers = normalizePrintPageNumbers(options.pageNumbers, totalPages);

    if (normalizedPageNumbers.length === 0) {
        return null;
    }

    flattenPrintableAnnotationAppearances(sourcePdf, normalizedPageNumbers);

    if (options.viewMode === 'single') {
        const targetPdf = await PDFDocument.create();
        await buildPaperFittedSinglePagePdf(
            targetPdf,
            sourcePdf,
            normalizedPageNumbers,
            options.orientation,
        );
        return targetPdf.save();
    }

    const targetPdf = await PDFDocument.create();
    const embeddedPages = await embedPrintablePages(targetPdf, sourcePdf, normalizedPageNumbers);
    const embeddedPagesByNumber = new Map<number, IPrintEmbeddedPage>();

    for (let index = 0; index < normalizedPageNumbers.length; index += 1) {
        const pageNumber = normalizedPageNumbers[index]!;
        const embeddedPage = embeddedPages[index];
        if (!embeddedPage) {
            throw new Error(`Unable to embed page ${pageNumber} for printing`);
        }

        embeddedPagesByNumber.set(pageNumber, embeddedPage);
    }

    const spreadGroups = buildPrintSpreadGroups(normalizedPageNumbers, options.viewMode);
    const spreads = buildSpreadSlots(
        spreadGroups,
        embeddedPagesByNumber,
        options.viewMode,
    );

    for (const spread of spreads) {
        const visiblePages = spread.filter(page => page !== null);
        const blankSlotWidth = visiblePages[0]?.displayWidth ?? 1;
        const slotWidths = spread.map(page => page?.displayWidth ?? blankSlotWidth);
        const naturalWidth = slotWidths.reduce((total, width) => total + width, 0);
        const naturalHeight = Math.max(...visiblePages.map(page => page.displayHeight));
        const preferredSheet = resolveDefaultA4PrintSheet(
            naturalWidth,
            naturalHeight,
            options.orientation === 'auto' ? 'landscape' : options.orientation,
        );
        const {
            width: pageWidth,
            height: pageHeight,
        } = preferredSheet;
        const targetPage = targetPdf.addPage([
            pageWidth,
            pageHeight,
        ]);
        const availableWidth = Math.max(1, pageWidth - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2);
        const availableHeight = Math.max(1, pageHeight - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2);
        const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
        const leftInset = (pageWidth - naturalWidth * scale) / 2;
        const topInset = (pageHeight - naturalHeight * scale) / 2;
        let cursorX = leftInset;

        for (let slotIndex = 0; slotIndex < spread.length; slotIndex += 1) {
            const page = spread[slotIndex];
            const slotWidth = slotWidths[slotIndex]! * scale;
            if (page) {
                const drawHeight = page.displayHeight * scale;
                drawEmbeddedPrintablePage(
                    targetPage,
                    page,
                    cursorX,
                    pageHeight - topInset - drawHeight,
                    scale,
                );
            }
            cursorX += slotWidth;
        }
    }

    return targetPdf.save();
}
