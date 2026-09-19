// @vitest-environment happy-dom

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
    ref,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import {
    AnnotationApplication,
    toCanonicalShapeEntity,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { usePdfAnnotationCommentActions } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentActions';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/usePdfShapeTool';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';

const mountedApps = new Set<ReturnType<typeof createApp>>();

function createEmbeddedShape(overrides?: Partial<IShapeAnnotation>): IShapeAnnotation {
    return {
        id: 'embedded-shape-1',
        type: 'rectangle',
        pageIndex: 3,
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

function createActionsHarness() {
    const annotationApplication = shallowRef(new AnnotationApplication('doc-key'));
    const annotationTool = ref<TAnnotationTool>('select');
    const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
    const emitAnnotationComments = vi.fn();
    const focusAnnotationCommentCrud = vi.fn(async () => undefined);
    const deleteAnnotationCommentCrud = vi.fn(async () => true);

    let shapeTool!: ReturnType<typeof usePdfShapeTool>;
    let actions!: ReturnType<typeof usePdfAnnotationCommentActions>;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({ setup() {
        shapeTool = usePdfShapeTool({
            annotationTool: computed(() => annotationTool.value),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            isAnySaving: ref(false),
            annotationApplication,
            markModified: () => undefined,
            emitShapeContextMenu: () => undefined,
            getDeletedShapeHandler: () => null,
            getShapeCommentsChangedHandler: () => null,
        });
        const annotationCommentModel = usePdfAnnotationCommentModel({
            isAnySaving: ref(false),
            annotationProjection: annotationCommentsCache,
            ingestSummaries: () => undefined,
            emitAnnotationComments,
        });
        actions = usePdfAnnotationCommentActions({
            annotationCommentsCache,
            annotationCommentModel,
            shapeTool,
            selectedShapeCommands: shapeTool.selectedShapeCommands,
            commentCrud: {
                focusAnnotationComment: focusAnnotationCommentCrud,
                deleteAnnotationComment: deleteAnnotationCommentCrud,
            },
            emitForcedAnnotationMutation: () => undefined,
        });
        return () => null;
    } }));
    app.mount(host);
    mountedApps.add(app);

    return {
        actions,
        annotationApplication,
        shapeTool,
        emitAnnotationComments,
        deleteAnnotationCommentCrud,
    };
}

function importedShapeSummary(harness: ReturnType<typeof createActionsHarness>, shapeId = 'embedded-shape-1') {
    const summary = harness.shapeTool
        .getShapeAnnotationCommentSummaries()
        .find(candidate => candidate.appAnnotationId === shapeId);
    expect(summary).toBeDefined();
    return summary!;
}

describe('usePdfAnnotationCommentActions shape rows', () => {
    afterEach(() => {
        for (const app of mountedApps) {
            app.unmount();
        }
        mountedApps.clear();
        document.body.replaceChildren();
        vi.clearAllMocks();
    });

    it('still deletes the shape the row identifies', async () => {
        const harness = createActionsHarness();
        const shape = createEmbeddedShape();
        harness.annotationApplication.value.store.replaceFromDocument([toCanonicalShapeEntity(shape, asAnnotationId(shape.id))], []);
        const summary = importedShapeSummary(harness);

        await expect(harness.actions.deleteAnnotationComment(summary)).resolves.toBe(true);

        expect(harness.shapeTool.shapeComposable.getAllShapes()).toHaveLength(0);
    });
});
