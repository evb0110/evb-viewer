<template>
  <I18nT keypath="footer.copyright" tag="span" scope="global">
    <template #author>
      <a
        href="https://evb-stack.com/"
        target="_blank"
        rel="noopener noreferrer"
        class="copyright-author"
      >{{ t('footer.author') }}</a>
    </template>
  </I18nT>
</template>

<script setup lang="ts">
import { I18nT } from 'vue-i18n';

const { t } = useTypedI18n();
</script>

<style scoped>
.copyright-author {
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
