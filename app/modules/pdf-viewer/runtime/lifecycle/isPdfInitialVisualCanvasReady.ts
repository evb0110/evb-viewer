import type {TPageNumber} from '@contracts/pageNumbers';

export const isPdfInitialVisualCanvasReady = (container: HTMLElement | null, pageNumber: TPageNumber, currentPage: number): boolean => {
    if (!container || pageNumber !== currentPage) {
        return false;
    }

    const canvas = container.querySelector<HTMLCanvasElement>(`.page_container[data-page="${pageNumber}"] .page_canvas canvas`);
    if (!canvas?.isConnected || canvas.width <= 0 || canvas.height <= 0) {
        return false;
    }

    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return (
        canvasRect.width > 0 &&
        canvasRect.height > 0 &&
        canvasRect.bottom > containerRect.top &&
        canvasRect.top < containerRect.bottom &&
        canvasRect.right > containerRect.left &&
        canvasRect.left < containerRect.right
    );
};
