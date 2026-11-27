import { decodeHTML } from 'entities';
import {
    createSSRApp,
    ssrContextKey,
    type ComponentInternalInstance,
    type VNode,
} from 'vue';
import { ssrRenderVNode } from 'vue/server-renderer';

const ssrApp = createSSRApp({ render: () => null });
ssrApp.provide(ssrContextKey, { modules: new Set() });
const ssrParent = {
    appContext: ssrApp._context,
    provides: ssrApp._context.provides,
} as unknown as ComponentInternalInstance;

function flattenSsrBuffer(chunks: unknown[]): string {
    let html = '';
    for (const chunk of chunks) {
        if (typeof chunk === 'string') {
            html += chunk;
        } else if (Array.isArray(chunk)) {
            html += flattenSsrBuffer(chunk);
        }
    }
    return html;
}

function renderVNodeToLines(root: VNode): string {
    const buffer: unknown[] = [];
    ssrRenderVNode((item) => {
        buffer.push(item);
    }, root, ssrParent);
    const html = flattenSsrBuffer(buffer)
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/<\/[a-z0-9-]+>\s*<[a-z0-9-]+(?:\s[^>]*)?>/giu, '\n')
        .replace(/<[^>]+>/gu, '');
    return decodeHTML(html);
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
    return renderVNodeToLines((description as () => VNode)());
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
