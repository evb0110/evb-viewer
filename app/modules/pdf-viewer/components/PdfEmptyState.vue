<template>
    <div class="empty-state">
        <PdfOpenBatchProgress
            v-if="openBatchProgress"
            :progress="openBatchProgress"
        />

        <div v-else class="start-shell">
            <aside class="start-rail" :aria-label="t('emptyState.start')">
                <nav class="rail-section" :aria-label="t('emptyState.start')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'recent' }"
                        :aria-current="activeSection === 'recent' ? 'page' : undefined"
                        @click="setActiveSection('recent')"
                    >
                        <UIcon name="i-ph-clock" class="rail-item-icon" />
                        <span>{{ t('emptyState.recentFiles') }}</span>
                        <span v-if="recentFiles.length > 0" class="rail-count">{{ recentFiles.length }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('menu.file')">
                    <button
                        v-if="canCombineFiles"
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'combine' }"
                        :aria-current="activeSection === 'combine' ? 'page' : undefined"
                        :disabled="openInProgress"
                        @click="setActiveSection('combine')"
                    >
                        <UIcon name="i-ph-stack-plus" class="rail-item-icon" />
                        <span>{{ t('dialogs.combineFiles') }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('emptyState.workspace')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'settings' }"
                        :aria-current="activeSection === 'settings' ? 'page' : undefined"
                        @click="setActiveSection('settings')"
                    >
                        <UIcon name="i-ph-gear" class="rail-item-icon" />
                        <span>{{ t('toolbar.settings') }}</span>
                    </button>
                </nav>
            </aside>

            <main class="start-main">
                <template v-if="activeSection === 'recent'">
                    <section class="start-open-panel" :aria-labelledby="openPanelButtonId">
                        <span class="open-panel-art" aria-hidden="true">
                            <FileTypeIcon kind="document" class="open-panel-art-icon" />
                        </span>
                        <span class="open-panel-copy">
                            <span>{{ t('emptyState.openSubtitle') }}</span>
                        </span>
                        <UButton
                            :id="openPanelButtonId"
                            class="open-panel-cta"
                            color="primary"
                            icon="i-ph-folder-open"
                            :label="t('emptyState.openFileEllipsis')"
                            :loading="openInProgress"
                            :disabled="openInProgress"
                            :aria-label="t('toolbar.openPdf')"
                            @click="openFile"
                        />
                    </section>

                    <StartRecentFiles
                        v-model:search="recentSearch"
                        :recent-files="recentFiles"
                        :recent-files-resolved="recentFilesResolved"
                        :recent-files-error="recentFilesError"
                        :open-in-progress="openInProgress"
                        :is-recent-open-ready="isRecentOpenReady"
                        @press-recent="emit('press-recent', $event)"
                        @open-recent="(file, pressed) => emit('open-recent', file, pressed)"
                        @remove-recent="emit('remove-recent', $event)"
                        @reveal-recent="emit('reveal-recent', $event)"
                        @clear-recent="emit('clear-recent')"
                        @retry-recent="emit('retry-recent')"
                    />
                </template>

                <CombinePdfPage
                    v-else-if="activeSection === 'combine'"
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    :show-header="false"
                    :open-result="openCombineResult"
                    @close="setActiveSection('recent')"
                />
                <SettingsPage
                    v-else
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    :show-header="false"
                    @close="setActiveSection('recent')"
                />
            </main>
        </div>

    </div>
</template>

<script setup lang="ts">
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import SettingsPage from '@app/components/settings/SettingsPage.vue';
import type { TStartSection } from '@app/types/startSection';
import PdfOpenBatchProgress from '@app/modules/pdf-viewer/components/PdfOpenBatchProgress.vue';
import StartRecentFiles from '@app/modules/pdf-viewer/components/StartRecentFiles.vue';
import type { IPdfOpenBatchProgress } from '@app/modules/pdf-viewer/runtime/contracts/pdfOpenBatchProgress.types';

// User-initiated surface: stays out of the startup chunk and loads on first open,
// matching the split policy documented in warmupDesktopViewerChunks.ts.
const CombinePdfPage = defineAsyncComponent(
    () => import('@app/modules/combine/public').then(module => module.CombinePdfPage),
);

