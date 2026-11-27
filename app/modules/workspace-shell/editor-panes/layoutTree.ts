import type {IEditorLayoutLeafNode, IEditorLayoutSplitNode, TEditorLayoutNode, TPaneId} from '@contracts/editorPanes';

export function collectLayoutPaneIds(node: TEditorLayoutNode, target: Set<string>) {
    if (node.type === 'leaf') {
        target.add(node.paneId);
        return;
    }

    collectLayoutPaneIds(node.first, target);
    collectLayoutPaneIds(node.second, target);
}

export function pruneLayoutToExistingPanes(node: TEditorLayoutNode, validPaneIds: Set<string>): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        return validPaneIds.has(node.paneId) ? node : null;
    }

    const nextFirst = pruneLayoutToExistingPanes(node.first, validPaneIds);
    const nextSecond = pruneLayoutToExistingPanes(node.second, validPaneIds);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    if (nextFirst === node.first && nextSecond === node.second) {
        return node;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
}

export function appendPaneToLayout(currentLayout: TEditorLayoutNode | null, paneId: TPaneId): TEditorLayoutNode {
    const nextLeaf: IEditorLayoutLeafNode = {
        type: 'leaf',
        paneId,
    };
    if (!currentLayout) {
        return nextLeaf;
    }

    return {
        type: 'split',
        id: crypto.randomUUID(),
        orientation: 'horizontal',
        ratio: 0.5,
        first: currentLayout,
        second: nextLeaf,
    };
}

export function removeLeafNode(node: TEditorLayoutNode, paneId: TPaneId): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        return node.paneId === paneId ? null : node;
    }

    const nextFirst = removeLeafNode(node.first, paneId);
    const nextSecond = removeLeafNode(node.second, paneId);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
}

export function replaceLeafWithSplit(node: TEditorLayoutNode, sourcePaneId: TPaneId, splitNode: IEditorLayoutSplitNode): TEditorLayoutNode {
    if (node.type === 'leaf') {
        return node.paneId === sourcePaneId ? splitNode : node;
    }

    return {
        ...node,
        first: replaceLeafWithSplit(node.first, sourcePaneId, splitNode),
        second: replaceLeafWithSplit(node.second, sourcePaneId, splitNode),
    };
}

export function updateLayoutSplitRatio(layout: TEditorLayoutNode, splitId: string, nextRatio: number): TEditorLayoutNode {
    if (layout.type === 'leaf') {
        return layout;
    }

    if (layout.id === splitId) {
        return {
            ...layout,
            ratio: nextRatio,
        };
    }

    return {
        ...layout,
        first: updateLayoutSplitRatio(layout.first, splitId, nextRatio),
        second: updateLayoutSplitRatio(layout.second, splitId, nextRatio),
    };
}
