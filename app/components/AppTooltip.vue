<template>
    <UTooltip
        v-bind="tooltipProps"
        @update:open="updateOpen"
    >
        <span
            ref="triggerRef"
            class="app-tooltip-trigger"
            @pointerenter="refreshUsefulness"
            @focusin="refreshUsefulness"
        >
            <slot />
        </span>

        <template v-if="$slots.content" #content="slotProps">
            <slot name="content" v-bind="slotProps" />
        </template>
    </UTooltip>
</template>

<script setup lang="ts">
type TTooltipUsefulness = 'auto' | 'always' | 'overflow' | 'no-text';
type TTooltipClass = string | string[] | Record<string, boolean> | undefined;
type TTooltipObject = Record<string, unknown>;
type TTooltipPortal = boolean | string | HTMLElement;

interface IAppTooltipProps {
    text?: string;
    content?: TTooltipObject;
    arrow?: boolean | TTooltipObject;
    portal?: TTooltipPortal;
    class?: TTooltipClass;
    defaultOpen?: boolean;
    open?: boolean;
    delayDuration?: number;
    disableHoverableContent?: boolean;
    disableClosingTrigger?: boolean;
    disabled?: boolean;
    ignoreNonKeyboardFocus?: boolean;
    usefulness?: TTooltipUsefulness;
}

const {
    text = undefined,
    content = undefined,
    arrow = undefined,
    portal = true,
    class: tooltipClass = undefined,
    defaultOpen = undefined,
    open = undefined,
    delayDuration = undefined,
    disableHoverableContent = undefined,
    disableClosingTrigger = undefined,
    disabled = false,
    ignoreNonKeyboardFocus = undefined,
    usefulness = 'auto',
} = defineProps<IAppTooltipProps>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const triggerRef = useTemplateRef<HTMLElement>('triggerRef');
// The trigger wrapper has `display: contents` and no box, so the tooltip is
// placed against its first element, read whenever it positions. Storing that
// element after mount re-rendered every tooltip once more, which made the
// 4,000 note markers of a dense page spend over a second in Vue's queue.
const reference = {
    getBoundingClientRect: () => referenceElement()?.getBoundingClientRect() ?? new DOMRect(),
    get contextElement() {
        return referenceElement();
    },
};
const isUseful = ref(usefulness === 'always' || usefulness === 'auto' || usefulness === 'no-text');
const tooltipProps = computed(() => {
    const props: Record<string, unknown> = {disabled: disabled || !isUseful.value};
    if (text !== undefined) props.text = text;
    if (content !== undefined) props.content = content;
    if (arrow !== undefined) props.arrow = arrow;
    props.portal = portal;
    if (tooltipClass !== undefined) props.class = tooltipClass;
    if (defaultOpen !== undefined) props.defaultOpen = defaultOpen;
    if (open !== undefined) props.open = open;
    if (delayDuration !== undefined) props.delayDuration = delayDuration;
    if (disableHoverableContent !== undefined) props.disableHoverableContent = disableHoverableContent;
    if (disableClosingTrigger !== undefined) props.disableClosingTrigger = disableClosingTrigger;
    if (ignoreNonKeyboardFocus !== undefined) props.ignoreNonKeyboardFocus = ignoreNonKeyboardFocus;
    props.reference = reference;
    props.ui = {
        content: 'app-tooltip-content',
        text: 'app-tooltip-text',
    };
    return props;
});

function updateOpen(value: boolean) {
    emit('update:open', value);
}

function referenceElement() {
    const root = triggerRef.value;
    const element = root?.firstElementChild;

    return element instanceof HTMLElement ? element : root ?? undefined;
}

function hasUsefulText(element: HTMLElement) {
    return element.innerText.trim().length > 0;
}

function isElementOverflowing(element: Element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

function hasOverflowingContent(root: HTMLElement) {
    const trigger = root.firstElementChild ?? root;
    if (isElementOverflowing(trigger)) {
        return true;
    }

    return Array.from(trigger.querySelectorAll('*')).some(isElementOverflowing);
}

function refreshUsefulness() {
    const root = triggerRef.value;
    if (!root) {
        return;
    }

    isUseful.value = usefulness === 'always'
        || (usefulness === 'no-text' && !hasUsefulText(root))
        || (usefulness === 'overflow' && hasOverflowingContent(root))
        || (usefulness === 'auto' && (!hasUsefulText(root) || hasOverflowingContent(root)));
}

watch(() => usefulness, refreshUsefulness);
onMounted(refreshUsefulness);
</script>

<style scoped>
.app-tooltip-trigger {
    display: contents;
}
</style>

<style>
.app-tooltip-content {
    max-inline-size: var(--app-tooltip-max-inline-size);
    block-size: auto;
    align-items: start;
}

.app-tooltip-text {
    white-space: normal;
    overflow: visible;
    overflow-wrap: anywhere;
}
</style>
