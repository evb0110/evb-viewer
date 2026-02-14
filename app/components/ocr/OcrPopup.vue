<template>
    <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
        <UTooltip :text="t('ocr.button')" :delay-duration="1200">
            <UButton
                icon="i-lucide-scan-text"
                variant="ghost"
                color="neutral"
                :disabled="disabled"
                :aria-label="t('ocr.button')"
            />
        </UTooltip>

        <template #content>
            <div class="ocr-popup">
                <div class="ocr-popup__header">
                    <span class="ocr-popup__title">{{ t('ocr.runTitle') }}</span>
                </div>

                <div class="ocr-popup__divider" />

                <!-- Page Range Selection -->
                <div class="ocr-popup__section">
                    <div class="ocr-popup__label">{{ t('ocr.pages') }}</div>
                    <div class="ocr-popup__radios">
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="all"
                            >
                            <span>{{ t('ocr.allPages', { total: totalPages }) }}</span>
                        </label>
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="current"
                            >
                            <span>{{ t('ocr.currentPage', { page: currentPage }) }}</span>
                        </label>
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="custom"
                            >
                            <span>{{ t('ocr.customRange') }}</span>
                        </label>
                    </div>
                    <UInput
                        v-if="settings.pageRange === 'custom'"
                        v-model="settings.customRange"
                        :placeholder="t('ocr.customRangePlaceholder')"
                        size="sm"
                        class="ocr-popup__custom-input"
                    />
                </div>

                <!-- Language Selection -->
                <div class="ocr-popup__section">
                    <div class="ocr-popup__label">{{ t('ocr.languages') }}</div>
                    <div class="ocr-popup__languages">
                        <div
                            v-if="latinCyrillicLanguages.length > 0"
                            class="ocr-popup__lang-group"
                        >
                            <span class="ocr-popup__group-label">{{ t('ocr.latinCyrillic') }}</span>
                            <div class="ocr-popup__checkboxes">
                                <label
                                    v-for="lang in latinCyrillicLanguages"
                                    :key="lang.code"
                                    class="ocr-popup__checkbox"
                                >
                                    <input
                                        type="checkbox"
                                        :checked="
                                            settings.selectedLanguages.includes(
                                                lang.code,
                                            )
                                        "
                                        @change="
                                            toggleLanguage(
                                                lang.code,
                                                ($event.target as HTMLInputElement)
                                                    .checked,
                                            )
                                        "
                                    >
                                    <span>{{ lang.name }}</span>
                                </label>
                            </div>
                        </div>
                        <div
                            v-if="greekLanguages.length > 0"
                            class="ocr-popup__lang-group"
                        >
                            <span class="ocr-popup__group-label">{{ t('ocr.greek') }}</span>
                            <div class="ocr-popup__checkboxes">
                                <label
                                    v-for="lang in greekLanguages"
                                    :key="lang.code"
                                    class="ocr-popup__checkbox"
                                >
                                    <input
                                        type="checkbox"
                                        :checked="
                                            settings.selectedLanguages.includes(
                                                lang.code,
                                            )
                                        "
                                        @change="
                                            toggleLanguage(
                                                lang.code,
                                                ($event.target as HTMLInputElement)
                                                    .checked,
                                            )
                                        "
                                    >
                                    <span>{{ lang.name }}</span>
                                </label>
                            </div>
                        </div>
                        <div
                            v-if="rtlLanguages.length > 0"
                            class="ocr-popup__lang-group"
                        >
                            <span class="ocr-popup__group-label">{{ t('ocr.rtlScripts') }}</span>
                            <div class="ocr-popup__checkboxes">
                                <label
                                    v-for="lang in rtlLanguages"
                                    :key="lang.code"
                                    class="ocr-popup__checkbox"
                                >
                                    <input
                                        type="checkbox"
                                        :checked="
                                            settings.selectedLanguages.includes(
                                                lang.code,
                                            )
                                        "
                                        @change="
                                            toggleLanguage(
                                                lang.code,
                                                ($event.target as HTMLInputElement)
                                                    .checked,
                                            )
                                        "
                                    >
                                    <span>{{ lang.name }}</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Progress Display -->
                <template v-if="progress.isRunning">
                    <div class="ocr-popup__divider" />
                    <div class="ocr-popup__progress">
                        <UProgress :value="progressPercent" />
                        <span class="ocr-popup__progress-text">
                            <template v-if="progress.phase === 'preparing'">
                                {{ t('ocr.preparing') }}
                            </template>
                            <template v-else>
                                {{
                                    t('ocr.processingPage', {
                                        page: progress.currentPage,
                                        processed: progress.processedCount,
                                        total: progress.totalPages,
                                    })
                                }}
                            </template>
                        </span>
                    </div>
                </template>

                <!-- Error Display -->
                <template v-if="error">
                    <div class="ocr-popup__divider" />
                    <div class="ocr-popup__error">
                        <UIcon name="i-lucide-alert-circle" class="size-4" />
                        <span>{{ error }}</span>
                    </div>
                </template>

                <!-- Results Summary -->
                <template v-if="hasResults && !progress.isRunning">
                    <div class="ocr-popup__divider" />
                    <div class="ocr-popup__results">
                        <UIcon name="i-lucide-check-circle" class="size-4" />
                        <span>{{ t('ocr.complete') }}</span>
                    </div>
                </template>

                <div class="ocr-popup__divider" />

                <!-- Actions -->
                <div class="ocr-popup__actions">
                    <UTooltip :text="t('ocr.exportDocx')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-file-text"
                            variant="ghost"
                            color="neutral"
                            size="sm"
                            :loading="isExporting"
                            :disabled="isExporting || progress.isRunning || !workingCopyPath"
                            :aria-label="t('ocr.exportDocx')"
                            @click="handleExportDocx"
                        />
                    </UTooltip>
                    <UTooltip
                        v-if="!progress.isRunning"
                        :text="t('ocr.start')"
                        :delay-duration="1200"
                    >
                        <UButton
                            icon="i-lucide-play"
                            color="primary"
                            size="sm"
                            :disabled="settings.selectedLanguages.length === 0"
                            :aria-label="t('ocr.start')"
                            @click="handleRunOcr"
                        />
                    </UTooltip>
                    <UTooltip
                        v-else
                        :text="t('ocr.cancel')"
                        :delay-duration="1200"
                    >
                        <UButton
                            icon="i-lucide-x"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            :aria-label="t('ocr.cancel')"
                            @click="handleCancel"
                        />
                    </UTooltip>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { PDFDocumentProxy } from 'pdfjs-dist';

