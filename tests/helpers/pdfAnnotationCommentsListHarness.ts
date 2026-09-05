import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import { BASE_ROOT_FONT_SIZE_PX } from '@app/utils/rootFontSize';

/**
 * Mounts the shipped `PdfAnnotationCommentsList` so that both the DOM-only unit
 * spec and the Chromium layout spec observe the same real component output.
 * Nothing here restates the component's own markup: every row, wrapper and
 * inline style read back comes from the component's render.
 */

// The first-class UI-scale presets from `useUiScale.ts` plus the clamped edge of
// the Windows auto-compensation band.
export const ANNOTATION_COMMENT_UI_SCALE_MATRIX = [
    0.85,
    0.9,
    1,
    1.1,
    1.25,
];

export const ANNOTATION_COMMENT_FIXTURE_COUNT = 24;
/** A sidebar the size the panel usually gets: about four rows tall. */
const DEFAULT_CONTAINER_HEIGHT_PX = 420;

const activeUnmounts = new Set<() => void>();

function createComment(index: number): IAnnotationCommentSummary {
    return {
        annotationId: null,
        author: `Author ${index}`,
        color: null,
        id: `comment-${index}`,
        modifiedAt: 1_700_000_000_000 + index,
        pageIndex: index,
        pageNumber: index + 1,
        source: 'pdf',
        stableKey: `ann:${index}:comment-${index}`,
        subtype: 'Text',
        text: `Annotation body ${index} that is deliberately long enough to need clipping by the row box rather than grow it.`,
        uid: null,
    };
}

const ANNOTATION_COMMENT_FIXTURES = Array.from(
    {length: ANNOTATION_COMMENT_FIXTURE_COUNT},
    (_unused, index) => createComment(index),
);

/**
 * `useUiScale.applyUiScaleToDocument` writes `--app-ui-scale` inline on `<html>`
 * and `html { font-size: calc(16px * var(--app-ui-scale)) }` turns it into the rem
 * base that `useRootFontSize` reads back. A DOM environment resolves no
 * stylesheets, so set the resulting root font size through the same inline-style
 * channel.
 */
export function applyRootFontSizePx(rootFontSizePx: number) {
    document.documentElement.style.fontSize = `${rootFontSizePx}px`;
}

export function applyUiScale(scale: number) {
    applyRootFontSizePx(BASE_ROOT_FONT_SIZE_PX * scale);
}

export function unmountAnnotationCommentsLists() {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    document.documentElement.style.removeProperty('font-size');
}

export interface IMountAnnotationCommentsListOptions {
    activeIndex?: number | null;
    comments?: readonly IAnnotationCommentSummary[];
    /**
     * The scroll container's visible height. A DOM environment lays nothing out,
     * so the height a real sidebar would have has to be stated; tall values stand
     * in for the sidebar on a large display, where many more rows fit at once.
     */
    clientHeightPx?: number;
}

interface IAnnotationCommentsListHarnessEvents {deleted: IAnnotationCommentSummary[];}

export function mountAnnotationCommentsList({
    activeIndex = null,
    clientHeightPx = DEFAULT_CONTAINER_HEIGHT_PX,
    comments = ANNOTATION_COMMENT_FIXTURES,
}: IMountAnnotationCommentsListOptions = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const viewProps = reactive({
        activeCommentStableKey: activeIndex === null
            ? null
            : String(annotationIdForSummary(comments[activeIndex]!)),
        comments,
        status: 'ready' as const,
    });
    const events: IAnnotationCommentsListHarnessEvents = {deleted: []};
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationCommentsList, {
        ...viewProps,
        onDeleteComment: (comment: IAnnotationCommentSummary) => events.deleted.push(comment),
    })}));
    app.component('UButton', defineComponent({setup: () => () => h('button')}));
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.mount(host);

    const container = host.querySelector<HTMLElement>('.notes-list');
    if (!container) {
        throw new Error('Annotation comments list did not render its scroll container');
    }
    Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: clientHeightPx,
    });

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        clientHeightPx,
        container,
        events,
        host,
        unmount,
        async scrollTo(offsetPx: number) {
            container.scrollTop = offsetPx;
            container.dispatchEvent(new Event('scroll'));
            await nextTick();
        },
    };
}

function readPx(value: string | undefined) {
    const parsed = Number.parseFloat(value ?? '');
    if (!Number.isFinite(parsed)) {
        throw new Error(`Expected a pixel length, received "${value}"`);
    }
    return parsed;
}

export function readWrapper(host: HTMLElement) {
    const wrapper = host.querySelector<HTMLElement>('.notes-list > div');
    if (!wrapper) {
        throw new Error('Annotation comments list did not render its virtual wrapper');
    }
    return {
        element: wrapper,
        heightPx: readPx(wrapper.style.height),
        marginTopPx: readPx(wrapper.style.marginTop),
    };
}

export function readRows(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLElement>('.note-item')].map(row => ({
        element: row,
        gapPx: readPx(row.style.marginBottom),
        heightPx: readPx(row.style.height),
        pageLabel: row.querySelector<HTMLElement>('.note-item-page')?.textContent?.trim() ?? '',
    }));
}
