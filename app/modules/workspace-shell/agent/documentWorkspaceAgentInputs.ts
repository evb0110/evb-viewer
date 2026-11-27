import type {IShapePoint, TAnnotationTool, TDrawableShapeType} from '@app/types/annotations';
import {ANNOTATION_TOOLS, DRAWABLE_SHAPE_TOOLS} from '@app/types/annotations';
import {isOneOf} from '@contracts/runtimeGuards';
import type {TAgentTextMarkupKind} from '@app/modules/pdf-viewer/public';
import type {TWorkspaceAgentSidebarTab} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

const AGENT_SIDEBAR_TABS = ['annotations', 'bookmarks', 'thumbnails', 'search'] as const satisfies readonly TWorkspaceAgentSidebarTab[];

const AGENT_TEXT_MARKUP_KINDS = ['highlight', 'underline', 'strikethrough', 'squiggly'] as const satisfies readonly TAgentTextMarkupKind[];

export function isAgentRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAgentStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function getAgentRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

export function getAgentNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getAgentBooleanInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'boolean' ? value : null;
}

export function getAgentNumberArrayInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const numbers: number[] = [];
    for (const item of value) {
        if (typeof item === 'number' && Number.isFinite(item)) {
            numbers.push(item);
        }
    }
    return numbers.length === value.length ? numbers : undefined;
}

export function hasAgentInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

export function isAgentAnnotationTool(value: unknown): value is TAnnotationTool {
    return isOneOf(ANNOTATION_TOOLS, value);
}

export function isAgentSidebarTab(value: unknown): value is TWorkspaceAgentSidebarTab {
    return isOneOf(AGENT_SIDEBAR_TABS, value);
}

export function isAgentTextMarkupKind(value: unknown): value is TAgentTextMarkupKind {
    return isOneOf(AGENT_TEXT_MARKUP_KINDS, value);
}

export function isAgentShapeTool(value: unknown): value is TDrawableShapeType {
    return isOneOf(DRAWABLE_SHAPE_TOOLS, value);
}

export function getAgentNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (value === null) {
        return null;
    }
    return typeof value === 'string' ? value.trim() : undefined;
}

function getAgentPointInput(value: unknown): IShapePoint | null {
    if (!isAgentRecord(value)) {
        return null;
    }
    const x = getAgentNumberInput(value, 'x') ?? getAgentNumberInput(value, 'pageX');
    const y = getAgentNumberInput(value, 'y') ?? getAgentNumberInput(value, 'pageY');
    if (x === null || y === null) {
        return null;
    }
    return {
        x,
        y,
    };
}

export function getAgentPointArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const points = value.flatMap((item) => {
        const point = getAgentPointInput(item);
        return point ? [point] : [];
    });
    return points.length > 0 ? points : undefined;
}

export function getAgentStrokeArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strokes = value
        .filter(Array.isArray)
        .map((points) => points.map(getAgentPointInput).flatMap((point) => (point ? [point] : [])))
        .filter((points) => points.length > 0);
    return strokes.length > 0 ? strokes : undefined;
}
