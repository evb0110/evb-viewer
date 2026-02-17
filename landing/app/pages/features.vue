<template>
  <div>
    <section class="page-intro section-reveal">
      <UBadge
        :label="t('features.hero.badge')"
        color="primary"
        variant="subtle"
      />
      <h1 class="page-title">
        {{ t('features.hero.title') }}
      </h1>
      <p class="page-subtitle">
        {{ t('features.hero.subtitle') }}
      </p>
    </section>

    <section class="content-section section-reveal section-delay-1">
      <div class="section-head">
        <h2>{{ t('features.capabilities.heading') }}</h2>
        <p>{{ t('features.capabilities.description') }}</p>
      </div>

      <div class="features-grid">
        <UCard
          v-for="feature in featureCards"
          :key="feature.title"
          class="feature-card"
        >
          <UIcon
            :name="feature.icon"
            class="feature-icon"
          />
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
        </UCard>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-2">
      <div class="section-head">
        <h2>{{ t('features.workflow.heading') }}</h2>
        <p>{{ t('features.workflow.description') }}</p>
      </div>

      <div class="workflow-grid">
        <UCard
          v-for="(step, index) in workflowSteps"
          :key="step.title"
          class="workflow-card"
        >
          <p class="workflow-index">
            {{ String(index + 1).padStart(2, '0') }}
          </p>
          <h3>{{ step.title }}</h3>
          <p>{{ step.body }}</p>
        </UCard>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-3">
      <div class="section-head">
        <h2>{{ t('features.platforms.heading') }}</h2>
        <p>{{ t('features.platforms.description') }}</p>
      </div>

      <UCard class="table-card">
        <div class="table-wrap">
          <table class="platform-table">
            <thead>
              <tr>
                <th scope="col">
                  {{ t('features.platforms.colOs') }}
                </th>
                <th scope="col">
                  {{ t('features.platforms.colArch') }}
                </th>
                <th scope="col">
                  {{ t('features.platforms.colInstallers') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in platformRows"
                :key="row.os"
              >
                <td>{{ row.os }}</td>
                <td>{{ row.architectures }}</td>
                <td>{{ row.installerTypes }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </section>
  </div>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();

const featureCards = computed(() => [
    {
        icon: 'i-lucide-file-stack',
        title: t('features.cards.pdfDjvu.title'),
        description: t('features.cards.pdfDjvu.description'),
    },
    {
        icon: 'i-lucide-text-search',
        title: t('features.cards.ocr.title'),
        description: t('features.cards.ocr.description'),
    },
    {
        icon: 'i-lucide-pen-tool',
        title: t('features.cards.annotations.title'),
        description: t('features.cards.annotations.description'),
    },
    {
        icon: 'i-lucide-scissors-square-dashed-bottom',
        title: t('features.cards.pages.title'),
        description: t('features.cards.pages.description'),
    },
    {
        icon: 'i-lucide-layout-panel-left',
        title: t('features.cards.workspace.title'),
        description: t('features.cards.workspace.description'),
    },
    {
        icon: 'i-lucide-folder-output',
        title: t('features.cards.exports.title'),
        description: t('features.cards.exports.description'),
    },
]);

const workflowSteps = computed(() => [
    {
        title: t('features.workflow.load.title'),
        body: t('features.workflow.load.body'),
    },
    {
        title: t('features.workflow.review.title'),
        body: t('features.workflow.review.body'),
    },
    {
        title: t('features.workflow.edit.title'),
        body: t('features.workflow.edit.body'),
    },
    {
        title: t('features.workflow.export.title'),
        body: t('features.workflow.export.body'),
    },
]);

const platformRows = computed(() => [
    {
        os: t('features.platforms.macOs'),
        architectures: t('features.platforms.macArch'),
        installerTypes: t('features.platforms.macInstallers'),
    },
    {
        os: t('features.platforms.windows'),
        architectures: t('features.platforms.winArch'),
        installerTypes: t('features.platforms.winInstallers'),
    },
    {
        os: t('features.platforms.linux'),
        architectures: t('features.platforms.linuxArch'),
        installerTypes: t('features.platforms.linuxInstallers'),
    },
]);

useSeoMeta({
    title: () => t('features.seo.title'),
    ogTitle: () => t('features.seo.ogTitle'),
    ogDescription: () => t('features.seo.ogDescription'),
});
</script>
