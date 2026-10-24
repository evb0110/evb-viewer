<template>
    <UCollapsible
        v-model:open="shortcutsOpen"
        :unmount-on-hide="false"
        class="settings-details flex flex-col"
    >
        <template #default="{ open }">
            <button
                type="button"
                class="settings-section-title is-toggle"
                :aria-expanded="open ? 'true' : 'false'"
            >
                <UIcon
                    :name="open ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                    class="settings-toggle-icon"
                />
                <span>{{ t('settings.shortcuts') }}</span>
            </button>
        </template>

        <template #content>
            <div class="settings-shortcuts-content flex flex-col">
                <p class="settings-field-hint">
                    {{ description }}
                </p>
                <div class="flex flex-col">
                    <div
                        v-for="item in items"
                        :key="item.label"
                        class="settings-shortcut-row flex items-center justify-between gap-3"
                    >
                        <span class="settings-shortcut-label">{{ item.label }}</span>
                        <span class="settings-shortcut-keys flex shrink-0">
                            <UKbd
                                v-for="(part, i) in item.keys"
                                :key="i"
                                class="settings-kbd"
                                size="sm"
                                variant="outline"
                            >{{ part }}</UKbd>
                        </span>
                    </div>
                </div>
            </div>
        </template>
    </UCollapsible>
</template>

<script setup lang="ts">
interface ISettingsShortcutItem {
    label: string;
    keys: string[];
}

defineProps<{
    description: string;
    items: ISettingsShortcutItem[];
}>();

const { t } = useTypedI18n();
const shortcutsOpen = ref(false);
</script>

<style lang="scss" scoped>
.settings-section-title.is-toggle {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    border: none;
    background: transparent;
}

.settings-toggle-icon {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
    color: var(--ui-text-dimmed);
}

.settings-shortcuts-content {
    gap: var(--app-space-lg);
}

.settings-shortcut-row {
    padding: var(--app-space-sm) 0;
}

.settings-shortcut-label {
    font-size: var(--app-text-size-body-sm);
    color: var(--ui-text);
}

.settings-shortcut-keys {
    gap: var(--app-space-2xs);
    white-space: nowrap;
}

.settings-kbd {
    font-family: var(--app-font-mono);
    text-transform: none;
}
</style>
