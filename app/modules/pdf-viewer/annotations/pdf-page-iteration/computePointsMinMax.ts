

export function computePointsMinMax(points: ReadonlyArray<{
    x: number;
    y: number;
}>) {
    const first = points[0];
    if (!first) {
        return null;
    }

    let minX = first.x;
    let minY = first.y;
    let maxX = first.x;
    let maxY = first.y;
    for (let index = 1; index < points.length; index += 1) {
        const point = points[index]!;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }
    return {
        minX,
        minY,
        maxX,
        maxY,
    };
}
