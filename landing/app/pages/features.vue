<script setup lang="ts">
const featureCards = [
    {
        icon: 'i-lucide-file-stack',
        title: 'PDF + DjVu in one app',
        description: 'Open PDF and DjVu files in the same workspace, including conversion tools for scanned pages.',
    },
    {
        icon: 'i-lucide-text-search',
        title: 'OCR with searchable output',
        description: 'Run high-quality OCR and keep extracted text embedded for search and export.',
    },
    {
        icon: 'i-lucide-pen-tool',
        title: 'Deep annotation tools',
        description: 'Highlight, underline, strikeout, draw, stamp, and add threaded comments.',
    },
    {
        icon: 'i-lucide-scissors-square-dashed-bottom',
        title: 'Page operations',
        description: 'Delete, extract, reorder, rotate, merge, and capture selected page regions.',
    },
    {
        icon: 'i-lucide-layout-panel-left',
        title: 'Workspace management',
        description: 'Use tabs, split-panel layout, bookmarks, and persistent state across sessions.',
    },
    {
        icon: 'i-lucide-folder-output',
        title: 'Multiple export targets',
        description: 'Export results as PDF, PNG, JPG, TIFF, and DOCX with annotations preserved.',
    },
];

const workflowSteps = [
    {
        title: 'Load',
        body: 'Open PDF, DjVu, or images and prepare the document set in tabs or split panels.',
    },
    {
        title: 'Review',
        body: 'Navigate quickly with thumbnails, outlines, search, and keyboard shortcuts.',
    },
    {
        title: 'Edit',
        body: 'Apply OCR, annotate pages, and perform batch page operations on selected ranges.',
    },
    {
        title: 'Export',
        body: 'Generate final files in the format required by your workflow and archive pipeline.',
    },
];

const platformRows = [
    {
        os: 'macOS',
        architectures: 'x64, arm64',
        installerTypes: 'DMG, ZIP',
    },
    {
        os: 'Windows',
        architectures: 'x64, arm64',
        installerTypes: 'NSIS setup EXE',
    },
    {
        os: 'Linux',
        architectures: 'x64, arm64',
        installerTypes: 'AppImage, DEB',
    },
];

useSeoMeta({
    title: 'Features',
    ogTitle: 'EVB Viewer Features',
    ogDescription: 'Detailed capabilities of EVB Viewer for PDF and DjVu workflows.',
});
</script>

<template>
  <div>
    <section class="page-intro section-reveal">
      <UBadge
        label="Feature overview"
        color="primary"
        variant="subtle"
      />
      <h1 class="page-title">
        Built for long-form, high-volume document workflows.
      </h1>
      <p class="page-subtitle">
        EVB Viewer focuses on practical productivity: read, OCR, annotate, and export without
        moving between multiple tools.
      </p>
    </section>

    <section class="content-section section-reveal section-delay-1">
      <div class="section-head">
        <h2>Core capabilities</h2>
        <p>Everything needed for daily PDF and DjVu operations on desktop.</p>
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
        <h2>Workflow model</h2>
        <p>A simple sequence from intake to final export.</p>
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
        <h2>Platform matrix</h2>
        <p>Installer availability by operating system.</p>
      </div>

      <UCard class="table-card">
        <div class="table-wrap">
          <table class="platform-table">
            <thead>
              <tr>
                <th scope="col">
                  Operating system
                </th>
                <th scope="col">
                  Architectures
                </th>
                <th scope="col">
                  Installer types
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
