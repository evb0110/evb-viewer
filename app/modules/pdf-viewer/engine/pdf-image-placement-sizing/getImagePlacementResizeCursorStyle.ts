import {getImagePlacementResizeCursor} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementResizeCursor';
import type {TImagePlacementResizeHandle} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

const IMAGE_PLACEMENT_CURSOR_SIZE_PX = 32;

const IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX = 16;

const IMAGE_PLACEMENT_HANDLE_ANGLES: Record<TImagePlacementResizeHandle, number> = {
    n: -90,
    ne: -45,
    e: 0,
    se: 45,
    s: 90,
    sw: 135,
    w: 180,
    nw: 225,
};

function buildImagePlacementResizeCursorSvg(angleDegrees: number) {
    const size = IMAGE_PLACEMENT_CURSOR_SIZE_PX;
    const center = IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX;
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="rotate(${angleDegrees} ${center} ${center})">
    <line x1="8" y1="${center}" x2="24" y2="${center}" stroke="white" stroke-width="5" stroke-linecap="round" />
    <path d="M11 12 L7 16 L11 20" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M21 12 L25 16 L21 20" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="8" y1="${center}" x2="24" y2="${center}" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" />
    <path d="M11 12 L7 16 L11 20" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M21 12 L25 16 L21 20" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  </g>
</svg>`.trim();

    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX} ${IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX}`;
}

export function getImagePlacementResizeCursorStyle(handle: TImagePlacementResizeHandle, rotationDegrees: number) {
    const handleAngle = IMAGE_PLACEMENT_HANDLE_ANGLES[handle];
    const normalizedAngle = (((handleAngle + rotationDegrees) % 360) + 360) % 360;
    const fallbackCursor = getImagePlacementResizeCursor(handle, rotationDegrees);

    return `${buildImagePlacementResizeCursorSvg(normalizedAngle)}, ${fallbackCursor}`;
}
