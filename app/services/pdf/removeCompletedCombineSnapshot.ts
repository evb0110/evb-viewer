export interface ICombineSnapshotItem {
    id: string;
}

export function removeCompletedCombineSnapshot<T extends ICombineSnapshotItem>(
    currentItems: readonly T[],
    snapshotItems: readonly ICombineSnapshotItem[],
) {
    const completedIds = new Set(snapshotItems.map((item) => item.id));
    return currentItems.filter((item) => !completedIds.has(item.id));
}
