import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import {
    capturePdfRegionAsPngBlob,
    findPdfPageContainer,
    pdfViewerDomSelectors, 
} from '@app/modules/pdf-viewer/public';
import {
    getRectHeight, getRectWidth , toClientRect,  
} from '@app/modules/document-viewer/public';
import type { IClientRect } from '@app/modules/document-viewer/public';
import type { IWorkspacePdfViewerAgentPageImageCapturePort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    getAgentNumberInput,
    getAgentStringInput,
    hasAgentInputKey,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import { getAgentOptionalPageNumberInput } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';
import { isOneOf } from '@contracts/runtimeGuards';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

const AGENT_PAGE_IMAGE_REGIONS = [
    'full',
    'top',
    'bottom',
    'left',
    'right',
    'center',
] as const;

const AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS = 3_000;
const AGENT_PAGE_IMAGE_RENDER_POLL_MS = 50;

interface ICreateDocumentAgentPageImageCaptureOptions {
    currentPage: Ref<number>;
    handleGoToPage: (page: number) => void;
    pdfViewerRef: Ref<IWorkspacePdfViewerAgentPageImageCapturePort | null>;
    totalPages: Ref<number>;
}

function isAgentPageImageRegion(value: unknown): value is typeof AGENT_PAGE_IMAGE_REGIONS[number] {
    return isOneOf(AGENT_PAGE_IMAGE_REGIONS, value);
}

function normalizeAgentUnit(value: number | null | undefined, fallback: number) {
    const normalizedValue = typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
    return Math.min(1, Math.max(0, normalizedValue));
}

function normalizeAgentPositiveUnit(value: number | null | undefined, fallback: number) {
    const normalizedValue = normalizeAgentUnit(value, fallback);
    return normalizedValue > 0 ? normalizedValue : fallback;
}

function getAgentPageImageSelection(input: Record<string, unknown>, pageRect: IClientRect) {
    const pageWidth = getRectWidth(pageRect);
    const pageHeight = getRectHeight(pageRect);
    const hasExplicitCrop = [
        'x',
        'y',
        'width',
        'height',
    ].some(key => hasAgentInputKey(input, key));

    if (hasExplicitCrop) {
        const x = normalizeAgentUnit(getAgentNumberInput(input, 'x'), 0);
        const y = normalizeAgentUnit(getAgentNumberInput(input, 'y'), 0);
        const width = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'width'), 1);
        const height = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'height'), 1);
        const right = normalizeAgentUnit(x + width, 1);
        const bottom = normalizeAgentUnit(y + height, 1);
        if (right <= x || bottom <= y) {
            throw new Error('document.capture_page_image crop must have a positive normalized width and height.');
        }
        return {
            left: pageRect.left + x * pageWidth,
            top: pageRect.top + y * pageHeight,
            right: pageRect.left + right * pageWidth,
            bottom: pageRect.top + bottom * pageHeight,
        };
    }

    const region = getAgentStringInput(input, 'region') ?? 'full';
    if (!isAgentPageImageRegion(region)) {
        throw new Error('document.capture_page_image region must be full, top, bottom, left, right, or center.');
    }

    switch (region) {
        case 'top':
            return {
                ...pageRect,
                bottom: pageRect.top + pageHeight * 0.35,
            };
        case 'bottom':
            return {
                ...pageRect,
                top: pageRect.bottom - pageHeight * 0.35,
            };
        case 'left':
            return {
                ...pageRect,
                right: pageRect.left + pageWidth * 0.5,
            };
        case 'right':
            return {
                ...pageRect,
                left: pageRect.right - pageWidth * 0.5,
            };
        case 'center':
            return {
                left: pageRect.left + pageWidth * 0.2,
                top: pageRect.top + pageHeight * 0.2,
                right: pageRect.right - pageWidth * 0.2,
                bottom: pageRect.bottom - pageHeight * 0.2,
            };
        case 'full':
            return pageRect;
    }
}

function findAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: TPageNumber) {
    const pageElement = findPdfPageContainer(viewerContainer, pageNumber);
    const canvas = pageElement?.querySelector<HTMLCanvasElement>(pdfViewerDomSelectors.pageCanvasElement) ?? null;
    if (!pageElement || !canvas || canvas.width <= 0 || canvas.height <= 0) {
        return null;
    }
    return pageElement;
}

async function waitForAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: TPageNumber) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS) {
        const pageElement = findAgentRenderedPageElement(viewerContainer, pageNumber);
        if (pageElement) {
            return pageElement;
        }
        await delay(AGENT_PAGE_IMAGE_RENDER_POLL_MS);
        await nextTick();
    }

    throw new Error(`document.capture_page_image could not find a rendered canvas for page ${pageNumber}.`);
}

function bytesToBase64(bytes: Uint8Array) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function blobToBase64(blob: Blob) {
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function createAgentCaptureRectMetadata(rect: IClientRect, pageRect: IClientRect) {
    const pageWidth = getRectWidth(pageRect);
    const pageHeight = getRectHeight(pageRect);
    return {
        x: pageWidth > 0 ? (rect.left - pageRect.left) / pageWidth : 0,
        y: pageHeight > 0 ? (rect.top - pageRect.top) / pageHeight : 0,
        width: pageWidth > 0 ? getRectWidth(rect) / pageWidth : 0,
        height: pageHeight > 0 ? getRectHeight(rect) / pageHeight : 0,
    };
}

export function createDocumentAgentPageImageCapture(options: ICreateDocumentAgentPageImageCaptureOptions) {
    const {
        currentPage,
        handleGoToPage,
        pdfViewerRef,
        totalPages,
    } = options;

    async function captureAgentPageImage(input: Record<string, unknown>, actionId: string) {
        const pageNumber = requirePageNumber(getAgentOptionalPageNumberInput(
            input,
            totalPages.value,
            currentPage.value,
            actionId,
        ), totalPages.value);
        const viewer = pdfViewerRef.value;
        const viewerContainer = viewer?.getViewerContainer() ?? null;
        if (!viewer || !viewerContainer) {
            throw new Error('document.capture_page_image requires a rendered PDF viewer.');
        }

        handleGoToPage(pageNumber);
        viewer.scrollToPage(pageNumber);
        await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
        await nextTick();

        const pageElement = await waitForAgentRenderedPageElement(viewerContainer, pageNumber);
        const pageRect = toClientRect(pageElement.getBoundingClientRect());
        const selectionRect = getAgentPageImageSelection(input, pageRect);
        const capture = await capturePdfRegionAsPngBlob(viewerContainer, selectionRect);
        if (!capture) {
            throw new Error(`document.capture_page_image could not capture page ${pageNumber}.`);
        }

        return {
            pageNumber,
            crop: createAgentCaptureRectMetadata(capture.outputRect, pageRect),
            image: {
                mimeType: 'image/png',
                sizeBytes: capture.blob.size,
                data: await blobToBase64(capture.blob),
            },
        };
    }

    return { captureAgentPageImage };
}
