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
        >
            <template #label="{ item }">
                <span class="settings-radio-label">
                    <UIcon :name="item.icon" class="settings-radio-icon" />
                    <span>{{ item.label }}</span>
                </span>
            </template>
        </URadioGroup>

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
                :model-value="settings.uiScale"
                :legend="t('settings.uiScale')"
                :items="uiScaleOptions"
                value-key="value"
                variant="table"
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
const settingsRadioGroupUi = {
    fieldset: 'w-full',
    legend: 'settings-field-label',
    item: 'flex-1 cursor-pointer justify-center px-2 py-1.5',
    label: 'w-full text-center text-xs font-medium',
};
const localeSelectContent = [
    'settings-locale-select-content',
    'w-auto min-w-(--reka-combobox-trigger-width)',
].join(' ');
const localeSelectUi = { content: localeSelectContent };
const themeOptions = computed(() => [
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
const uiScaleOptions = computed(() => [
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
@use '@app/assets/css/settings-panel-shared';

.settings-radio-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-md);
    min-width: 0;
}

.settings-radio-icon {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
}
</style>
