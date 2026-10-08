/**
 * Poppler renders one inclusive page range per process, so a staged window
 * that skips already-ready pages (or leads with the requested page out of
 * order) must be split into sorted, gap-free runs before batching. One process
 * also renders at one DPI, so pages whose `runKey` differs start a new run.
 */
export function splitContiguousPageRuns(
    pageNumbers: readonly number[],
    runKey: (pageNumber: number) => number = () => 0,
): number[][] {
    const sorted = [...new Set(pageNumbers)].sort((left, right) => left - right);
    const runs: number[][] = [];
    for (const pageNumber of sorted) {
        const current = runs.at(-1);
        if (
            current !== undefined
            && pageNumber === current.at(-1)! + 1
            && runKey(pageNumber) === runKey(current[0]!)
        ) {
            current.push(pageNumber);
        } else {
            runs.push([pageNumber]);
        }
    }
    return runs;
}