const { t } = useI18n();

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    pdfData: Uint8Array | null;
    currentPage: number;
    totalPages: number;
    workingCopyPath: string | null;
    disabled?: boolean;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'open'): void;
    (e: 'ocrComplete', pdfData: Uint8Array): void;
}>();

const {
    settings,
    progress,
    results,
    error,
    hasResults,
    progressPercent,
    latinCyrillicLanguages,
    greekLanguages,
    rtlLanguages,
    loadLanguages,
    runOcr,
    cancelOcr,
    toggleLanguage,
    exportDocx,
    isExporting,
} = useOcr();

const isOpen = ref(false);

function close() {
    isOpen.value = false;
}

function open() {
    isOpen.value = true;
}

function exportDocxFromToolbar() {
    return exportDocx(props.workingCopyPath, props.pdfDocument);
}

defineExpose({
    close,
    open,
    exportDocx: exportDocxFromToolbar,
    isExporting,
});

watch(isOpen, (value) => {
    if (value) {
        emit('open');
        loadLanguages();
    }
});

function handleRunOcr() {
    if (!props.pdfDocument || !props.pdfData) {
        return;
    }
    runOcr(props.pdfDocument, props.pdfData, props.currentPage, props.totalPages, props.workingCopyPath);
}

function handleCancel() {
    cancelOcr();
}

function handleExportDocx() {
    void exportDocx(props.workingCopyPath, props.pdfDocument);
}

// Emit when OCR completes with PDF data
watch(() => results.value.searchablePdfData, (pdfData) => {
    if (pdfData) {
        emit('ocrComplete', pdfData);
    }
});
</script>

<style scoped>
.ocr-popup {
    padding: 0.25rem;
    min-width: 16rem;
    max-width: 20rem;
}

.ocr-popup__header {
    padding: 0.5rem 0.75rem 0.25rem;
}

.ocr-popup__title {
    font-weight: 600;
    font-size: 0.875rem;
}

.ocr-popup__section {
    padding: 0.25rem 0.75rem;
}

.ocr-popup__label {
    font-size: 0.6875rem;
    color: var(--ui-text-muted);
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.ocr-popup__divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.ocr-popup__radios {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
}

.ocr-popup__radio {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    cursor: pointer;
}

.ocr-popup__radio input {
    accent-color: var(--ui-primary);
}

.ocr-popup__custom-input {
    margin-top: 0.5rem;
}

.ocr-popup__languages {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.ocr-popup__lang-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}

.ocr-popup__group-label {
    font-size: 0.625rem;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.ocr-popup__checkboxes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.25rem 0.5rem;
    padding-left: 0.25rem;
}

.ocr-popup__checkbox {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    cursor: pointer;
}

.ocr-popup__checkbox input {
    accent-color: var(--ui-primary);
}

.ocr-popup__progress {
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
}

.ocr-popup__progress-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    text-align: center;
}

.ocr-popup__error {
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ui-error);
    font-size: 0.75rem;
}

.ocr-popup__results {
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ui-success);
    font-size: 0.75rem;
}

.ocr-popup__actions {
    padding: 0.25rem 0.75rem 0.5rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
}
</style>