const {
    recentFiles,
    recentFilesResolved = true,
    recentFilesError = null,
    openBatchProgress = null,
    openInProgress = false,
    isRecentOpenReady = () => true,
    canCombineFiles = false,
    startSection = 'recent',
    openCombineResult = undefined,
} = defineProps<{
    recentFiles: IRecentFile[];
    recentFilesResolved?: boolean | undefined;
    recentFilesError?: string | null | undefined;
    openBatchProgress?: IPdfOpenBatchProgress | null | undefined;
    openInProgress?: boolean | undefined;
    isRecentOpenReady?: ((file: IRecentFile) => boolean) | undefined;
    canCombineFiles?: boolean | undefined;
    startSection?: TStartSection | undefined;
    openCombineResult?: (result: TOpenFileResult) => Promise<boolean>;
}>();
const emit = defineEmits<{
    'update:start-section': [section: TStartSection];
    'open-file': [];
    'press-recent': [file: IRecentFile];
    'open-recent': [file: IRecentFile, pressed: boolean];
    'remove-recent': [file: IRecentFile];
    'reveal-recent': [file: IRecentFile];
    'clear-recent': [];
    'retry-recent': [];
}>();
const { t } = useTypedI18n();
const openPanelButtonId = useId();
const activeSection = ref<TStartSection>(startSection);
const recentSearch = ref('');

function openFile() {
    emit('open-file');
}

function setActiveSection(section: TStartSection) {
    activeSection.value = section;
    emit('update:start-section', section);
}

watch(() => startSection, (section) => {
    activeSection.value = section;
}, { immediate: true });

</script>

<style lang="scss" scoped>
/* A phone or tablet shows Start as one page that scrolls: the recent list
   takes the height of its rows instead of a box of its own that scrolls inside
   the page, which on a phone is a sliver with a second scrollbar. */
@mixin start-single-scroll {
    .start-shell {
        height: auto;
        min-height: 100%;
    }

    .start-main {
        height: auto;
        flex: 0 0 auto;
        overflow: visible;
    }
}

.empty-state {
    width: 100%;
    height: 100%;

    /* The critical shell centres this box; once Start is taller than the
       pane, plain centring would push its top out of scroll reach. */
    align-items: safe center;
    overflow: hidden auto;
    background: var(--app-start-bg);
    color: var(--ui-text);
    container-type: inline-size;
}

.start-shell {
    display: grid;
    grid-template-columns: var(--app-start-shell-rail-width) minmax(0, 1fr);
    gap: var(--app-start-shell-gap);
    width: 100%;
    max-width: var(--app-content-width-2xl);

    /* A phone, especially in landscape, has less height than the open panel
       and a usable recent list need, so Start scrolls instead of crushing the list. */
    height: max(100%, var(--app-start-shell-min-height));
    min-height: 0;
    margin: 0 auto;
    padding: var(--app-start-shell-padding);
}

.start-rail {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-rail-gap);
    padding: var(--app-start-rail-padding);
}

.rail-section {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-rail-section-gap);
}

.rail-item {
    display: flex;
    align-items: center;
    gap: var(--app-start-rail-item-gap);
    width: 100%;
    height: var(--app-start-rail-item-height);
    padding: 0 var(--app-start-rail-item-padding-x);
    border: 1px solid transparent;
    border-radius: var(--app-start-rail-item-radius);
    background: transparent;
    color: var(--app-start-rail-item-fg);
    font-size: var(--app-start-rail-item-font-size);
    font-weight: var(--app-font-weight-medium);
    text-align: left;
    cursor: pointer;
    transition:
        background-color var(--app-transition-quick),
        border-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

.rail-item span:not(.rail-count) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

@media (hover: hover) {
    .rail-item:hover:not(.is-active, :disabled) {
        background: var(--app-start-rail-item-hover-bg);
        color: var(--app-start-rail-item-active-fg);
    }
}

.rail-item.is-active {
    background: var(--app-start-rail-item-active-bg);
    border-color: var(--app-start-rail-item-active-border);
    color: var(--app-start-rail-item-active-fg);
}

@media (hover: hover) {
    .rail-item.is-active:hover:not(:disabled) {
        background: var(--app-start-rail-item-active-hover-bg);
    }
}

.rail-item:disabled {
    opacity: var(--app-opacity-muted);
    cursor: default;
}

.rail-item-icon {
    width: var(--app-start-rail-item-icon-size);
    height: var(--app-start-rail-item-icon-size);
    flex: 0 0 auto;
    color: currentcolor;
    opacity: 1;
}

.rail-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--app-start-rail-badge-size);
    height: var(--app-start-rail-badge-size);
    margin-left: auto;
    padding: 0 var(--app-start-rail-badge-padding-x);
    border-radius: var(--app-radius-full);
    border: 1px solid transparent;
    background: var(--app-start-rail-item-hover-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-start-rail-badge-font-size);
    font-weight: var(--app-font-weight-semibold);
    line-height: var(--app-line-height-tight);
}

