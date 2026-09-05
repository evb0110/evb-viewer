<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            ref="toolbarRef"
            :tool="tool"
            :style-popover-open="stylePopoverOpen"
            @set-tool="setTool"
        />

        <div class="annotation-tool-options">
            <UCheckbox
                v-model="keepActiveModel"
                color="neutral"
                size="xs"
                :label="t('annotations.keepActive')"
            />
        </div>

        <div class="notes-panel-divider" />

        <div
            v-if="showStyleEditor"
            class="annotation-style-editor-cache"
            aria-hidden="true"
        >
            <PdfAnnotationStyleEditor
                :tool="styleTool"
                :settings="settings"
                :selected-text-box="selectedTextBox"
                @set-tool="setTool"
                @update-setting="updateSetting"
            />
        </div>

        <UPopover
            v-if="showStyleEditor"
            v-model:open="stylePopoverOpen"
            :reference="stylePopoverReference ?? undefined"
            :content="stylePopoverContent"
            portal="body"
        >
            <span class="style-popover-virtual-trigger" aria-hidden="true" />

            <template #content>
                <div
                    class="annotation-style-popover app-floating-scroll-region app-scrollbar app-scroll-region--balanced"
                    role="dialog"
                    :aria-label="stylePopoverLabel"
                >
                    <div class="annotation-style-popover-header">
                        <span class="annotation-style-popover-title">{{ stylePopoverLabel }}</span>
                        <UButton
                            type="button"
                            class="annotation-style-popover-close"
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-x"
                            :aria-label="t('annotationProperties.close', undefined)"
                            @click="stylePopoverOpen = false"
                        />
                    </div>

                    <PdfAnnotationStyleEditor
                        :tool="styleTool"
                        :settings="settings"
                        :selected-text-box="selectedTextBox"
                        @set-tool="setTool"
                        @update-setting="updateSetting"
                        @color-selected="stylePopoverOpen = false"
                    />
                </div>
            </template>
        </UPopover>

        <PdfAnnotationCommentsList
            :comments="comments"
            :status="commentsStatus"
            :inventory="inventory"
            :enrichment-state="enrichmentState"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="focusComment"
            @open-note="openNote"
            @delete-comment="deleteComment"
            @set-tool="setTool"
            @retry-enrichment="retryEnrichment"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { PENDING_ANNOTATION_ENRICHMENT_STATE } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';
import PdfAnnotationStyleEditor from '@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue';
import PdfAnnotationToolbar from '@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    commentsStatus: TAnnotationCommentsStatus;
    inventory?: IAnnotationInventoryCompleteness | null | undefined;
    enrichmentState?: IAnnotationEnrichmentState | undefined;
    activeCommentStableKey?: string | null;
    selectedTextBox?: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null;
}

interface IPdfAnnotationToolbarExpose {getButtonEl(toolId: TAnnotationTool): HTMLElement | null;}

const { settings: appSettings } = useSettings();
const { t } = useTypedI18n();

const {
    keepActive,
    tool,
    settings,
    comments,
    commentsStatus,
    inventory = null,
    enrichmentState = PENDING_ANNOTATION_ENRICHMENT_STATE,
    activeCommentStableKey: rawActiveCommentStableKey = null,
    selectedTextBox = null,
} = defineProps<IProps>();
const activeCommentStableKey = computed(() => rawActiveCommentStableKey ?? undefined);
const styleTool = computed<TAnnotationTool>(() => (
    selectedTextBox !== null && (tool === 'select' || tool === 'none') ? 'text' : tool
));
const showStyleEditor = computed(() => isAuthoringAnnotationTool(styleTool.value));
const stylePopoverOpen = ref(false);
const toolbarRef = ref<IPdfAnnotationToolbarExpose | null>(null);
const stylePopoverReference = computed(() => toolbarRef.value?.getButtonEl(styleTool.value) ?? null);
const stylePopoverContent = {
    align: 'start' as const,
    side: 'bottom' as const,
    sideOffset: 4,
    collisionPadding: 12,
};
const colorSettingKeys = new Set<keyof IAnnotationSettings>([
    'highlightColor',
    'inkColor',
    'shapeColor',
    'squigglyColor',
    'strikethroughColor',
    'textColor',
    'underlineColor',
]);
let stylePopoverReopenTimer: ReturnType<typeof setTimeout> | null = null;

