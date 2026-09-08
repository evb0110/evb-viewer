// @vitest-environment happy-dom

import { requirePageIndex } from '@contracts/pageNumbers';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    inject,
    ref,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import {
    AnnotationApplication,
    toCanonicalShapeEntity,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {IShapeContextProvide} from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/usePdfShapeTool';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';

const mountedApps = new Set<ReturnType<typeof createApp>>();

function createShapeToolHarness(application = new AnnotationApplication('doc-key')) {
    const annotationApplication = shallowRef(application);
    const annotationTool = ref<TAnnotationTool>('select');
    let tool!: ReturnType<typeof usePdfShapeTool>;
    let shapeContext!: IShapeContextProvide;
    const emitShapeContextMenu = vi.fn();
    const child = defineComponent({setup() {
        shapeContext = inject<IShapeContextProvide>('shapeContext')!;
        return () => null;
    }});
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({ setup() {
        tool = usePdfShapeTool({
            annotationTool: computed(() => annotationTool.value),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            isAnySaving: ref(false),
            annotationApplication,
            markModified: () => undefined,
            emitShapeContextMenu,
            getDeletedShapeHandler: () => null,
            getShapeCommentsChangedHandler: () => null,
        });
        return () => h(child);
    } }));
    app.mount(host);
    mountedApps.add(app);
    return {
        annotationApplication,
        annotationTool,
        tool,
        shapeContext,
        emitShapeContextMenu,
        app,
    };
}

function createEmbeddedShape(overrides?: Partial<IShapeAnnotation>): IShapeAnnotation {
    return {
        id: 'embedded-shape-1',
        type: 'rectangle',
        pageIndex: 2,
        x: 0.1,
        y: 0.15,
        width: 0.2,
        height: 0.25,
        color: '#336699',
        fillColor: '#abcdef',
        opacity: 0.6,
        strokeWidth: 3,
        source: 'embedded',
        annotationId: '12R0',
        stableKey: 'evb-shape:embedded-rect-1',
        pdfSubtype: 'Square',
        ...overrides,
    };
}

function drawLocalShape(harness: ReturnType<typeof createShapeToolHarness>) {
    const {shapeComposable} = harness.tool;
    shapeComposable.startDrawing(requirePageIndex(1), 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
    shapeComposable.continueDrawing(0.15, 0.25);
    shapeComposable.continueDrawing(0.25, 0.35);
    const created = shapeComposable.finishDrawing();
    expect(created).not.toBeNull();
    harness.tool.handleShapeCreated(created!);
    return created!;
}

function replaceEmbeddedShapes(
    harness: ReturnType<typeof createShapeToolHarness>,
    shapes: readonly IShapeAnnotation[],
) {
    harness.annotationApplication.value.store.replaceFromDocument(
        shapes.map(shape => toCanonicalShapeEntity(shape, asAnnotationId(shape.id))),
        [],
    );
}

function summaryFor(harness: ReturnType<typeof createShapeToolHarness>, shapeId: string) {
    const summary = harness.tool
        .getShapeAnnotationCommentSummaries()
        .find(candidate => candidate.appAnnotationId === shapeId);
    expect(summary).toBeDefined();
    return summary!;
}

describe('usePdfShapeTool.findShapeForAnnotationComment', () => {
    afterEach(() => {
        for (const app of mountedApps) {
            app.unmount();
        }
        mountedApps.clear();
        document.body.replaceChildren();
    });

    it('emits the canonical context-menu identity for an imported shape with a different runtime ID', () => {
        const harness = createShapeToolHarness();
        const canonicalId = asAnnotationId('canonical-shape-id');
        harness.annotationApplication.value.store.replaceFromDocument([toCanonicalShapeEntity(createEmbeddedShape({id: 'import-parser-runtime-id'}), canonicalId)], []);
        const [projected] = harness.shapeContext.getShapesForPage(requirePageIndex(2));
        expect(projected?.id).toBe(canonicalId);
        harness.shapeContext.handleShapeContextMenu({
            shapeId: projected!.id,
            clientX: 32,
            clientY: 48,
        });
        expect(harness.emitShapeContextMenu).toHaveBeenCalledWith({
            shapeId: canonicalId,
            clientX: 32,
            clientY: 48,
        });
    });

    it('matches an unsaved local shape summary through its canonical identity', () => {
        const harness = createShapeToolHarness();
        const created = drawLocalShape(harness);
        const summary = summaryFor(harness, created.id);

        expect(summary.appAnnotationId).toBe(created.id);
        expect(harness.tool.findShapeForAnnotationComment(summary)?.id).toBe(created.id);
    });

    it('keeps the canonical identity alongside a persisted shape PDF reference', () => {
        const harness = createShapeToolHarness();
        replaceEmbeddedShapes(harness, [createEmbeddedShape()]);
        const summary = summaryFor(harness, 'embedded-shape-1');

        expect(summary.appAnnotationId).toBe('embedded-shape-1');
        expect(summary.annotationId).toBe('12R');
        expect(harness.tool.findShapeForAnnotationComment(summary)?.id).toBe('embedded-shape-1');
    });

    it('picks the shape the summary identifies instead of the first shape on record', () => {
        const harness = createShapeToolHarness();
        replaceEmbeddedShapes(harness, [
            createEmbeddedShape(),
            createEmbeddedShape({
                id: 'embedded-shape-2',
                annotationId: '13R0',
                stableKey: 'evb-shape:embedded-rect-2',
            }),
        ]);
        const second = summaryFor(harness, 'embedded-shape-2');

        expect(harness.tool.findShapeForAnnotationComment(second)?.id).toBe('embedded-shape-2');
    });

    it('returns null for a shape summary that no live shape owns', () => {
        const harness = createShapeToolHarness();
        replaceEmbeddedShapes(harness, [createEmbeddedShape()]);
        const unrelated = toShapeAnnotationCommentSummary(createEmbeddedShape({
            id: 'never-imported-shape',
            annotationId: '99R0',
            stableKey: 'evb-shape:never-imported',
        }));

        expect(harness.tool.findShapeForAnnotationComment(unrelated)).toBeNull();
    });

    it('returns null for comments that are not shape rows', () => {
        const harness = createShapeToolHarness();
        const created = drawLocalShape(harness);
        const summary = summaryFor(harness, created.id);
        const pdfComment: IAnnotationCommentSummary = {
            ...summary,
            source: 'pdf',
        };

        expect(harness.tool.findShapeForAnnotationComment(pdfComment)).toBeNull();
    });

    it('never treats two unresolvable identities as the same annotation', () => {
        class UnresolvableApplication extends AnnotationApplication {
            override annotationIdForSummary() {
                return null;
            }

            override annotationIdForShape() {
                return null;
            }
        }

        const harness = createShapeToolHarness(new UnresolvableApplication('doc-key'));
        replaceEmbeddedShapes(harness, [createEmbeddedShape()]);
        const summary = summaryFor(harness, 'embedded-shape-1');

        expect(harness.tool.findShapeForAnnotationComment(summary)).toBeNull();
    });
});
