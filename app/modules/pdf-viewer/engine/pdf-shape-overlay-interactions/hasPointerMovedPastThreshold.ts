interface IPointerMoveLike {
    clientX: number;
    clientY: number;
}

export function hasPointerMovedPastThreshold(origin: IPointerMoveLike, next: IPointerMoveLike, thresholdPx = 4) {
    return Math.hypot(next.clientX - origin.clientX, next.clientY - origin.clientY) >= thresholdPx;
}
