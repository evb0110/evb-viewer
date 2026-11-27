<template>
    <section
        class="tool-page"
        :aria-labelledby="titleId"
    >
        <header
            v-if="showHeader"
            class="tool-page-header"
        >
            <UButton
                v-if="showBack"
                color="neutral"
                variant="ghost"
                icon="i-ph-arrow-left"
                :aria-label="t('common.back')"
                @click="close"
            />
            <div class="tool-page-heading">
                <div
                    v-if="showEyebrow"
                    class="tool-page-kicker"
                >
                    <UIcon
                        :name="icon"
                        class="tool-page-kicker-icon"
                    />
                    <span>{{ eyebrow }}</span>
                </div>
                <h1
                    :id="titleId"
                    class="tool-page-title"
                >
                    {{ title }}
                </h1>
                <p
                    v-if="description"
                    class="tool-page-description"
                >
                    {{ description }}
                </p>
            </div>
        </header>
        <h1
            v-else
            :id="titleId"
            class="sr-only"
        >
            {{ title }}
        </h1>

        <main
            class="tool-page-body"
            :class="bodyScroll ? 'app-scrollbar app-scroll-region--balanced' : 'tool-page-body--no-scroll'"
        >
            <slot />
        </main>
    </section>
</template>

<script setup lang="ts">
const {
    title,
    eyebrow,
    description = undefined,
    icon,
    showBack = true,
    showEyebrow = true,
    showHeader = true,
    bodyScroll = true,
} = defineProps<{
    title: string;
    eyebrow: string;
    description?: string;
    icon: string;
    showBack?: boolean;
    showEyebrow?: boolean;
    showHeader?: boolean;
    bodyScroll?: boolean;
}>();

const emit = defineEmits<{close: []}>();

const {t} = useTypedI18n();
const titleId = useId();

function close() {
    emit('close');
}
</script>

<style scoped>
.tool-page {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-start-bg);
    color: var(--ui-text);
}

.tool-page-header {
    display: flex;
    align-items: flex-start;
    gap: var(--app-tool-page-header-gap);
    border-bottom: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 86%, var(--app-start-bg) 14%);
    padding: var(--app-tool-page-padding);
}

.tool-page-heading {
    min-width: 0;
}

.tool-page-kicker {
    display: flex;
    align-items: center;
    gap: var(--app-tool-page-kicker-gap);
    color: var(--ui-text-muted);
    font-size: var(--app-tool-page-kicker-font-size);
    font-weight: var(--app-font-weight-semibold);
}

.tool-page-kicker-icon {
    width: var(--app-icon-size-sm);
    height: var(--app-icon-size-sm);
}

.tool-page-title {
    margin: var(--app-tool-page-title-margin-top) 0 0;
    color: var(--ui-text-highlighted);
    font-size: var(--app-tool-page-title-font-size);
    font-weight: var(--app-font-weight-heading);
    letter-spacing: 0;
    line-height: var(--app-line-height-snug);
}

.tool-page-description {
    max-width: var(--app-measure-readable);
    margin: var(--app-tool-page-description-margin-top) 0 0;
    color: var(--ui-text-muted);
    font-size: var(--app-tool-page-description-font-size);
    line-height: var(--app-line-height-body);
}

.tool-page-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--app-tool-page-padding);
    container-type: inline-size;
}

.tool-page-body--no-scroll {
    overflow: hidden;
}
</style>
