<template>
  <main aria-labelledby="features-title">
    <section class="page-intro">
      <UBadge
        :label="t('features.hero.badge')"
        color="primary"
        variant="subtle"
      />
      <h1
        id="features-title"
        class="page-title"
      >
        {{ t('features.hero.title') }}
      </h1>
      <p class="page-subtitle">
        {{ t('features.hero.subtitle') }}
      </p>

      <div class="section-actions">
        <UButton
          :label="t('home.hero.openInBrowser')"
          to="/app"
          target="_blank"
          rel="noreferrer"
          icon="i-ph-globe"
        />
        <UButton
          :label="t('home.hero.browseInstallers')"
          :to="`${localePath('/')}#installers`"
          color="neutral"
          variant="outline"
          trailing-icon="i-ph-arrow-right"
        />
      </div>
    </section>

    <section class="content-section">
      <div class="section-head">
        <h2>{{ t('home.entryPoints.heading') }}</h2>
        <p>{{ t('home.entryPoints.description') }}</p>
      </div>

      <div class="docs-grid">
        <UCard
          v-for="entry in entryPointCards"
          :key="entry.title"
          class="doc-card"
        >
          <UIcon
            :name="entry.icon"
            class="doc-icon"
          />
          <h3>{{ entry.title }}</h3>
          <p>{{ entry.description }}</p>
          <ul class="docs-list entry-point-list">
            <li
              v-for="point in entry.points"
              :key="point"
            >
              {{ point }}
            </li>
          </ul>
        </UCard>
      </div>
    </section>

    <section class="content-section">
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

    <section class="content-section">
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

    <section class="content-section">
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
  </main>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const localePath = useLocalePath();
const pageDescription = computed(() => t('features.seo.ogDescription'));

const entryPointCards = computed(() => [
    {
        icon: 'i-ph-globe',
        title: t('home.entryPoints.web.title'),
        description: t('home.entryPoints.web.description'),
        points: [
            t('home.entryPoints.web.point1'),
            t('home.entryPoints.web.point2'),
            t('home.entryPoints.web.point3'),
        ],
    },
    {
        icon: 'i-ph-download',
        title: t('home.entryPoints.desktop.title'),
        description: t('home.entryPoints.desktop.description'),
        points: [
            t('home.entryPoints.desktop.point1'),
            t('home.entryPoints.desktop.point2'),
            t('home.entryPoints.desktop.point3'),
        ],
    },
]);

const featureCards = computed(() => [
    {
        icon: 'i-ph-files',
        title: t('features.cards.pdfDjvu.title'),
        description: t('features.cards.pdfDjvu.description'),
    },
    {
        icon: 'i-ph-text-aa',
        title: t('features.cards.ocr.title'),
        description: t('features.cards.ocr.description'),
    },
    {
        icon: 'i-ph-pen-nib',
        title: t('features.cards.annotations.title'),
        description: t('features.cards.annotations.description'),
    },
    {
        icon: 'i-ph-scissors',
        title: t('features.cards.pages.title'),
        description: t('features.cards.pages.description'),
    },
    {
        icon: 'i-ph-sidebar',
        title: t('features.cards.workspace.title'),
        description: t('features.cards.workspace.description'),
    },
    {
        icon: 'i-ph-folder-open',
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
        os: t('features.platforms.web'),
        architectures: t('features.platforms.webArch'),
        installerTypes: t('features.platforms.webInstallers'),
    },
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

useLandingPageSeo({
    title: () => t('features.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('features.seo.ogTitle'),
});
</script>
