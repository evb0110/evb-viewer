<template>
    <UModal
        v-model:open="open"
        title="Convert DjVu to PDF"
        :ui="{ footer: 'justify-end' }"
    >
        <template #body>
            <div class="convert-body">
                <div class="convert-info">
                    <div class="convert-info-row">
                        <span class="convert-info-label">File</span>
                        <span class="convert-info-value">{{ fileName }}</span>
                    </div>
                    <div
                        v-if="info"
                        class="convert-info-row"
                    >
                        <span class="convert-info-label">Pages</span>
                        <span class="convert-info-value">{{ info.pageCount }}</span>
                    </div>
                    <div
                        v-if="info"
                        class="convert-info-row"
                    >
                        <span class="convert-info-label">Source resolution</span>
                        <span class="convert-info-value">{{ info.sourceDpi }} DPI</span>
                    </div>
                </div>

                <div class="convert-presets">
                    <label class="convert-presets-title">Quality</label>
                    <div
                        v-for="estimate in estimates"
                        :key="estimate.subsample"
                        class="convert-preset"
                        :class="{ 'is-selected': selectedSubsample === estimate.subsample }"
                        @click="selectedSubsample = estimate.subsample"
                    >
                        <div class="convert-preset-radio">
                            <div
                                v-if="selectedSubsample === estimate.subsample"
                                class="convert-preset-radio-dot"
                            />
                        </div>
                        <div class="convert-preset-content">
                            <div class="convert-preset-label">
                                {{ estimate.label }}
                                <span class="convert-preset-dpi">{{ estimate.resultingDpi }} DPI</span>
                            </div>
                            <div class="convert-preset-description">
                                {{ estimate.description }}
                                <span v-if="estimate.estimatedBytes > 0">
                                    — ~{{ formatBytes(estimate.estimatedBytes) }}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div
                        v-if="estimatesLoading"
                        class="convert-preset-loading"
                    >
                        <UIcon
                            name="i-lucide-loader-circle"
                            class="convert-loading-spinner"
                        />
                        Estimating file sizes...
                    </div>
                </div>

                <div
                    v-if="info?.hasBookmarks"
                    class="convert-option"
                >
                    <label class="convert-checkbox-label">
                        <input
                            v-model="preserveBookmarks"
                            type="checkbox"
                        >
                        Preserve bookmarks
                    </label>
                </div>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                label="Cancel"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                label="Convert"
                color="primary"
                :disabled="estimatesLoading"
                @click="handleConvert"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import {
    ref,
    computed,
    watch,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';

const props = defineProps<{djvuPath: string | null;}>();

const emit = defineEmits<{convert: [subsample: number, preserveBookmarks: boolean];}>();

const open = defineModel<boolean>('open', { required: true });

interface IInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
}

interface IEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

const info = ref<IInfo | null>(null);
const estimates = ref<IEstimate[]>([]);
const estimatesLoading = ref(false);
const selectedSubsample = ref(1);
const preserveBookmarks = ref(true);

const fileName = computed(() => props.djvuPath?.split(/[\\/]/).pop() ?? '');

function formatBytes(bytes: number) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

watch(open, async (isOpen) => {
    if (!isOpen || !props.djvuPath) {
        return;
    }

    selectedSubsample.value = 1;
    preserveBookmarks.value = true;

    try {
        const api = getElectronAPI();

        const djvuInfo = await api.djvu.getInfo(props.djvuPath);
        info.value = djvuInfo;

        estimatesLoading.value = true;
        const sizeEstimates = await api.djvu.estimateSizes(props.djvuPath);
        estimates.value = sizeEstimates;
    } catch {
        // Silently handle errors
    } finally {
        estimatesLoading.value = false;
    }
});

function handleConvert() {
    open.value = false;
    emit('convert', selectedSubsample.value, preserveBookmarks.value);
}
</script>

<style scoped>
.convert-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.convert-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.convert-info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
}

.convert-info-label {
    color: var(--ui-text-muted);
    min-width: 120px;
}

.convert-info-value {
    color: var(--ui-text);
    font-weight: 500;
}

.convert-presets {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.convert-presets-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--ui-text);
}

.convert-preset {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s;
}

.convert-preset:hover {
    border-color: var(--ui-border-hover);
}

.convert-preset.is-selected {
    border-color: var(--ui-primary);
    background: var(--ui-bg-elevated);
}

.convert-preset-radio {
    width: 16px;
    height: 16px;
    border: 2px solid var(--ui-border);
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.convert-preset.is-selected .convert-preset-radio {
    border-color: var(--ui-primary);
}

.convert-preset-radio-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ui-primary);
}

.convert-preset-content {
    flex: 1;
}

.convert-preset-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--ui-text);
}

.convert-preset-dpi {
    color: var(--ui-text-muted);
    font-weight: 400;
    margin-left: 4px;
    font-size: 12px;
}

.convert-preset-description {
    font-size: 12px;
    color: var(--ui-text-muted);
    margin-top: 2px;
}

.convert-preset-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ui-text-muted);
    padding: 8px 0;
}

.convert-loading-spinner {
    width: 14px;
    height: 14px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.convert-option {
    padding-top: 4px;
}

.convert-checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--ui-text);
    cursor: pointer;
}
</style>
