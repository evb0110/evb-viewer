<template>
    <div class="djvu-banner-anchor">
        <div class="djvu-banner">
            <UIcon
                name="i-ph-info"
                class="djvu-banner-icon"
            />
            <span class="djvu-banner-text">
                {{ t('djvu.bannerHint') }}
            </span>
            <div class="djvu-banner-actions">
                <UButton
                    :label="t('djvu.convertToPdf')"
                    data-focus-restore="djvu-convert"
                    variant="soft"
                    color="primary"
                    size="xs"
                    @click="convert"
                />
                <UButton
                    icon="i-ph-x"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    :aria-label="t('common.close')"
                    class="djvu-banner-close"
                    @click="dismiss"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

function convert() {
    emit('convert');
}

function dismiss() {
    emit('dismiss');
}
</script>

<style scoped>
.djvu-banner-anchor {
    position: relative;
    height: 0;
    z-index: var(--app-z-document-status);
}

.djvu-banner {
    position: absolute;
    top: var(--app-space-lg);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--app-space-xl);
    max-width: min(90%, 40rem);
    padding: var(--app-space-sm) var(--app-space-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
    backdrop-filter: blur(var(--app-backdrop-blur-md));
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    box-shadow: var(--shadow-popup);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-snug);
    white-space: nowrap;
}

:global(html.app-low-graphics) .djvu-banner {
    backdrop-filter: none;
}

.djvu-banner-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
    color: var(--ui-primary);
    flex-shrink: 0;
}

.djvu-banner-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding-block: var(--app-space-2xs);
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
    line-height: var(--app-line-height-body);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.djvu-banner-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--app-space-sm);
}

.djvu-banner-close {
    flex-shrink: 0;
}
</style>
