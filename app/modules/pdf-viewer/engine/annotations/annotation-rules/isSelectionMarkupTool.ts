import type {TAnnotationTool} from '@app/types/annotations';

export function isSelectionMarkupTool(tool: TAnnotationTool) {
    return tool === 'highlight' || tool === 'underline' || tool === 'strikethrough' || tool === 'squiggly';
}
