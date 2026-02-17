<template>
  <UPopover v-model:open="open">
    <UButton
      color="neutral"
      variant="ghost"
      :icon="LOCALE_FLAGS[locale as TLocale]"
    />

    <template #content>
      <div class="switcher-list">
        <button
          v-for="loc in LOCALE_DEFINITIONS"
          :key="loc.code"
          type="button"
          class="switcher-item"
          :class="{ 'is-active': locale === loc.code }"
          @click="switchTo(loc.code)"
        >
          <UIcon
            :name="LOCALE_FLAGS[loc.code]"
            class="switcher-flag"
          />
          <span>{{ loc.name }}</span>
        </button>
      </div>
    </template>
  </UPopover>
</template>

<script setup lang="ts">
import {
    LOCALE_DEFINITIONS,
    type TLocale,
} from '~/i18n/locales';

const LOCALE_FLAGS: Record<TLocale, string> = {
    en: 'i-circle-flags-gb',
    ru: 'i-circle-flags-ru',
    fr: 'i-circle-flags-fr',
    de: 'i-circle-flags-de',
    es: 'i-circle-flags-es',
    it: 'i-circle-flags-it',
    pt: 'i-circle-flags-pt',
    nl: 'i-circle-flags-nl',
};

const open = ref(false);

const {
    locale,
    setLocale,
} = useTypedI18n();

async function switchTo(code: TLocale) {
    open.value = false;
    await setLocale(code);
}
</script>

<style scoped>
.switcher-list {
    display: flex;
    flex-direction: column;
    padding: 4px;
    min-width: 160px;
}

.switcher-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s;
    color: var(--ui-text);
    background: transparent;
    border: none;
    width: 100%;
    text-align: left;
}

.switcher-item:hover {
    background: var(--ui-bg-elevated);
}

.switcher-item.is-active {
    background: var(--ui-bg-accented);
    font-weight: 500;
}

.switcher-flag {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
}
</style>
