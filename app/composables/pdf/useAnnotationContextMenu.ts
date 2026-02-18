import {
    ref,
    computed,
} from 'vue';
import type { TTranslateFn } from '@app/i18n/locales';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

interface IAnnotationContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

export const useAnnotationContextMenu = (deps: {t: TTranslateFn;}) => {
    const { t } = deps;
    const { clampToViewport } = useContextMenuPosition();

    const annotationContextMenu = ref<IAnnotationContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        comment: null,
        hasSelection: false,
        selectionText: '',
        pageNumber: null,
        pageX: null,
        pageY: null,
    });

    const annotationContextMenuStyle = computed(() => ({
        left: `${annotationContextMenu.value.x}px`,
        top: `${annotationContextMenu.value.y}px`,
    }));

    const annotationContextMenuCanCopy = computed(() => {
        const text = annotationContextMenu.value.comment?.text?.trim();
        return Boolean(text);
    });

    const annotationContextMenuCanCopySelection = computed(() => (
        annotationContextMenu.value.selectionText.trim().length > 0
    ));

    const annotationContextMenuCanCreateFree = computed(() => (
        Number.isFinite(annotationContextMenu.value.pageNumber)
        && Number.isFinite(annotationContextMenu.value.pageX)
        && Number.isFinite(annotationContextMenu.value.pageY)
    ));

    const contextMenuAnnotationLabel = computed(() => {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return t('annotations.annotationLabel');
        }
        return comment.kindLabel ?? comment.subtype ?? t('annotations.annotationLabel');
    });

    const contextMenuDeleteActionLabel = computed(() => {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return t('annotations.delete');
        }

        const subtype = (comment.subtype ?? '').trim().toLowerCase();
        const kind = comment.kindLabel?.trim() ?? '';
        const isMarkup = (
            subtype === 'highlight'
            || subtype === 'underline'
            || subtype === 'strikeout'
            || subtype === 'squiggly'
        );
        const hasNoteText = comment.text.trim().length > 0;
        if (!hasNoteText && isMarkup) {
            if (kind.length > 0) {
                return `${t('annotations.delete')} ${kind}`;
            }
            return `${t('annotations.delete')} ${t('annotations.annotationLabel')}`;
        }

        const isExplicitNote = comment.hasNote === true || subtype === 'popup' || subtype === 'text';
        if (isExplicitNote) {
            return `${t('annotations.delete')} ${t('annotations.stickyNoteLabel')}`;
        }
        return `${t('annotations.delete')} ${t('annotations.annotationLabel')}`;
    });

    function closeAnnotationContextMenu() {
        if (!annotationContextMenu.value.visible) {
            return;
        }
        annotationContextMenu.value = {
            visible: false,
            x: 0,
            y: 0,
            comment: null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null,
            pageX: null,
            pageY: null,
        };
    }

    function showAnnotationContextMenu(payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) {
        const hasComment = Boolean(payload.comment);
        const hasSelection = payload.hasSelection;
        const width = 258;
        const markupSectionHeight = hasSelection ? 200 : 0;
        const estimatedHeight = (hasComment ? 258 : 0) + markupSectionHeight + 132;
        const clamped = clampToViewport(payload.clientX, payload.clientY, width, estimatedHeight);

        annotationContextMenu.value = {
            visible: true,
            x: clamped.x,
            y: clamped.y,
            comment: payload.comment,
            hasSelection: payload.hasSelection,
            selectionText: payload.selectionText,
            pageNumber: payload.pageNumber,
            pageX: payload.pageX,
            pageY: payload.pageY,
        };
    }

    return {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    };
};