.rail-item.is-active .rail-count {
    border-color: var(--app-start-rail-item-active-border);
}

.start-main {
    display: flex;
    flex-direction: column;
    gap: var(--app-start-main-gap);
    min-width: 0;
    height: 100%;
    min-height: 0;
}

.start-tool-page {
    --app-tool-page-padding: 0;

    height: 100%;
    min-height: 0;
}

.start-open-panel {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--app-start-panel-gap);
    width: 100%;
    padding: var(--app-start-panel-padding);
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-start-panel-radius);
    background: var(--app-start-card-bg);
    color: var(--ui-text);
    flex: 0 0 auto;
}

.open-panel-art {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-document-icon-width);
    height: var(--app-document-icon-height);
    flex: 0 0 auto;
}

.open-panel-art-icon {
    width: 100%;
    height: 100%;
}

.open-panel-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--app-start-panel-copy-gap);
    min-width: 0;
    flex: 1 1 auto;
}

.open-panel-copy span {
    color: var(--ui-text-muted);
    font-size: var(--app-start-panel-copy-font-size);
}

.open-panel-cta {
    flex: 0 0 auto;
    min-width: var(--app-start-cta-min-width);
}

@container (max-width: 880px) {
    .start-shell {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
        gap: var(--app-start-responsive-gap);
    }

    .start-rail {
        flex-flow: row nowrap;
        align-items: center;
        gap: var(--app-start-responsive-rail-gap);
        padding: var(--app-start-responsive-rail-padding);
        min-width: 0;
    }

    .rail-section {
        flex: 0 1 auto;
        min-width: 0;
    }

    .rail-item {
        width: auto;
        min-width: 0;
    }

    .rail-count {
        margin-left: var(--app-start-responsive-rail-gap);
        flex: 0 0 auto;
    }
}

@container (max-width: 640px) {
    .start-shell {
        padding: var(--app-space-3xl);
    }

    .start-rail {
        align-items: stretch;
    }

    .rail-section {
        flex: 1 1 0;
    }

    .rail-item {
        position: relative;
        flex-direction: column;
        justify-content: center;
        gap: var(--app-space-sm);
        width: 100%;
        height: 100%;
        min-height: calc(var(--app-control-height-md) * 2);
        padding: var(--app-space-3xl) var(--app-space-sm);
    }

    .rail-item span:not(.rail-count) {
        overflow: visible;
        font-size: var(--app-text-size-caption);
        text-align: center;
        text-overflow: clip;
        white-space: normal;
    }

    .rail-count {
        position: absolute;
        inset-block-start: var(--app-space-sm);
        inset-inline-end: var(--app-space-sm);
    }

    .start-open-panel {
        flex-direction: column;
        align-items: stretch;
        padding: var(--app-start-responsive-panel-padding);
        gap: var(--app-start-responsive-panel-gap);
        text-align: center;
    }

    .open-panel-art {
        align-self: center;
    }

    .open-panel-copy {
        align-items: center;
    }

    .open-panel-cta {
        width: 100%;
        justify-content: center;
    }

    @include start-single-scroll;
}

@media (pointer: coarse) {
    @include start-single-scroll;
}
</style>
