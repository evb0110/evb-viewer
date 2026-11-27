import { clamp } from 'es-toolkit/math';

export function clampToViewport(
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

export function clampElementToViewport(
    x: number,
    y: number,
    menuElement: HTMLElement | null,
    fallbackWidth: number,
    fallbackHeight: number,
    margin = 8,
) {
    return clampToViewport(
        x,
        y,
        menuElement?.offsetWidth ?? fallbackWidth,
        menuElement?.offsetHeight ?? fallbackHeight,
        margin,
    );
}
