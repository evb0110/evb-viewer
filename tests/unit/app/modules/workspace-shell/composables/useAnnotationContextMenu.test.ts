// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {effectScope, ref} from 'vue';
import {usePageAnnotationActions} from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import {cast} from '@tests/helpers/cast';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {
    LOCALE_MESSAGES,
    type TLocale,
} from '@i18n-app';
import {
    resolveContextMenuDeleteActionLabel,
    type IContextMenuDeleteLabels,
} from '@app/modules/workspace-shell/composables/useAnnotationContextMenu';

const locales = Object.keys(LOCALE_MESSAGES) as TLocale[];

function getDeleteLabels(locale: TLocale): IContextMenuDeleteLabels {
    const messages = LOCALE_MESSAGES[locale];

    return {
        delete: messages.annotations.delete,
        deleteAnnotation: messages.contextMenu.deleteAnnotation,
        deleteImage: messages.contextMenu.deleteImage,
        deleteStickyNote: messages.contextMenu.deleteStickyNote,
        deleteHighlight: messages.contextMenu.deleteHighlight,
        deleteUnderline: messages.contextMenu.deleteUnderline,
        deleteStrikethrough: messages.contextMenu.deleteStrikethrough,
        deleteSquiggly: messages.contextMenu.deleteSquiggly,
    };
}

describe('annotation context menu delete labels', () => {
    it('uses complete localized actions for every supported locale', () => {
        for (const locale of locales) {
            const messages = LOCALE_MESSAGES[locale];
            const labels = getDeleteLabels(locale);

            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'note',
                    text: '',
                    subtype: 'text',
                    hasNote: true,
                },
                labels,
            )).toBe(messages.contextMenu.deleteStickyNote);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'placed-image',
                    text: '',
                    subtype: 'stamp',
                },
                labels,
            )).toBe(messages.contextMenu.deleteImage);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'text-markup',
                    text: '',
                    subtype: 'highlight',
                },
                labels,
            )).toBe(messages.contextMenu.deleteHighlight);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'text-markup',
                    text: 'a note carried by the highlight',
                    subtype: 'highlight',
                    hasNote: true,
                },
                labels,
            )).toBe(messages.contextMenu.deleteHighlight);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'shape',
                    text: 'a note carried by the shape',
                    subtype: 'rectangle',
                    hasNote: true,
                },
                labels,
            )).toBe(messages.contextMenu.deleteAnnotation);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'text-markup',
                    text: '',
                    subtype: 'underline',
                },
                labels,
            )).toBe(messages.contextMenu.deleteUnderline);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'text-markup',
                    text: '',
                    subtype: 'strikeout',
                },
                labels,
            )).toBe(messages.contextMenu.deleteStrikethrough);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'text-markup',
                    text: '',
                    subtype: 'squiggly',
                },
                labels,
            )).toBe(messages.contextMenu.deleteSquiggly);
            expect(resolveContextMenuDeleteActionLabel(
                {
                    annotationKind: 'shape',
                    text: '',
                    subtype: 'rectangle',
                },
                labels,
            )).toBe(messages.contextMenu.deleteAnnotation);
            expect(resolveContextMenuDeleteActionLabel(null, labels)).toBe(messages.annotations.delete);
        }
    });
});

const clipboard = vi.hoisted(() => ({copy: vi.fn()}));
vi.mock('@vueuse/core', async importOriginal => ({
    ...await importOriginal<typeof import('@vueuse/core')>(),
    useClipboard: () => clipboard,
}));
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('#1608 annotation action feedback', () => {
    it.each(['create note', 'copy selection', 'copy comment'])(
        'reports %s failure through the existing toast', async action => {
            const messages: string[] = [];
            vi.stubGlobal('useToast', () => ({add: (notice: {title: string; description?: string}) => {
                messages.push([notice.title, notice.description].filter(Boolean).join(' '));
            }}));
            const failure = new DOMException('Clipboard permission denied', 'NotAllowedError');
            clipboard.copy.mockRejectedValue(failure);
            const scope = effectScope();
            const actions = scope.run(() => usePageAnnotationActions(cast<Parameters<typeof usePageAnnotationActions>[0]>({
                pdfViewerRef: ref({commentAtPoint: async () => {throw new Error('Note placement failed');}}),
                annotationTool: ref('select'),
                annotationActiveCommentStableKey: ref(null),
                annotationContextMenu: ref({visible: true, comment: null, hasSelection: true,
                    selectionText: 'Selected words', pageNumber: 1, pageX: 0.5, pageY: 0.5}),
                showSidebar: ref(false), sidebarTab: ref('annotations'), dragMode: ref(false),
                workingCopyPath: ref(null), currentPage: ref(1), annotationNoteWindows: ref([]),
                closeAnnotationContextMenu: () => {}, isSameAnnotationComment: () => false,
                setAnnotationNoteWindowError: () => {}, removeAnnotationNoteWindow: () => {},
                openAnnotationNoteWindow: () => {}, handleAnnotationToolChange: () => true,
            })))!;
            try {
                if (action === 'create note') await actions.createContextMenuFreeNote();
                else if (action === 'copy selection') await actions.copyContextMenuSelectionText();
                else await actions.handleCopyAnnotationComment(cast<IAnnotationCommentSummary>({text: 'Comment words'}));
                expect(messages.join(' '), 'I1: a failed enabled action must explain its failure').toMatch(
                    action === 'create note' ? /note|annotation/i : /cop|clipboard/i,
                );
            } finally {scope.stop();}
        },
    );
});
