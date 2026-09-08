import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IAnnotationContextMenuState } from '@app/types/pdfContextMenu';
import { usePositionedMenu } from '@app/composables/usePositionedMenu';
import { annotationKindLabelFromSubtype } from '@app/services/pdf/annotationSubtype';

export interface IContextMenuDeleteLabels {
    delete: string;
    deleteAnnotation: string;
    deleteImage: string;
    deleteStickyNote: string;
    deleteHighlight: string;
    deleteUnderline: string;
    deleteStrikethrough: string;
    deleteSquiggly: string;
}

interface IContextMenuDeleteComment {
    annotationKind?: IAnnotationCommentSummary['annotationKind'];
    text: string;
    subtype?: string | null | undefined;
    hasNote?: boolean;
}

type TMarkupDeleteLabel = 'deleteHighlight' | 'deleteUnderline' | 'deleteStrikethrough' | 'deleteSquiggly';

const MARKUP_DELETE_LABEL_BY_SUBTYPE: Readonly<Record<string, TMarkupDeleteLabel>> = {
    highlight: 'deleteHighlight',
    underline: 'deleteUnderline',
    strikeout: 'deleteStrikethrough',
    strikethrough: 'deleteStrikethrough',
    squiggly: 'deleteSquiggly',
};

function normalizeCommentSubtype(comment: {subtype?: string | null | undefined;}) {
    return (comment.subtype ?? '').trim().toLowerCase();
}

function resolveMarkupDeleteLabel(comment: IContextMenuDeleteComment, labels: IContextMenuDeleteLabels) {
    if (comment.text.trim().length > 0) {
        return null;
    }

    const labelKey = MARKUP_DELETE_LABEL_BY_SUBTYPE[normalizeCommentSubtype(comment)];
    return labelKey ? labels[labelKey] : null;
}

export function resolveContextMenuDeleteActionLabel(
    comment: IContextMenuDeleteComment | null,
    labels: IContextMenuDeleteLabels,
) {
    if (!comment) {
        return labels.delete;
    }

    const subtype = normalizeCommentSubtype(comment);
    if (comment.annotationKind === 'placed-image' || subtype === 'stamp') {
        return labels.deleteImage;
    }

    const markupLabel = resolveMarkupDeleteLabel(comment, labels);
    if (markupLabel) {
        return markupLabel;
    }

    const isExplicitNote = comment.annotationKind === 'note'
        || comment.hasNote === true
        || subtype === 'popup'
        || subtype === 'text';
    return isExplicitNote ? labels.deleteStickyNote : labels.deleteAnnotation;
}

export const useAnnotationContextMenu = () => {
    const { t } = useTypedI18n();

    function createInitialAnnotationContextMenuState(): IAnnotationContextMenuState {
        return {
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
    const {
        menu: annotationContextMenu,
        menuStyle: annotationContextMenuStyle,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IAnnotationContextMenuState>(
        '.annotation-context-menu',
        createInitialAnnotationContextMenuState,
        { autoDismiss: { onOutsideClick: true } },
    );

    const annotationContextMenuCanCopy = computed(() => {
        const text = annotationContextMenu.value.comment?.text.trim();
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

    const annotationContextMenuCanInsertImage = computed(() => (
        Number.isFinite(annotationContextMenu.value.pageNumber)
        && Number.isFinite(annotationContextMenu.value.pageX)
        && Number.isFinite(annotationContextMenu.value.pageY)
    ));

    const annotationContextMenuIsImage = computed(() => {
        const comment = annotationContextMenu.value.comment;
        return comment?.annotationKind === 'placed-image'
            || normalizeCommentSubtype(comment ?? {}) === 'stamp';
    });

    const contextMenuAnnotationLabel = computed(() => {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return t('annotations.annotationLabel');
        }
        const subtype = normalizeCommentSubtype(comment);
        if (comment.annotationKind === 'placed-image' || subtype === 'stamp') {
            return t('annotations.imageLabel');
        }
        if (comment.annotationKind === 'text-box') {
            return t('annotations.text');
        }
        const kindLabel = comment.kindLabel?.trim();
        return kindLabel && kindLabel.length > 0
            ? kindLabel
            : t(annotationKindLabelFromSubtype(subtype).key);
    });

    const contextMenuDeleteActionLabel = computed(() => {
        return resolveContextMenuDeleteActionLabel(annotationContextMenu.value.comment, {
            delete: t('annotations.delete'),
            deleteAnnotation: t('contextMenu.deleteAnnotation'),
            deleteImage: t('contextMenu.deleteImage'),
            deleteStickyNote: t('contextMenu.deleteStickyNote'),
            deleteHighlight: t('contextMenu.deleteHighlight'),
            deleteUnderline: t('contextMenu.deleteUnderline'),
            deleteStrikethrough: t('contextMenu.deleteStrikethrough'),
            deleteSquiggly: t('contextMenu.deleteSquiggly'),
        });
    });

    function closeAnnotationContextMenu() {
        if (!annotationContextMenu.value.visible) {
            return;
        }
        resetMenu();
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
        const fallbackWidth = 360;
        const markupSectionHeight = hasSelection ? 200 : 0;
        const estimatedHeight = (hasComment ? 258 : 0) + markupSectionHeight + 252;

        showPositionedMenu({
            x: payload.clientX,
            y: payload.clientY,
            fallbackWidth,
            fallbackHeight: estimatedHeight,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
                comment: payload.comment,
                hasSelection: payload.hasSelection,
                selectionText: payload.selectionText,
                pageNumber: payload.pageNumber,
                pageX: payload.pageX,
                pageY: payload.pageY,
            }),
        });
    }

    return {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    };
};
