<template>
  <div class="language-switcher">
    <UPopover
      v-model:open="open"
      :content="{ align: 'end', sideOffset: 8 }"
    >
      <!-- The flag alone marks the current language; the menu lists the names. -->
      <UButton
        :icon="activeLanguage.icon"
        :aria-label="activeLanguage.name"
        :title="activeLanguage.name"
        color="neutral"
        variant="ghost"
        size="md"
        square
      />

      <template #content>
        <div class="language-switcher-menu">
          <UButton
            v-for="option in languageOptions"
            :key="option.code"
            :label="option.name"
            :icon="option.icon"
            color="neutral"
            :variant="option.code === activeLocaleCode ? 'soft' : 'ghost'"
            size="md"
            class="language-switcher-option"
            :aria-pressed="option.code === activeLocaleCode"
            @click="switchTo(option.code)"
          />
        </div>
      </template>
    </UPopover>
  </div>
</template>

<script setup lang="ts">
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
    type TLocale,
} from '~/i18n/locales';

interface ILanguageOption {
    code: TLocale
    icon: string
    name: string
}

const LOCALE_FLAG_ICONS: Record<TLocale, string> = {
    en: 'i-circle-flags-gb',
    ru: 'i-circle-flags-ru',
    fr: 'i-circle-flags-fr',
    de: 'i-circle-flags-de',
    es: 'i-circle-flags-es',
    it: 'i-circle-flags-it',
    pt: 'i-circle-flags-pt',
    'pt-BR': 'i-circle-flags-br',
    nl: 'i-circle-flags-nl',
};

const fallbackLanguageOption: ILanguageOption = {
    code: DEFAULT_LOCALE,
    icon: LOCALE_FLAG_ICONS[DEFAULT_LOCALE],
    name: LOCALE_DEFINITIONS[0].name,
};

const open = ref(false);

const {
    locale,
    setLocale,
} = useTypedI18n();

const languageOptions = computed<ILanguageOption[]>(() => LOCALE_DEFINITIONS.map(localeDefinition => ({
    code: localeDefinition.code,
    icon: LOCALE_FLAG_ICONS[localeDefinition.code],
    name: localeDefinition.name,
})));

const activeLocaleCode = computed<TLocale>(() => {
    const currentLocale = locale.value;
    return isLocale(currentLocale) ? currentLocale : DEFAULT_LOCALE;
});

const activeLanguage = computed(() => (
    languageOptions.value.find(option => option.code === activeLocaleCode.value) ?? fallbackLanguageOption
));

async function switchTo(code: TLocale) {
    open.value = false;

    if (code === activeLocaleCode.value) {
        return;
    }

    await setLocale(code);
}

function isLocale(value: string): value is TLocale {
    return LOCALE_CODES.some(code => code === value);
}
</script>
