<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            :tool="tool"
            @set-tool="setTool"
        />

        <div v-if="tool !== 'note'" class="annotation-tool-options">
            <UCheckbox
                v-model="keepActiveModel"
                color="neutral"
                size="xs"
                :label="t('annotations.keepActive')"
            />
        </div>

        <div class="notes-panel-divider" />

        <section
            v-if="isVisible"
            class="annotation-properties-inline"
            :aria-label="propertiesLabel"
            data-annotation-inspector
            data-testid="annotation-inspector"
            :data-target="propertySelection.length > 0 ? 'selection' : 'defaults'"
        >
            <h3 class="annotation-properties-title">{{ propertiesLabel }}</h3>
            <PdfAnnotationStyleEditor
                :tool="tool"
                :settings="settings"
                :selected-annotations="propertySelection"
                @update-setting="emit('update-setting', $event)"
                @update-properties="emit('update-properties', $event)"
            />
        </section>

        <PdfAnnotationCommentsList
            :comments="comments"
            :status="commentsStatus"
            :inventory="inventory"
            :enrichment-state="enrichmentState"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="focusComment"
            @edit-text-box="emit('edit-text-box', $event)"
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
    IAnnotationPropertyUpdate,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { PENDING_ANNOTATION_ENRICHMENT_STATE } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';
import PdfAnnotationStyleEditor from '@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue';
import PdfAnnotationToolbar from '@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';

interface IProps {
    tool: TAnnotationTool;
    isVisible?: boolean | undefined;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    commentsStatus: TAnnotationCommentsStatus;
    inventory?: IAnnotationInventoryCompleteness | null | undefined;
    enrichmentState?: IAnnotationEnrichmentState | undefined;
    selectedAnnotations?: readonly AnnotationEntity[];
}

const { settings: appSettings } = useSettings();
const { t } = useTypedI18n();

const {
    keepActive,
    isVisible = true,
    tool,
    settings,
    comments,
    commentsStatus,
    inventory = null,
    enrichmentState = PENDING_ANNOTATION_ENRICHMENT_STATE,
    selectedAnnotations = [],
} = defineProps<IProps>();
const propertySelection = computed(() => tool === 'select' || tool === 'none' ? selectedAnnotations : []);
const propertiesLabel = computed(() => propertySelection.value.length > 0
    ? t('annotations.selectedProperties')
    : t('annotations.toolDefaults'));
const activeCommentStableKey = computed(() => {
    const selectedId = selectedAnnotations[0]?.identity.id;
    const comment = selectedId ? comments.find(comment => comment.appAnnotationId === selectedId) : undefined;
    return comment ? annotationIdForSummary(comment) : undefined;
});

const emit = defineEmits<{
    'set-tool': [tool: TAnnotationTool];
    'update-properties': [updates: IAnnotationPropertyUpdate];
    'update:keep-active': [value: boolean];
    'update-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }];
    'focus-comment': [comment: IAnnotationCommentSummary];
    'edit-text-box': [comment: IAnnotationCommentSummary];
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

function setTool(nextTool: TAnnotationTool) {
    emit('set-tool', nextTool);
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

.annotation-properties-inline {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    padding-block: var(--app-sidebar-content-padding);
    border-bottom: 1px solid var(--ui-border);
}

.annotation-properties-title {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: 600;
}
</style>
