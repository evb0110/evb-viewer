import type {TAnnotationTool} from '@app/types/annotations';

export function isAuthoringAnnotationTool(tool: TAnnotationTool) {
    return tool !== 'none' && tool !== 'select';
}
