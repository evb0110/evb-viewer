import type { VNode } from 'vue';

function readVNodeText(node: unknown): string {
    if (typeof node === 'string') {
        return node;
    }
    if (!node || typeof node !== 'object' || !('children' in node)) {
        return '';
    }
    const {children} = node as VNode;
    if (typeof children === 'string') {
        return children;
    }
    return Array.isArray(children) ? children.map(readVNodeText).join('') : '';
}

/**
 * The text a toast description shows, one line per line the user sees: a
 * failure's reason, then its Error ID.
 */
export function readToastDescription(description: unknown) {
    if (typeof description === 'string') {
        return description;
    }
    if (typeof description !== 'function') {
        return '';
    }
    const root = (description as () => VNode)();
    return Array.isArray(root.children)
        ? root.children.filter(Boolean).map(readVNodeText).join('\n')
        : readVNodeText(root);
}

function toastDescriptionMatcher(name: string, matches: (text: string) => boolean, expected: string) {
    return {
        asymmetricMatch: (actual: unknown) => matches(readToastDescription(actual)),
        toString: () => name,
        toAsymmetricMatcher: () => `${name}<${expected}>`,
    };
}

/** Matches a toast description whose shown text contains `expected`. */
export function toastDescriptionContaining(expected: string) {
    return toastDescriptionMatcher('ToastDescriptionContaining', text => text.includes(expected), expected);
}

/** Matches a toast description whose shown text is exactly `expected`. */
export function toastDescription(expected: string) {
    return toastDescriptionMatcher('ToastDescription', text => text === expected, expected);
}
