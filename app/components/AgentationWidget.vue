<template>
    <div ref="agentationRootRef">
        <Agentation />
    </div>
</template>

<script setup lang="ts">
import {useMutationObserver} from '@vueuse/core';
import {Agentation} from 'agentation-vue3';
import 'agentation-vue3/dist/style.css';

const agentationRootRef = useTemplateRef<HTMLElement>('agentationRootRef');
const agentationControlTitleSelector = '[class*="_controlButton_"][title]';

function removeNativeTooltip(element: HTMLElement) {
    const title = element.getAttribute('title');
    if (title && !element.getAttribute('aria-label')) {
        element.setAttribute('aria-label', title);
    }
    element.removeAttribute('title');
}

function removeNativeTooltips(root: HTMLElement) {
    if (root.hasAttribute('title')) {
        removeNativeTooltip(root);
    }

    root.querySelectorAll<HTMLElement>('[title]').forEach(removeNativeTooltip);
}

function removeRootAgentationNativeTooltips() {
    const root = agentationRootRef.value;
    if (!root) {
        return;
    }

    removeNativeTooltips(root);
}

function removeDocumentAgentationNativeTooltips() {
    if (typeof document === 'undefined') {
        return;
    }

    document
        .querySelectorAll<HTMLElement>(agentationControlTitleSelector)
        .forEach((element) => removeNativeTooltips(element.parentElement ?? element));
}

function removeAgentationNativeTooltips() {
    removeRootAgentationNativeTooltips();
    removeDocumentAgentationNativeTooltips();
}

function handleAgentationMutationNode(node: Node) {
    if (!(node instanceof HTMLElement)) {
        return;
    }

    const root = agentationRootRef.value;
    if (root?.contains(node)) {
        removeNativeTooltips(node);
    }

    if (node.matches(agentationControlTitleSelector)) {
        removeNativeTooltips(node.parentElement ?? node);
    }

    node.querySelectorAll<HTMLElement>(agentationControlTitleSelector).forEach((element) =>
        removeNativeTooltips(element.parentElement ?? element),
    );
}

function handleAgentationMutations(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
            handleAgentationMutationNode(mutation.target);
            continue;
        }

        mutation.addedNodes.forEach(handleAgentationMutationNode);
    }
}

onMounted(() => {
    removeAgentationNativeTooltips();
    void nextTick(removeDocumentAgentationNativeTooltips);
});

useMutationObserver(import.meta.dev && typeof document !== 'undefined' ? document.body : null, handleAgentationMutations, {
    attributes: true,
    attributeFilter: ['title'],
    childList: true,
    subtree: true,
});
</script>
