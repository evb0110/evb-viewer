export const useMultiSelection = <T extends string | number>() => {
    const selected = ref(new Set<T>()) as Ref<Set<T>>;
    const anchor = ref<T | null>(null) as Ref<T | null>;

    function toggle(
        id: T,
        allIds: T[],
        opts: {
            shift?: boolean;
            meta?: boolean 
        } = {},
    ) {
        if (opts.shift && anchor.value !== null) {
            const anchorIndex = allIds.indexOf(anchor.value);
            const targetIndex = allIds.indexOf(id);
            if (anchorIndex >= 0 && targetIndex >= 0) {
                const start = Math.min(anchorIndex, targetIndex);
                const end = Math.max(anchorIndex, targetIndex);
                const next = new Set<T>();
                for (let i = start; i <= end; i += 1) {
                    const current = allIds[i];
                    if (current !== undefined) {
                        next.add(current);
                    }
                }
                selected.value = next;
                return;
            }
        }

        if (opts.meta) {
            const next = new Set(selected.value);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            selected.value = next;
            anchor.value = id;
            return;
        }

        selected.value = new Set([id]);
        anchor.value = id;
    }

    function clear() {
        selected.value = new Set();
        anchor.value = null;
    }

    function selectAll(ids: T[]) {
        selected.value = new Set(ids);
    }

    function isSelected(id: T) {
        return selected.value.has(id);
    }

    return {
        selected,
        anchor,
        toggle,
        clear,
        selectAll,
        isSelected, 
    };
};
