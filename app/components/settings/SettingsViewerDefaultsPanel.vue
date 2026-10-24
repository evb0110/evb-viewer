<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.viewerDefaults') }}</legend>

        <UFormField
            :label="t('settings.defaultZoom')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.defaultZoomPreset"
                :items="zoomPresetItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:zoom-preset', $event)"
            />
        </UFormField>

        <UFormField
            :label="t('settings.defaultViewMode')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.defaultViewMode"
                :items="viewModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:view-mode', $event)"
            />
        </UFormField>

        <UFormField
            :label="t('settings.defaultScrollMode')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.defaultContinuousScroll"
                :items="scrollModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:scroll-mode', $event)"
            />
        </UFormField>

        <USwitch
            id="settings-remember-document-view"
            :model-value="settings.rememberDocumentView"
            :label="t('settings.rememberDocumentView')"
            size="sm"
            :ui="settingsControlUi"
            @update:model-value="emit('update:remember-document-view', $event)"
        />

        <UFormField
            :label="t('settings.defaultAnnotationColor')"
            :ui="settingsFormFieldUi"
        >
            <div
                class="settings-swatch-track"
                role="radiogroup"
                :aria-label="t('settings.defaultAnnotationColor')"
            >
                <button
                    v-for="swatch in annotationColorSwatches"
                    :key="swatch"
                    type="button"
                    class="settings-swatch"
                    :class="{ 'is-active': settings.defaultAnnotationColor === swatch }"
                    :style="{ '--swatch-color': swatch }"
                    :aria-label="t('settings.annotationColorLabel', { color: swatch })"
                    :aria-checked="settings.defaultAnnotationColor === swatch"
                    role="radio"
                    @click="emit('update:annotation-color', swatch)"
                />
            </div>
        </UFormField>

        <UFormField
            :label="t('settings.tabMemoryPolicy')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.tabMemoryPolicy"
                :items="tabMemoryPolicyItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:tab-memory-policy', $event)"
            />
        </UFormField>

        <UFormField
            :label="t('settings.pdfSaveAs')"
            :help="t('settings.optimizePdfOnSaveAsDescription')"
            :ui="settingsFormFieldUi"
        >
            <USwitch
                :model-value="settings.optimizePdfOnSaveAs"
                :label="t('settings.optimizePdfOnSaveAs')"
                size="sm"
                :ui="settingsControlUi"
                @update:model-value="emit('update:optimize-pdf-on-save-as', $event)"
            />
        </UFormField>
    </fieldset>
</template>

<script setup lang="ts">
import type {
    ISettingsData,
    TDefaultZoomPreset,
    TTabMemoryPolicy,
    TPdfViewMode,
} from '@contracts/shared';

interface ISelectItem<T> {
    value: T;
    label: string;
}

defineProps<{
    settings: ISettingsData;
    zoomPresetItems: Array<ISelectItem<TDefaultZoomPreset>>;
    viewModeItems: Array<ISelectItem<TPdfViewMode>>;
    scrollModeItems: Array<ISelectItem<boolean>>;
    tabMemoryPolicyItems: Array<ISelectItem<TTabMemoryPolicy>>;
    annotationColorSwatches: readonly string[];
}>();

const emit = defineEmits<{
    'update:zoom-preset': [value: string | { value: string }];
    'update:view-mode': [value: string | { value: string }];
    'update:scroll-mode': [value: boolean | { value: boolean }];
    'update:remember-document-view': [value: boolean];
    'update:tab-memory-policy': [value: string | { value: string }];
    'update:annotation-color': [value: string];
    'update:optimize-pdf-on-save-as': [value: boolean];
}>();

const { t } = useTypedI18n();

const settingsFormFieldUi = {
    label: 'settings-field-label',
    help: 'settings-field-hint mt-1',
};
const settingsControlUi = { label: 'settings-control-label' };

</script>

<style lang="scss" scoped>
.settings-swatch {
    width: var(--app-space-16xl);
    height: var(--app-space-16xl);
    border-radius: var(--app-radius-full);
    border: none;
    background: var(--swatch-color);
    cursor: pointer;
    box-shadow: 0 0 0 0 transparent;
    transition: transform $ease-quick, box-shadow $ease-quick;
}

.settings-swatch:hover {
    transform: scale(1.1);
}

.settings-swatch.is-active {
    box-shadow:
        0 0 0 2px var(--ui-bg-muted),
        0 0 0 4px var(--app-toolbar-control-active-border);
}

.settings-swatch.is-active:hover {
    box-shadow:
        0 0 0 2px var(--ui-bg-muted),
        0 0 0 4px var(--app-toolbar-control-active-hover-border);
}

.settings-swatch-track {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    align-self: flex-start;
    max-width: 100%;
    gap: var(--app-space-3xl);
    padding: var(--app-space-3xl) var(--app-space-6xl);
    border-radius: calc(var(--ui-radius) * 1.5);
    background: var(--ui-bg-muted);
}
</style>
