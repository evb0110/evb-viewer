import { clamp } from 'es-toolkit/math';

export const useContextMenuPosition = () => {
    function clampToViewport(
        x: number,
        y: number,
        menuWidth: number,
        menuHeight: number,
        margin = 8,
    ) {
        const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
        const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);
        return {
            x: clamp(x, margin, maxX),
            y: clamp(y, margin, maxY),
        };
    }

    return { clampToViewport };
};
