<template>
    <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
        <UButton
            icon="i-lucide-scan-text"
            variant="ghost"
            color="neutral"
            :disabled="disabled"
        >
            <span>OCR</span>
        </UButton>

        <template #content>
            <div class="ocr-popup">
                <div class="ocr-popup__header">
                    <span class="ocr-popup__title">Run OCR</span>
                </div>

                <div class="ocr-popup__divider" />

                <!-- Page Range Selection -->
                <div class="ocr-popup__section">
                    <div class="ocr-popup__label">Pages</div>
                    <div class="ocr-popup__radios">
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="all"
                            >
                            <span>All pages ({{ totalPages }})</span>
                        </label>
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="current"
                            >
                            <span>Current page ({{ currentPage }})</span>
                        </label>
                        <label class="ocr-popup__radio">
                            <input
                                v-model="settings.pageRange"
                                type="radio"
                                name="pageRange"
                                value="custom"
                            >
                            <span>Custom range</span>
                        </label>
                    </div>
                    <UInput
                        v-if="settings.pageRange === 'custom'"
                        v-model="settings.customRange"
                        placeholder="e.g., 1-5, 8, 10-12"
                        size="sm"
                        class="ocr-popup__custom-input"
                    />
                </div>

                <div class="ocr-popup__divider" />

                <!-- DPI Selection -->
                <div class="ocr-popup__section">
                    <div class="ocr-popup__label">Quality</div>
                    <div class="ocr-popup__radios">
                        <label class="ocr-popup__radio">
                            <input
                                v-model.number="settings.renderDpi"
                                type="radio"
                                name="dpi"
                                :value="300"
                            >
                            <span>Standard (300 DPI) <span class="ocr-popup__badge">Recommended</span></span>
                        </label>
                    </div>

                    <!-- Advanced DPI Options -->
                    <button
                        type="button"
                        class="ocr-popup__advanced-toggle"
                        @click="showAdvancedDpi = !showAdvancedDpi"
                    >
                        <UIcon :name="showAdvancedDpi ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4" />
                        Advanced
                    </button>

                    <Transition name="ocr-advance">
                        <div v-if="showAdvancedDpi" class="ocr-popup__advanced-options">
                            <label class="ocr-popup__radio">
                                <input
                                    v-model.number="settings.renderDpi"
                                    type="radio"
                                    name="dpi"
                                    :value="144"
                                >
                                <span>Low (144 DPI) - Fast, lower accuracy</span>
                            </label>
                            <label class="ocr-popup__radio">
                                <input
                                    v-model.number="settings.renderDpi"
                                    type="radio"
                                    name="dpi"
                                    :value="432"
                                >
                                <span>High (432 DPI) - Degraded scans</span>
                            </label>
                            <div class="ocr-popup__custom-dpi">
                                <label class="ocr-popup__label" style="margin-bottom: 0.25rem">Custom DPI</label>
                                <input
                                    v-model.number="customDpi"
                                    type="number"
                                    placeholder="300"
                                    min="72"
                                    max="600"
                                    class="ocr-popup__custom-dpi-input"
                                    @blur="applyCustomDpi"
                                >
                            </div>
                        </div>
                    </Transition>
                </div>

                <div class="ocr-popup__divider" />

                <!-- Language Selection -->
                <div class="ocr-popup__section">
                    <div class="ocr-popup__label">Languages</div>
                    <div class="ocr-popup__languages">
                        <div
                            v-if="latinCyrillicLanguages.length > 0"
                            class="ocr-popup__lang-group"
                        >
                            <span class="ocr-popup__group-label"
                                >Latin / Cyrillic</span
                            >
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
                            v-if="rtlLanguages.length > 0"
                            class="ocr-popup__lang-group"
                        >
                            <span class="ocr-popup__group-label"
                                >RTL Scripts</span
                            >
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
                            Processing page {{ progress.currentPage }} ({{
                                progress.processedCount
                            }}/{{ progress.totalPages }})
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
                        <span>OCR complete - PDF is now searchable</span>
                    </div>
                </template>

                <div class="ocr-popup__divider" />

                <!-- Actions -->
                <div class="ocr-popup__actions">
                    <UButton
                        v-if="!progress.isRunning"
                        color="primary"
                        size="sm"
                        :disabled="settings.selectedLanguages.length === 0"
                        @click="handleRunOcr"
                    >
                        <UIcon name="i-lucide-play" class="size-4" />
                        Start OCR
                    </UButton>
                    <UButton
                        v-else
                        color="neutral"
                        variant="soft"
                        size="sm"
                        @click="handleCancel"
                    >
                        Cancel
                    </UButton>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { PDFDocumentProxy } from 'pdfjs-dist';

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
    rtlLanguages,
    loadLanguages,
    runOcr,
    cancelOcr,
    toggleLanguage,
} = useOcr();

const isOpen = ref(false);
const showAdvancedDpi = ref(false);
const customDpi = ref<number | null>(null);

function close() {
    isOpen.value = false;
}

function applyCustomDpi() {
    if (customDpi.value && customDpi.value >= 72 && customDpi.value <= 600) {
        settings.value.renderDpi = customDpi.value;
        customDpi.value = null;
    }
}

defineExpose({ close });

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
}

.ocr-popup__badge {
    display: inline-block;
    background-color: var(--ui-primary);
    color: white;
    font-size: 0.65rem;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    margin-left: 0.375rem;
    font-weight: 500;
}

.ocr-popup__advanced-toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    padding: 0.375rem 0.25rem;
    margin-top: 0.5rem;
    border: none;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: color 0.2s;
}

.ocr-popup__advanced-toggle:hover {
    color: var(--ui-text);
}

.ocr-popup__advanced-options {
    padding: 0.375rem 0.25rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-top: 1px solid var(--ui-border);
    margin-top: 0.375rem;
}

.ocr-popup__custom-dpi {
    padding-top: 0.375rem;
}

.ocr-popup__custom-dpi-input {
    width: 100%;
    padding: 0.375rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    background-color: var(--ui-bg-elevated);
    color: var(--ui-text);
}

.ocr-popup__custom-dpi-input:focus {
    outline: none;
    border-color: var(--ui-primary);
    box-shadow: 0 0 0 2px var(--ui-primary-alpha);
}

/* Transition animations */
.ocr-advance-enter-active,
.ocr-advance-leave-active {
    transition: all 0.2s ease;
}

.ocr-advance-enter-from {
    opacity: 0;
    max-height: 0;
}

.ocr-advance-leave-to {
    opacity: 0;
    max-height: 0;
}
</style>
