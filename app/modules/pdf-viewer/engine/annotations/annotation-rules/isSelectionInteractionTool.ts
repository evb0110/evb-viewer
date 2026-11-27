import type {TAnnotationTool} from '@app/types/annotations';

export function isSelectionInteractionTool(tool: TAnnotationTool) {
    return tool === 'select';
}
