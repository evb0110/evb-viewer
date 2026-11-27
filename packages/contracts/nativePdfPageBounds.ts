export interface IPdfNativeNormalizedRectBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IPdfNativeNormalizedBoxBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

function isFiniteUnit(value: number) {
    return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isPdfNativeNormalizedRectInsidePageBounds(rect: IPdfNativeNormalizedRectBounds) {
    return (
        isFiniteUnit(rect.left) &&
        isFiniteUnit(rect.top) &&
        isFiniteUnit(rect.width) &&
        isFiniteUnit(rect.height) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left + rect.width <= 1 &&
        rect.top + rect.height <= 1
    );
}

export function isPdfNativeNormalizedBoxInsidePageBounds(box: IPdfNativeNormalizedBoxBounds) {
    return isPdfNativeNormalizedRectInsidePageBounds({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
    });
}
