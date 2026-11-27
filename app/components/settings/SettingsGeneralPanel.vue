<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.general') }}</legend>

        <UFormField
            :label="t('settings.author')"
            :help="t('settings.authorDescription')"
            :ui="settingsFormFieldUi"
        >
            <UInput
                id="settings-author"
                class="w-full"
                :model-value="settings.authorName"
                :placeholder="t('settings.authorPlaceholder')"
                icon="i-ph-user"
                @update:model-value="updateAuthorName"
            />
        </UFormField>

        <div class="settings-field flex flex-col gap-1">
            <UCheckbox
                id="settings-suppress-unencrypted-save-notice"
                :model-value="settings.suppressUnencryptedSaveNotice === true"
                :label="t('settings.suppressUnencryptedSaveNotice')"
                :ui="settingsControlUi"
                @update:model-value="emit('update:suppress-unencrypted-save-notice', $event === true)"
            />
            <p class="settings-field-hint">{{ t('settings.suppressUnencryptedSaveNoticeDescription') }}</p>
        </div>

        <URadioGroup
            class="settings-field"
            :model-value="settings.theme"
            :legend="t('settings.theme')"
            :items="themeOptions"
            value-key="value"
            variant="table"
            orientation="horizontal"
            indicator="hidden"
            :ui="settingsRadioGroupUi"
            @update:model-value="updateTheme"
        />

        <UFormField
            :label="t('settings.language')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.locale"
                :items="localeItems"
                value-key="value"
                :icon="selectedFlagIcon"
                :search-input="false"
                :ui="localeSelectUi"
                @update:model-value="emit('update:locale', $event)"
            />
        </UFormField>

        <div class="settings-field flex flex-col gap-1">
            <URadioGroup
                class="settings-scale-options"
                :model-value="settings.uiScale"
                :legend="t('settings.uiScale')"
                :items="uiScaleOptions"
                value-key="value"
                variant="card"
                orientation="horizontal"
                indicator="hidden"
                :ui="settingsRadioGroupUi"
                @update:model-value="updateUiScale"
            />
            <p class="settings-field-hint">{{ t('settings.uiScaleDescription') }}</p>
        </div>
    </fieldset>
</template>

<script setup lang="ts">
import type {
    ISettingsData,
    TAppTheme,
    TUiScalePreference,
} from '@contracts/shared';

interface ILocaleItem {
    value: string;
    label: string;
    icon: string;
}

interface IThemeOption {
    value: TAppTheme;
    label: string;
    icon: string;
}

interface IUiScaleOption {
    value: TUiScalePreference;
    label: string;
}

defineProps<{
    settings: ISettingsData;
    localeItems: ILocaleItem[];
    selectedFlagIcon: string;
}>();

const emit = defineEmits<{
    'update:author-name': [value: string];
    'update:suppress-unencrypted-save-notice': [value: boolean];
    'update:theme': [value: TAppTheme];
    'update:locale': [value: string | { value: string }];
    'update:ui-scale': [value: TUiScalePreference];
}>();

const { t } = useTypedI18n();

const settingsFormFieldUi = {
    label: 'settings-field-label',
    help: 'settings-field-hint mt-1',
};
const settingsControlUi = { label: 'settings-control-label' };
const settingsRadioGroupUi = {
    fieldset: 'w-full',
    legend: 'settings-field-label',
    item: 'settings-radio-item',
    wrapper: 'settings-radio-wrapper',
    label: 'settings-radio-label',
} as const;
const localeSelectContent = [
    'settings-locale-select-content',
    'w-auto min-w-(--reka-combobox-trigger-width)',
].join(' ');
const localeSelectUi = { content: localeSelectContent };
const themeOptions = computed<IThemeOption[]>(() => [
    {
        value: 'light',
        label: t('settings.themeLight'),
        icon: 'i-ph-sun',
    },
    {
        value: 'dark',
        label: t('settings.themeDark'),
        icon: 'i-ph-moon',
    },
]);
const uiScaleOptions = computed<IUiScaleOption[]>(() => [
    {
        value: 'auto',
        label: t('settings.uiScaleAuto'),
    },
    {
        value: 'compact',
        label: t('settings.uiScaleCompact'),
    },
    {
        value: 'default',
        label: t('settings.uiScaleDefault'),
    },
    {
        value: 'comfortable',
        label: t('settings.uiScaleComfortable'),
    },
    {
        value: 'large',
        label: t('settings.uiScaleLarge'),
    },
]);

function updateAuthorName(value: string | number) {
    emit('update:author-name', String(value));
}

function updateTheme(value: TAppTheme) {
    emit('update:theme', value);
}

function updateUiScale(value: TUiScalePreference) {
    emit('update:ui-scale', value);
}

</script>

<style lang="scss" scoped>
:deep(.settings-radio-item) {
    flex: 1 1 0%;
    min-width: fit-content;
    min-height: var(--app-control-height-lg);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    padding: var(--app-space-lg) var(--app-space-3xl);
}

:deep(.settings-radio-wrapper) {
    flex-direction: row;
    justify-content: center;
    gap: var(--app-space-3xl);
}

:deep(.settings-radio-label) {
    text-align: center;
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-medium);
}

@container (max-width: 520px) {
    .settings-scale-options :deep([data-slot='item']) {
        flex-basis: calc(50% - var(--app-space-sm));
    }

    .settings-scale-options :deep([data-slot='item']:first-of-type) {
        flex-basis: 100%;
    }
}
</style>
