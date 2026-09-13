export async function settleDocumentOpeningGeometryPrewarmTask<TGeometry>(
    geometryTask: Promise<TGeometry | null>,
    settleTimeoutMs?: number,
) {
    if (!settleTimeoutMs || settleTimeoutMs <= 0) {
        return {
            geometry: await geometryTask,
            timedOut: false,
        };
    }

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const geometry = await Promise.race([
        geometryTask,
        new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => {
                timedOut = true;
                resolve(null);
            }, settleTimeoutMs);
        }),
    ]);
    if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
    }
    return {
        geometry,
        timedOut,
    };
}
