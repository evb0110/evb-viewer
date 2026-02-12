import {
    AnnotationEditorParamsType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import { detectEditorSubtype } from '@app/composables/pdf/pdfAnnotationUtils';

const FREE_TEXT_FONT_SIZE_MIN = 8;
const FREE_TEXT_FONT_SIZE_MAX = 96;

let globalDiagMoveListenerAttached = false;

type TUiManagerSelectedEditor = Parameters<AnnotationEditorUIManager['setSelected']>[0];

interface IUseFreeTextResizeOptions {
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    getNumPages: () => number;
    emitAnnotationModified: () => void;
    emitAnnotationSetting: (payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }) => void;
    scheduleAnnotationCommentsSync: () => void;
}

export function useFreeTextResize(options: IUseFreeTextResizeOptions) {
    const {
        getAnnotationUiManager,
        getNumPages,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync,
    } = options;

    function parseEditorInlineFontSizePx(value: string) {
        const calcMatch = value.match(/calc\(([\d.]+)px\s*\*/);
        if (calcMatch?.[1]) {
            const parsed = Number.parseFloat(calcMatch[1]);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
        const pxMatch = value.match(/([\d.]+)px/);
        if (!pxMatch?.[1]) {
            return null;
        }
        const parsed = Number.parseFloat(pxMatch[1]);
        return Number.isFinite(parsed) && parsed > 0
            ? parsed
            : null;
    }

    function getFreeTextEditorFontSize(editor: IPdfjsEditor) {
        const serialized = (editor as { serialize?: () => unknown }).serialize?.();
        if (
            serialized
            && typeof serialized === 'object'
            && 'fontSize' in serialized
            && typeof (serialized as { fontSize?: unknown }).fontSize === 'number'
        ) {
            const fontSize = (serialized as { fontSize: number }).fontSize;
            if (Number.isFinite(fontSize) && fontSize > 0) {
                return fontSize;
            }
        }

        const internal = editor.div?.querySelector<HTMLElement>('.internal');
        if (!internal) {
            return null;
        }

        const inlineFontSize = parseEditorInlineFontSizePx(internal.style.fontSize);
        if (inlineFontSize) {
            return inlineFontSize;
        }

        const computedFontSize = Number.parseFloat(getComputedStyle(internal).fontSize);
        if (!Number.isFinite(computedFontSize) || computedFontSize <= 0) {
            return null;
        }

        const scaleToken = getComputedStyle(internal).getPropertyValue('--total-scale-factor').trim();
        const scale = Number.parseFloat(scaleToken);
        if (Number.isFinite(scale) && scale > 0) {
            return computedFontSize / scale;
        }
        return computedFontSize;
    }

    function updateFreeTextResizerSize(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const rect = div.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        const maxCornerSize = Math.floor((Math.min(rect.width, rect.height) - 2) / 2);
        const nextSize = Math.max(4, Math.min(10, maxCornerSize));
        div.style.setProperty('--evb-resizer-size', `${nextSize}px`);
    }

    function addResizeCursorManagement(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const resizers = div.querySelectorAll<HTMLElement>('.resizer');
        for (const resizer of resizers) {
            if (resizer.dataset.evbResizeCursorBound === '1') {
                continue;
            }
            resizer.dataset.evbResizeCursorBound = '1';
            resizer.addEventListener('pointerdown', () => {
                const isNWSE = resizer.classList.contains('topLeft')
                    || resizer.classList.contains('bottomRight');
                const cursorClass = isNWSE ? 'pdf-resizing-nwse' : 'pdf-resizing-nesw';
                document.documentElement.classList.add(cursorClass);
                const cleanup = () => {
                    document.documentElement.classList.remove(cursorClass);
                    window.removeEventListener('pointerup', cleanup);
                    window.removeEventListener('blur', cleanup);
                };
                window.addEventListener('pointerup', cleanup);
                window.addEventListener('blur', cleanup);
            });
        }
    }

    function patchFreeTextPreSelect(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & { __evbPreSelectPatched?: boolean };
        if (tagged.__evbPreSelectPatched) {
            return;
        }
        tagged.__evbPreSelectPatched = true;

        const div = editor.div;
        if (!div) {
            return;
        }

        div.addEventListener('pointerdown', (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            const targetClasses = target?.className ?? '';
            const isResizer = target?.classList?.contains('resizer') ?? false;
            console.log(
                `[EVB-DIAG] CAPTURE pointerdown on editor div | btn=${e.button}`
                + ` | target=${target?.tagName}.${targetClasses}`
                + ` | isResizer=${isResizer}`
                + ` | _isDraggable=${editor._isDraggable}`
                + ` | isSelected=${editor.isSelected}`
                + ` | isInEditMode=${typeof editor.isInEditMode === 'function' ? editor.isInEditMode() : 'N/A'}`
                + ` | x=${editor.x} y=${editor.y} w=${editor.width} h=${editor.height}`
                + ` | div.classes=${div.className}`
                + ` | defaultPrevented=${e.defaultPrevented}`
                + ` | clientX=${e.clientX} clientY=${e.clientY}`,
            );

            if (e.button !== 0) {
                return;
            }
            if (typeof editor.isInEditMode === 'function' && editor.isInEditMode()) {
                return;
            }
            if (!editor._isDraggable || editor.isSelected) {
                console.log(`[EVB-DIAG] CAPTURE: skip pre-select (draggable=${editor._isDraggable}, selected=${editor.isSelected})`);
                return;
            }
            const uiManager = getAnnotationUiManager();
            if (uiManager) {
                console.log('[EVB-DIAG] CAPTURE: calling uiManager.setSelected for pre-select');
                uiManager.setSelected(editor as TUiManagerSelectedEditor);
                console.log(`[EVB-DIAG] CAPTURE: after pre-select → isSelected=${editor.isSelected}`);
            }
        }, { capture: true });

        div.addEventListener('pointerdown', (e: PointerEvent) => {
            console.log(
                `[EVB-DIAG] BUBBLE pointerdown on editor div | btn=${e.button}`
                + ` | _isDraggable=${editor._isDraggable}`
                + ` | isSelected=${editor.isSelected}`
                + ` | defaultPrevented=${e.defaultPrevented}`
                + ' | propagationStopped (can\'t check, but event reached here)',
            );
        });
    }

    interface IPdfjsEditorDiag extends IPdfjsEditor {
        __evbDiagPatched?: boolean;
        drag?: (tx: number, ty: number) => void;
        pointerdown?: (event: PointerEvent) => void;
        pageDimensions?: number[];
        parentDimensions?: number[];
    }

    function addDragResizeDiagnostics(editor: IPdfjsEditor) {
        const diag = editor as IPdfjsEditorDiag;
        if (diag.__evbDiagPatched) {
            return;
        }
        diag.__evbDiagPatched = true;

        const div = editor.div;
        if (!div) {
            return;
        }

        const origDrag = typeof diag.drag === 'function'
            ? diag.drag.bind(editor)
            : null;
        if (origDrag) {
            diag.drag = (tx: number, ty: number) => {
                console.log(
                    `[EVB-DIAG] editor.drag() called | tx=${tx} ty=${ty}`
                    + ` | before: x=${editor.x} y=${editor.y}`
                    + ` | parentDimensions=${JSON.stringify(diag.parentDimensions)}`
                    + ` | pageDimensions=${JSON.stringify(diag.pageDimensions)}`,
                );
                origDrag(tx, ty);
                console.log(
                    `[EVB-DIAG] editor.drag() done | after: x=${editor.x} y=${editor.y}`
                    + ` | style.left=${div.style.left} style.top=${div.style.top}`,
                );
            };
        } else {
            console.warn('[EVB-DIAG] editor.drag is NOT a function — cannot hook');
        }

        // NOTE: editor.pointerdown is bound via bindEvents() at render time,
        // so instance-patching won't intercept the event listener. The
        // capture/bubble listeners in patchFreeTextPreSelect cover this path.
        // We log whether pointerdown exists for completeness.
        console.log(`[EVB-DIAG] editor.pointerdown exists=${typeof diag.pointerdown === 'function'}`);

        const resizers = div.querySelectorAll<HTMLElement>('.resizer');
        console.log(`[EVB-DIAG] Found ${resizers.length} resizer elements on editor`);
        for (const resizer of resizers) {
            if (resizer.dataset.evbDiagBound === '1') {
                continue;
            }
            resizer.dataset.evbDiagBound = '1';
            resizer.addEventListener('pointerdown', (e: PointerEvent) => {
                const resizerClasses = resizer.className;
                const computedPE = getComputedStyle(resizer).pointerEvents;
                const parentPE = getComputedStyle(div).pointerEvents;
                const layerDiv = div.closest('.annotationEditorLayer') as HTMLElement | null;
                const layerPE = layerDiv ? getComputedStyle(layerDiv).pointerEvents : 'N/A';
                console.log(
                    `[EVB-DIAG] RESIZER pointerdown | classes=${resizerClasses}`
                    + ` | btn=${e.button}`
                    + ` | computedPointerEvents: resizer=${computedPE}, editor=${parentPE}, layer=${layerPE}`
                    + ` | clientX=${e.clientX} clientY=${e.clientY}`,
                );
            }, { capture: true });
        }

        if (!globalDiagMoveListenerAttached) {
            globalDiagMoveListenerAttached = true;
            let diagMoveCount = 0;
            let diagMoveLogTimer: ReturnType<typeof setTimeout> | null = null;
            window.addEventListener('pointermove', () => {
                diagMoveCount += 1;
                if (!diagMoveLogTimer) {
                    diagMoveLogTimer = setTimeout(() => {
                        if (diagMoveCount > 0) {
                            console.log(`[EVB-DIAG] window pointermove events in last 500ms: ${diagMoveCount}`);
                        }
                        diagMoveCount = 0;
                        diagMoveLogTimer = null;
                    }, 500);
                }
            }, { passive: true });
        }
    }

    function isActualNaN(value: unknown): boolean {
        return typeof value === 'number' && Number.isNaN(value);
    }

    function recoverNaNPosition(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const xBad = isActualNaN(editor.x);
        const yBad = isActualNaN(editor.y);
        if (!xBad && !yBad) {
            return;
        }
        const left = parseFloat(div.style.left);
        const top = parseFloat(div.style.top);
        if (xBad && Number.isFinite(left)) {
            editor.x = left / 100;
            console.log(`[EVB-DIAG] recovered editor.x from style.left: ${editor.x}`);
        }
        if (yBad && Number.isFinite(top)) {
            editor.y = top / 100;
            console.log(`[EVB-DIAG] recovered editor.y from style.top: ${editor.y}`);
        }
    }

    function recoverNaNDimensions(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const wBad = isActualNaN(editor.width);
        const hBad = isActualNaN(editor.height);
        if (!wBad && !hBad) {
            return;
        }
        const diag = editor as IPdfjsEditorDiag;
        const parentDims = diag.parentDimensions;
        if (!parentDims || parentDims.length < 2) {
            return;
        }
        const parentW = parentDims[0] ?? 0;
        const parentH = parentDims[1] ?? 0;
        const rect = div.getBoundingClientRect();
        if (wBad && rect.width > 0 && parentW > 0) {
            editor.width = rect.width / parentW;
            console.log(`[EVB-DIAG] recovered editor.width from rect: ${editor.width}`);
        }
        if (hBad && rect.height > 0 && parentH > 0) {
            editor.height = rect.height / parentH;
            console.log(`[EVB-DIAG] recovered editor.height from rect: ${editor.height}`);
        }
    }

    function ensureFreeTextEditorInteractivity(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & { makeResizable?: () => void };
        const div = editor.div;
        if (!div) {
            return;
        }

        const isEditing = typeof editor.isInEditMode === 'function' && editor.isInEditMode();

        recoverNaNPosition(editor);
        recoverNaNDimensions(editor);

        if (!isEditing) {
            if (typeof tagged.makeResizable === 'function') {
                tagged.makeResizable();
            }
            editor._isDraggable = true;
            const overlay = div.querySelector<HTMLElement>('.overlay');
            if (overlay) {
                overlay.classList.add('enabled');
            }
        }

        patchFreeTextPreSelect(editor);
        addDragResizeDiagnostics(editor);
        updateFreeTextResizerSize(editor);
        addResizeCursorManagement(editor);
    }

    function patchFreeTextResizeFontSync(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & {
            __freeTextResizeHookPatched?: boolean;
            __freeTextFontToWidthRatio?: number;
            __freeTextResizeSyncRaf?: number;
            __freeTextIsResizeSync?: boolean;
        };
        if (tagged.__freeTextResizeHookPatched) {
            return;
        }

        function captureRatio() {
            const fontSize = getFreeTextEditorFontSize(editor);
            const w = editor.width;
            console.log(`[EVB-DIAG] captureRatio: fontSize=${fontSize}, w=${w}`);
            if (fontSize && fontSize > 0 && typeof w === 'number' && w > 0.01) {
                tagged.__freeTextFontToWidthRatio = fontSize / w;
                console.log(`[EVB-DIAG] captureRatio: ratio=${tagged.__freeTextFontToWidthRatio}`);
            }
        }
        captureRatio();

        const originalUpdateParams = typeof editor.updateParams === 'function'
            ? editor.updateParams.bind(editor) : null;
        if (originalUpdateParams) {
            editor.updateParams = (type: number, value: unknown) => {
                const isExternalFontChange
                    = type === AnnotationEditorParamsType.FREETEXT_SIZE
                    && !tagged.__freeTextIsResizeSync;
                if (isExternalFontChange && editor.div) {
                    const currentFont = getFreeTextEditorFontSize(editor);
                    if (currentFont && Math.abs(currentFont - Number(value)) < 0.5) {
                        originalUpdateParams(type, value);
                        return;
                    }
                    editor.div.style.width = '';
                    editor.div.style.height = '';
                }
                originalUpdateParams(type, value);
                if (isExternalFontChange) {
                    const fontSize = getFreeTextEditorFontSize(editor);
                    const w = editor.width;
                    if (fontSize && fontSize > 0 && w && w > 0) {
                        tagged.__freeTextFontToWidthRatio = fontSize / w;
                    }
                }
            };
        }

        const originalOnResizing = typeof editor._onResizing === 'function'
            ? editor._onResizing.bind(editor)
            : null;

        editor._onResizing = () => {
            originalOnResizing?.();
            const ratio = tagged.__freeTextFontToWidthRatio;
            const w = editor.width;
            console.log(
                `[EVB-DIAG] _onResizing fired | ratio=${ratio} | w=${w}`
                + ` | x=${editor.x} y=${editor.y} h=${editor.height}`,
            );
            if (!ratio || !w || w <= 0) {
                return;
            }
            const targetFont = Math.max(
                FREE_TEXT_FONT_SIZE_MIN,
                Math.min(FREE_TEXT_FONT_SIZE_MAX, ratio * w),
            );
            const internal = editor.div?.querySelector<HTMLElement>('.internal');
            if (internal) {
                internal.style.fontSize = `calc(${targetFont}px * var(--total-scale-factor))`;
                console.log(`[EVB-DIAG] _onResizing set fontSize=${targetFont}px`);
            }
            updateFreeTextResizerSize(editor);
        };

        const originalOnResized = typeof editor._onResized === 'function'
            ? editor._onResized.bind(editor)
            : null;

        editor._onResized = () => {
            originalOnResized?.();
            const ratio = tagged.__freeTextFontToWidthRatio;
            const w = editor.width;
            if (!ratio || !w || w <= 0) {
                return;
            }
            const targetFont = Math.round(
                Math.max(
                    FREE_TEXT_FONT_SIZE_MIN,
                    Math.min(FREE_TEXT_FONT_SIZE_MAX, ratio * w),
                ),
            );

            const internal = editor.div?.querySelector<HTMLElement>('.internal');
            if (internal) {
                internal.style.fontSize = `calc(${targetFont}px * var(--total-scale-factor))`;
            }
            updateFreeTextResizerSize(editor);

            if (tagged.__freeTextResizeSyncRaf) {
                cancelAnimationFrame(tagged.__freeTextResizeSyncRaf);
            }
            tagged.__freeTextResizeSyncRaf = requestAnimationFrame(() => {
                tagged.__freeTextResizeSyncRaf = undefined;
                syncInternalFontSize(editor, tagged, targetFont);
                emitAnnotationSetting({
                    key: 'textSize',
                    value: targetFont,
                });
            });
        };

        tagged.__freeTextResizeHookPatched = true;
    }

    function syncInternalFontSize(
        editor: IPdfjsEditor,
        tagged: IPdfjsEditor & { __freeTextIsResizeSync?: boolean },
        targetFont: number,
    ) {
        const uiManager = getAnnotationUiManager();
        if (!editor.div?.isConnected || !uiManager) {
            return;
        }

        try {
            const savedX = editor.x;
            const savedY = editor.y;
            const savedW = editor.width;
            const savedH = editor.height;

            tagged.__freeTextIsResizeSync = true;
            try {
                if (typeof editor.updateParams === 'function') {
                    editor.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, targetFont);
                } else {
                    uiManager.setSelected(editor as TUiManagerSelectedEditor);
                    uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, targetFont);
                }
            } finally {
                tagged.__freeTextIsResizeSync = false;
            }

            editor.x = savedX;
            editor.y = savedY;
            editor.width = savedW;
            editor.height = savedH;
            editor.setDims?.();
            editor.fixAndSetPosition?.();

            emitAnnotationModified();
            scheduleAnnotationCommentsSync();
        } catch (error) {
            console.warn('[PdfViewer] Failed to sync FreeText font size:', error);
        }
    }

    function ensureFreeTextEditorCanResize(editor: IPdfjsEditor) {
        if (!editor) {
            return;
        }
        if (detectEditorSubtype(editor) !== 'Typewriter') {
            return;
        }
        const tagged = editor as IPdfjsEditor & {
            __freeTextResizablePatched?: boolean;
            __freeTextFontToWidthRatio?: number;
            makeResizable?: () => void;
        };
        if (tagged.__freeTextResizablePatched) {
            const fontSize = getFreeTextEditorFontSize(editor);
            const w = editor.width;
            if (fontSize && fontSize > 0 && typeof w === 'number' && w > 0.01) {
                const freshRatio = fontSize / w;
                const existingRatio = tagged.__freeTextFontToWidthRatio;
                if (!existingRatio || Math.abs(freshRatio - existingRatio) / freshRatio > 0.5) {
                    tagged.__freeTextFontToWidthRatio = freshRatio;
                    console.log(`[EVB-DIAG] updated ratio: ${freshRatio} (was ${existingRatio})`);
                }
            }
            ensureFreeTextEditorInteractivity(editor);
            return;
        }

        try {
            Object.defineProperty(editor, 'isResizable', {
                configurable: true,
                get() {
                    return true;
                },
            });
            tagged.__freeTextResizablePatched = true;
        } catch {
            // Ignore if PDF.js internals reject instance patching.
        }

        patchFreeTextResizeFontSync(editor);
        ensureFreeTextEditorInteractivity(editor);
    }

    function patchResizableFreeTextEditors(uiManager: AnnotationEditorUIManager) {
        for (let pageIndex = 0; pageIndex < getNumPages(); pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                if (!editor) {
                    continue;
                }
                ensureFreeTextEditorCanResize(editor as IPdfjsEditor);
            }
        }
    }

    return {
        ensureFreeTextEditorCanResize,
        patchResizableFreeTextEditors,
        getFreeTextEditorFontSize,
    };
}
