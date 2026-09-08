import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';


import {useAnnotationKeyboardCommands} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationKeyboardCommands';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

function createSurfaceHarness(rotation: 0 | 90 | 180 | 270 = 0, viewRotation: 0 | 90 | 180 | 270 = 0) {
    const annotationApplication = shallowRef(new AnnotationApplication('surface-test'));
    const emitAnnotationModified = vi.fn();
    const emitShapeContextMenu = vi.fn();
    const onCreationCompleted = vi.fn();
    const scope = effectScope();
    activeScopes.add(scope);
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication,
        getPageGeometry: () => ({
            pageView: [
                0,
                0,
                600,
                800,
            ],
            rotation,
            viewRotation,
        }),
        activeTool: computed<TAnnotationTool>(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
    }))!;
    const stop = () => {
        if (!activeScopes.delete(scope)) {
            return;
        }
        scope.stop();
    };
    return {
        annotationApplication,
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        surface,
        stop,
    };
}

const activeScopes = new Set<ReturnType<typeof effectScope>>();
describe('actual keyboard to Surface nudge integration', () => {
    afterEach(() => { for (const scope of activeScopes) scope.stop(); activeScopes.clear(); });

    const directions = [
        {
            key: 'ArrowUp',
            dx: 0,
            dy: -1,
        },
        {
            key: 'ArrowDown',
            dx: 0,
            dy: 1,
        },
        {
            key: 'ArrowLeft',
            dx: -1,
            dy: 0,
        },
        {
            key: 'ArrowRight',
            dx: 1,
            dy: 0,
        },
    ];
    for (const rotation of [
        0,
        90,
        180,
        270,
    ] as const) {
        for (const viewRotation of [
            0,
            90,
            180,
            270,
        ] as const) {
            for (const {
                key,
                dx,
                dy,
            } of directions) {
                it(`${key} obeys screen direction at intrinsic ${rotation} and viewer ${viewRotation}`, () => {
                    const {surface} = createSurfaceHarness(rotation, viewRotation);
                    const box = surface.createTextBoxAt(0, rect);
                    surface.select([box.identity.id]);
                    const keyboard = useAnnotationKeyboardCommands({
                        surface,
                        pageView: () => [
                            0,
                            0,
                            600,
                            800,
                        ],
                        pageRotation: () => rotation,
                    });
                    keyboard.handleKeydown({
                        key,
                        target: null,
                        altKey: false,
                        ctrlKey: false,
                        metaKey: false,
                        shiftKey: false,
                        preventDefault() {},
                        stopPropagation() {},
                    });
                    const moved = surface.getSelectedTextBox()!;
                    const width = rotation === 90 || rotation === 270 ? 800 : 600;
                    const height = rotation === 90 || rotation === 270 ? 600 : 800;
                    const planeDx = (moved.rect.left - box.rect.left) * width;
                    const planeDy = (moved.rect.top - box.rect.top) * height;
                    const angle = viewRotation * Math.PI / 180;
                    const screenDx = planeDx * Math.cos(angle) - planeDy * Math.sin(angle);
                    const screenDy = planeDx * Math.sin(angle) + planeDy * Math.cos(angle);
                    expect(screenDx).toBeCloseTo(dx);
                    expect(screenDy).toBeCloseTo(dy);
                });
            }
        }
    }
});
