interface IVirtualRowRevealOptions {
    readonly rowHeights: readonly number[];
    readonly startIndex: number;
    readonly endIndex: number;
    readonly scrollTop: number;
    readonly clientHeight: number;
}

function sumRowHeights(rowHeights: readonly number[], endIndex: number) {
    let total = 0;
    for (let index = 0; index < endIndex; index += 1) {
        total += Math.max(0, rowHeights[index] ?? 0);
    }
    return total;
}

/** Returns the nearest scroll offset that fully exposes a logical virtual-row span. */
export function resolveVirtualRowRevealScrollTop(options: IVirtualRowRevealOptions) {
    if (options.rowHeights.length === 0) {
        return null;
    }
    const startIndex = Math.max(0, Math.min(
        options.startIndex,
        options.endIndex,
        options.rowHeights.length - 1,
    ));
    const endIndex = Math.max(startIndex, Math.min(
        Math.max(options.startIndex, options.endIndex),
        options.rowHeights.length - 1,
    ));
    const spanTop = sumRowHeights(options.rowHeights, startIndex);
    const spanBottom = sumRowHeights(options.rowHeights, endIndex + 1);
    const scrollTop = Math.max(0, options.scrollTop);
    const viewportBottom = scrollTop + Math.max(0, options.clientHeight);

    if (spanTop >= scrollTop && spanBottom <= viewportBottom) {
        return null;
    }
    if (spanBottom - spanTop > options.clientHeight || spanTop < scrollTop) {
        return spanTop;
    }
    return Math.max(0, spanBottom - options.clientHeight);
}
