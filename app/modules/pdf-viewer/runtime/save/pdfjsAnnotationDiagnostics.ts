import type {IPdfNativeFreeTextEditor} from '@contracts/electronApiDocuments';

export interface IPdfLiveAnnotationChangeSummary {
    ids: Set<string>;
    replayableEditorNoteIds: Set<string>;
    nativeFreeTextEditors: Map<string, IPdfNativeFreeTextEditor>;
    hasChanges: boolean;
    hasUnknownChanges: boolean;
    fingerprint: string;
}

export interface IPdfAnnotationStorageDebugState {
    reported: boolean;
    modifiedIds: string[];
    serializableEntryKeys: string[];
}

export function mergeLivePdfJsAnnotationChanges(left: IPdfLiveAnnotationChangeSummary, right: IPdfLiveAnnotationChangeSummary): IPdfLiveAnnotationChangeSummary {
    return {
        ids: new Set([
            ...left.ids,
            ...right.ids,
        ]),
        replayableEditorNoteIds: new Set([
            ...left.replayableEditorNoteIds,
            ...right.replayableEditorNoteIds,
        ]),
        nativeFreeTextEditors: new Map([
            ...left.nativeFreeTextEditors,
            ...right.nativeFreeTextEditors,
        ]),
        hasChanges: left.hasChanges || right.hasChanges,
        hasUnknownChanges: left.hasUnknownChanges || right.hasUnknownChanges,
        fingerprint: `${left.fingerprint}|${right.fingerprint}`,
    };
}
export function collectPdfJsAnnotationStorageDebugState(..._args: unknown[]): IPdfAnnotationStorageDebugState { return {
    reported: false,
    modifiedIds: [],
    serializableEntryKeys: [],
}; }
