import type {Ref} from 'vue';
import {parseAgentAnnotationRef} from '@contracts/agent';
import type {IAnnotationNoteWindowViewModel} from '@app/types/annotationNoteWindow';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IWorkspaceAgentCommandContext} from '@app/types/workspaceExpose';
import {normalizeMarkerRect, annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import type {IWorkspacePdfViewerAgentAnnotationNotePort} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {getAgentRawStringInput, getAgentStringInput} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    defineAgentActionHandler,
    type IAgentActionHandlerDefinition,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentActionRegistry';

interface IAgentUpdateNoteInput {
    input: Record<string, unknown>;
    markerRect: IAnnotationCommentSummary['markerRect'] | null;
    text: string;
}

interface ICreateDocumentAgentAnnotationNoteActionsOptions {
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    pdfViewerRef: Ref<IWorkspacePdfViewerAgentAnnotationNotePort | null>;
    findAgentAnnotationComment: (input: Record<string, unknown>) => IAnnotationCommentSummary;
    normalizeAgentAnnotationComment: (comment: IAnnotationCommentSummary) => object;
    handleOpenAnnotationNote: (comment: IAnnotationCommentSummary) => void;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    persistAnnotationNote: (annotationId: string) => boolean | Promise<boolean>;
    updateTextMarkupColorWithHistory: (comment: IAnnotationCommentSummary, color: string) => boolean;
}

function parseAgentUpdateNoteInput(input: Record<string, unknown>): IAgentUpdateNoteInput {
    parseAgentAnnotationRef(input);
    const text =
        getAgentRawStringInput(input, 'text') ?? getAgentRawStringInput(input, 'note') ?? getAgentRawStringInput(input, 'noteText');
    if (text === null) {
        throw new Error('annotation.update_note requires input.text.');
    }
    return {
        input,
        markerRect: normalizeMarkerRect(input.markerRect as IAnnotationCommentSummary['markerRect']),
        text,
    };
}

function parseAgentAnnotationColorInput(input: Record<string, unknown>) {
    parseAgentAnnotationRef(input);
    const color = getAgentStringInput(input, 'color');
    if (!color) {
        throw new Error('annotation.update_text_markup_color requires input.color.');
    }
    return {
        input,
        color,
    };
}

function markerRectsEqual(
    left: IAnnotationCommentSummary['markerRect'] | null | undefined,
    right: IAnnotationCommentSummary['markerRect'] | null | undefined,
) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function createDocumentAgentAnnotationNoteActions(
    options: ICreateDocumentAgentAnnotationNoteActionsOptions,
): ReadonlyArray<IAgentActionHandlerDefinition<unknown>> {
    function findOpenAgentAnnotationNote(comment: IAnnotationCommentSummary) {
        const annotationId = annotationIdForSummary(comment);
        return options.sortedAnnotationNoteWindows.value.find((note) => note.annotationId === annotationId);
    }

    function applyAgentAnnotationNoteTextUpdate(
        comment: IAnnotationCommentSummary,
        text: string,
        markerRect: IAnnotationCommentSummary['markerRect'] | null,
    ) {
        const commentForUpdate = markerRect
            ? {
                  ...comment,
                  markerRect,
                  hasNote: text.trim().length > 0 || comment.hasNote === true,
              }
            : comment;
        if (markerRect && options.pdfViewerRef.value?.moveAnnotationMarker(comment, markerRect) !== true) {
            return false;
        }
        const openNote = findOpenAgentAnnotationNote(commentForUpdate);
        if (openNote) {
            // The open window's draft takes the text; its commit to the store is the edit's completion.
            options.updateAnnotationNoteText(openNote.annotationId, text);
            return options.persistAnnotationNote(openNote.annotationId);
        }
        return options.pdfViewerRef.value?.updateAnnotationComment(commentForUpdate, text) ?? false;
    }

    function registerAgentAnnotationNoteUpdateHistory(
        previousComment: IAnnotationCommentSummary,
        previousText: string,
        previousMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
        nextComment: IAnnotationCommentSummary,
        nextText: string,
        nextMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
    ) {
        if (previousText === nextText && markerRectsEqual(previousMarkerRect, nextMarkerRect)) {
            return;
        }

        options.pdfViewerRef.value?.registerAnnotationHistoryCommand?.({
            cmd: () => {
                void applyAgentAnnotationNoteTextUpdate(nextComment, nextText, nextMarkerRect);
            },
            undo: () => {
                void applyAgentAnnotationNoteTextUpdate(previousComment, previousText, previousMarkerRect);
            },
        });
    }

    return [
        defineAgentActionHandler({
            ids: ['annotation.update_note'],
            policy: {mutatesDocument: true},
            parse: parseAgentUpdateNoteInput,
            async run(parsedInput: IAgentUpdateNoteInput, _actionId, context?: IWorkspaceAgentCommandContext) {
                const comment = options.findAgentAnnotationComment(parsedInput.input);
                const previousMarkerRect = comment.markerRect ?? null;
                const commentForUpdate = parsedInput.markerRect
                    ? {
                          ...comment,
                          markerRect: parsedInput.markerRect,
                          hasNote: true,
                      }
                    : comment;
                options.handleOpenAnnotationNote(commentForUpdate);
                // The open window's draft is what the reader sees and Undo must
                // bring back, saved or not; the stored text may be older.
                const previousText = findOpenAgentAnnotationNote(commentForUpdate)?.draftText ?? comment.text;
                const updated = await applyAgentAnnotationNoteTextUpdate(commentForUpdate, parsedInput.text, parsedInput.markerRect);
                context?.assertCurrentDocument();
                if (!updated) {
                    throw new Error('Annotation note could not be updated.');
                }
                registerAgentAnnotationNoteUpdateHistory(
                    comment,
                    previousText,
                    previousMarkerRect,
                    {
                        ...commentForUpdate,
                        text: parsedInput.text,
                        markerRect: parsedInput.markerRect ?? comment.markerRect,
                        hasNote: parsedInput.text.trim().length > 0 || comment.hasNote === true,
                    },
                    parsedInput.text,
                    parsedInput.markerRect ?? previousMarkerRect,
                );
                return {
                    updated,
                    comment: options.normalizeAgentAnnotationComment({
                        ...commentForUpdate,
                        markerRect: parsedInput.markerRect ?? comment.markerRect,
                        text: parsedInput.text,
                        hasNote: parsedInput.text.trim().length > 0 || comment.hasNote === true,
                    }),
                };
            },
        }),
        defineAgentActionHandler({
            ids: ['annotation.update_text_markup_color'],
            policy: {mutatesDocument: true},
            parse: parseAgentAnnotationColorInput,
            async run(parsedInput: ReturnType<typeof parseAgentAnnotationColorInput>, _actionId, context?: IWorkspaceAgentCommandContext) {
                const comment = options.findAgentAnnotationComment(parsedInput.input);
                context?.assertCurrentDocument();
                const updated = options.updateTextMarkupColorWithHistory(comment, parsedInput.color);
                if (!updated) {
                    throw new Error('Text markup annotation color could not be updated.');
                }
                return {
                    updated,
                    comment: options.normalizeAgentAnnotationComment({
                        ...comment,
                        color: parsedInput.color,
                        colorEdited: true,
                    }),
                };
            },
        }),
    ];
}
