<template>
    <UModal
        v-model:open="open"
        :title="t('settings.title')"
        :ui="{ footer: 'justify-end' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('settings.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="settings-body">
                <div class="settings-field">
                    <label class="settings-label" for="settings-author">
                        {{ t('settings.author') }}
                    </label>
                    <UInput
                        id="settings-author"
                        :model-value="settings.authorName"
                        :placeholder="t('settings.authorPlaceholder')"
                        icon="i-lucide-user"
                        @update:model-value="updateSetting('authorName', $event as string)"
                    />
                    <p class="settings-description">
                        {{ t('settings.authorDescription') }}
                    </p>
                </div>

                <div class="settings-field">
                    <label class="settings-label">
                        {{ t('settings.theme') }}
                    </label>
                    <div class="settings-theme-toggle">
                        <UButton
                            icon="i-lucide-sun"
                            :label="t('settings.themeLight')"
                            :variant="settings.theme === 'light' ? 'soft' : 'ghost'"
                            :color="settings.theme === 'light' ? 'primary' : 'neutral'"
                            size="sm"
                            @click="applyTheme('light')"
                        />
                        <UButton
                            icon="i-lucide-moon"
                            :label="t('settings.themeDark')"
                            :variant="settings.theme === 'dark' ? 'soft' : 'ghost'"
                            :color="settings.theme === 'dark' ? 'primary' : 'neutral'"
                            size="sm"
                            @click="applyTheme('dark')"
                        />
                    </div>
                    <p class="settings-description">
                        {{ t('settings.themeDescription') }}
                    </p>
                </div>

                <div class="settings-field">
                    <label class="settings-label">
                        {{ t('settings.language') }}
                    </label>
                    <USelectMenu
                        :model-value="settings.locale"
                        :items="localeItems"
                        value-key="value"
                        :icon="selectedFlagIcon"
                        :search-input="false"
                        @update:model-value="applyLocale"
                    />
                    <p class="settings-description">
                        {{ t('settings.languageDescription') }}
                    </p>
                </div>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('settings.close')"
                color="neutral"
                variant="outline"
                @click="close"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {
    TAppLocale,
    TAppTheme,
} from '@app/types/shared';

const open = defineModel<boolean>('open', { required: true });

const {
    t,
    setLocale,
} = useTypedI18n();
const colorMode = useColorMode();
const {
    settings,
    updateSetting,
} = useSettings();

const LOCALE_FLAGS: Record<string, string> = {
    en: 'i-circle-flags-gb',
    ru: 'i-circle-flags-ru',
    fr: 'i-circle-flags-fr',
    de: 'i-circle-flags-de',
    es: 'i-circle-flags-es',
    it: 'i-circle-flags-it',
    pt: 'i-circle-flags-pt',
    nl: 'i-circle-flags-nl',
};

const selectedFlagIcon = computed(() => LOCALE_FLAGS[settings.value.locale] ?? LOCALE_FLAGS.en);

const localeItems = computed(() => [
    {
        label: t('settings.languageEnglish'),
        value: 'en',
        icon: LOCALE_FLAGS.en, 
    },
    {
        label: t('settings.languageRussian'),
        value: 'ru',
        icon: LOCALE_FLAGS.ru, 
    },
    {
        label: t('settings.languageFrench'),
        value: 'fr',
        icon: LOCALE_FLAGS.fr, 
    },
    {
        label: t('settings.languageGerman'),
        value: 'de',
        icon: LOCALE_FLAGS.de, 
    },
    {
        label: t('settings.languageSpanish'),
        value: 'es',
        icon: LOCALE_FLAGS.es, 
    },
    {
        label: t('settings.languageItalian'),
        value: 'it',
        icon: LOCALE_FLAGS.it, 
    },
    {
        label: t('settings.languagePortuguese'),
        value: 'pt',
        icon: LOCALE_FLAGS.pt, 
    },
    {
        label: t('settings.languageDutch'),
        value: 'nl',
        icon: LOCALE_FLAGS.nl, 
    },
]);

function applyTheme(theme: TAppTheme) {
    colorMode.preference = theme;
    updateSetting('theme', theme);
}

async function applyLocale(locale: string | { value: string }) {
    const code = (typeof locale === 'string' ? locale : locale.value) as TAppLocale;
    await setLocale(code);
    updateSetting('locale', code);
}
</script>

<style scoped>
.settings-body {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
}

.settings-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
}

.settings-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--ui-text);
}

.settings-description {
    font-size: 0.75rem;
    color: var(--ui-text-dimmed);
    margin: 0;
}

.settings-theme-toggle {
    display: flex;
    gap: 0.375rem;
}
</style>