const toolLabel = computed(() => {
    switch (styleTool.value) {
        case 'draw':
            return t('annotations.draw');
        case 'text':
            return t('annotations.text');
        case 'highlight':
            return t('annotations.highlight');
        case 'underline':
            return t('annotations.underline');
        case 'strikethrough':
            return t('annotations.strikethrough');
        case 'squiggly':
            return t('annotations.squiggly');
        case 'rectangle':
            return t('annotations.rectangle');
        case 'circle':
            return t('annotations.circle');
        case 'line':
            return t('annotations.line');
        case 'arrow':
            return t('annotations.arrow');
        case 'select':
            return t('annotations.select');
        default:
            return t('annotations.annotations');
    }
});
const stylePopoverLabel = computed(() => `${toolLabel.value} ${t('annotations.style')}`);

const emit = defineEmits<{
    'set-tool': [tool: TAnnotationTool];
    'update:keep-active': [value: boolean];
    'update-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }];
    'focus-comment': [comment: IAnnotationCommentSummary];
    'open-note': [comment: IAnnotationCommentSummary];
    'delete-comment': [comment: IAnnotationCommentSummary];
    'retry-enrichment': [];
}>();

const keepActiveModel = computed({
    get() {
        return keepActive;
    },
    set(value: boolean | 'indeterminate') {
        if (value === 'indeterminate' || value === keepActive) {
            return;
        }
        emit('update:keep-active', value);
    },
});

function clearStylePopoverReopenTimer() {
    if (stylePopoverReopenTimer === null) {
        return;
    }
    clearTimeout(stylePopoverReopenTimer);
    stylePopoverReopenTimer = null;
}

watch(() => [
    tool,
    selectedTextBox,
], async () => {
    clearStylePopoverReopenTimer();
    if (!showStyleEditor.value) {
        stylePopoverOpen.value = false;
        return;
    }

    await nextTick();
    stylePopoverOpen.value = true;
});

watch(() => commentsStatus, (status) => {
    if (status === 'loading') {
        clearStylePopoverReopenTimer();
        stylePopoverOpen.value = false;
    }
});

onBeforeUnmount(clearStylePopoverReopenTimer);

function setTool(nextTool: TAnnotationTool) {
    emit('set-tool', nextTool === tool ? 'none' : nextTool);
}

function updateSetting(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings];
}) {
    emit('update-setting', payload);
    if (showStyleEditor.value && !colorSettingKeys.has(payload.key)) {
        clearStylePopoverReopenTimer();
        stylePopoverReopenTimer = setTimeout(() => {
            stylePopoverReopenTimer = null;
            if (showStyleEditor.value) {
                stylePopoverOpen.value = true;
            }
        });
    }
}

function focusComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
}

function openNote(comment: IAnnotationCommentSummary) {
    emit('open-note', comment);
}

function deleteComment(comment: IAnnotationCommentSummary) {
    emit('delete-comment', comment);
}

function retryEnrichment() {
    emit('retry-enrichment');
}
</script>

<style scoped>
.notes-panel {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-content-padding);
    min-height: 0;
    height: 100%;
    overflow: visible;
    box-sizing: border-box;
    position: relative;
}

.notes-panel-divider {
    border-top: 1px solid var(--ui-border);
    margin: 0 -0.25rem;
}

.annotation-tool-options {
    display: flex;
    align-items: center;
    min-height: var(--app-control-height-xs);
}

.style-popover-virtual-trigger {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
}

.annotation-style-editor-cache {
    position: absolute;
    width: var(--app-divider-width);
    height: var(--app-hairline-height);
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
}

.annotation-style-popover {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    position: relative;
    z-index: var(--app-pdf-annotation-style-popover-z-index);
    width: min(var(--app-pdf-annotation-style-popover-width), var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    padding: var(--app-sidebar-content-padding);
    border: 1px solid var(--ui-border);
    border-radius: 0.625rem;
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

.annotation-style-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-sidebar-row-gap);
}

.annotation-style-popover-title {
    color: var(--ui-text-highlighted);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: 700;
    letter-spacing: 0.03em;
    line-height: 1.2;
    text-transform: uppercase;
}

.annotation-style-popover-close {
    flex: 0 0 auto;
}
</style>
