<template>
    <UModal
        v-model:open="open"
        :title="t('settings.title')"
        :ui="{ footer: 'justify-end' }"
    >
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
                        icon="i-lucide-languages"
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
import type { TI18nComposer } from '@app/types/i18n';
import type {
    TAppLocale,
    TAppTheme,
} from '@app/types/shared';

const open = defineModel<boolean>('open', { required: true });

const {
    t,
    setLocale,
} = useI18n() as TI18nComposer;
const colorMode = useColorMode();
const {
    settings,
    updateSetting,
} = useSettings();

const localeItems = computed(() => [
    {
        label: 'English',
        value: 'en', 
    },
    {
        label: 'Русский',
        value: 'ru', 
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
