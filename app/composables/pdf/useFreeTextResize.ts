import {
    AnnotationEditorParamsType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import { detectEditorSubtype } from '@app/composables/pdf/pdfAnnotationUtils';

const FREE_TEXT_FONT_SIZE_MIN = 8;
const FREE_TEXT_FONT_SIZE_MAX = 96;

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

    function patchFreeTextDrag(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & { __evbDragPatched?: boolean };
        if (tagged.__evbDragPatched) {
            return;
        }
        tagged.__evbDragPatched = true;

        editor.drag = function (this: IPdfjsEditor, tx: number, ty: number) {
            const pdims = this.parentDimensions;
            const parentWidth = pdims?.[0] ?? 0;
            const parentHeight = pdims?.[1] ?? 0;
            if (!Number.isFinite(parentWidth) || parentWidth <= 0 || !Number.isFinite(parentHeight) || parentHeight <= 0) {
                return;
            }
            this.x = (this.x ?? 0) + tx / parentWidth;
            this.y = (this.y ?? 0) + ty / parentHeight;

            let x = this.x ?? 0;
            let y = this.y ?? 0;

            if (typeof this.getBaseTranslation === 'function') {
                const base = this.getBaseTranslation();
                x += base[0] ?? 0;
                y += base[1] ?? 0;
            }

            if (this.div) {
                this.div.style.left = `${(100 * x).toFixed(2)}%`;
                this.div.style.top = `${(100 * y).toFixed(2)}%`;
            }
        };
    }

    function ensureFreeTextEditorInteractivity(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & { makeResizable?: () => void };
        const div = editor.div;
        if (!div) {
            return;
        }

        const isEditing = typeof editor.isInEditMode === 'function' && editor.isInEditMode();

        if (typeof tagged.makeResizable === 'function') {
            tagged.makeResizable();
        }

        if (!isEditing) {
            editor._isDraggable = true;
            const overlay = div.querySelector<HTMLElement>('.overlay');
            if (overlay) {
                overlay.classList.add('enabled');
            }
        }

        patchFreeTextDrag(editor);
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
            if (fontSize && fontSize > 0 && w && w > 0) {
                tagged.__freeTextFontToWidthRatio = fontSize / w;
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
            if (!tagged.__freeTextFontToWidthRatio) {
                const fontSize = getFreeTextEditorFontSize(editor);
                const w = editor.width;
                if (fontSize && fontSize > 0 && w && w > 0) {
                    tagged.__freeTextFontToWidthRatio = fontSize / w;
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
