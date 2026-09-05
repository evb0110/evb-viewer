export function shouldClearPdfPageSelection(target: EventTarget | null) {
    return !(target instanceof Element && target.closest(
        '[data-annotation-id], .pdf-annotation-editor-layer',
    ));
}
