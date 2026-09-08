import {
    describe,
    expect,
    it,
} from 'vitest';
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
