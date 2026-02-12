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
            x: Math.min(Math.max(margin, x), maxX),
            y: Math.min(Math.max(margin, y), maxY),
        };
    }

    return { clampToViewport };
};
