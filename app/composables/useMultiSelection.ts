import type {ShallowRef} from 'vue';

function getSelectionRange<T extends string | number>(id: T, allIds: T[], anchorId: T | null) {
    if (anchorId === null) {
        return null;
    }

    const anchorIndex = allIds.indexOf(anchorId);
    const targetIndex = allIds.indexOf(id);
    if (anchorIndex < 0 || targetIndex < 0) {
        return null;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return allIds.slice(start, end + 1);
}

function toggleIdInSelection<T extends string | number>(selectedIds: Set<T>, id: T) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}

interface IMultiSelectionToggleOptions<T> {
    shift?: boolean;
    meta?: boolean;
    fallbackAnchor?: T | null;
}

export const useMultiSelection = <T extends string | number>() => {
    const selected = shallowRef<Set<T>>(new Set<T>());
    const anchor = shallowRef<T | null>(null) as ShallowRef<T | null>;

    function toggle(id: T, allIds: T[], opts: IMultiSelectionToggleOptions<T> = {}) {
        const fallbackAnchor = opts.fallbackAnchor ?? null;
        const anchorId = anchor.value ?? fallbackAnchor;
        const selectionRange = opts.shift ? getSelectionRange(id, allIds, anchorId) : null;
        if (selectionRange) {
            selected.value = new Set<T>(selectionRange);
            anchor.value = anchorId;
            return;
        }

        if (opts.meta) {
            selected.value = toggleIdInSelection(selected.value, id);
            anchor.value = id;
            return;
        }

        selected.value = new Set<T>([id]);
        anchor.value = id;
    }

    function clear() {
        selected.value = new Set<T>();
        anchor.value = null;
    }

    function isSelected(id: T) {
        return selected.value.has(id);
    }

    return {
        selected,
        anchor,
        toggle,
        clear,
        isSelected,
    };
};
