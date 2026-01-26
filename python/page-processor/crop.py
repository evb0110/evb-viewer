"""
Content Cropping Module

Crops pages to content bounds, removing excessive margins.
"""

import cv2
import numpy as np
from typing import Optional


def crop_to_content(
    image: np.ndarray,
    bounds: Optional[dict] = None,
    padding: int = 30,
) -> np.ndarray:
    """
    Crop image to content bounds with optional padding.

    Args:
        image: Input image (BGR format)
        bounds: Content bounds dict with x, y, width, height
                (auto-detected if None)
        padding: Pixels to add around content

    Returns:
        Cropped image
    """
    h, w = image.shape[:2]

    if bounds is None:
        # Auto-detect bounds (fast projection-based bbox; avoids cv2.findNonZero).
        from detection import detect_content_bounds

        bounds = detect_content_bounds(image)
        if bounds is None:
            return image

    # Apply padding
    x = max(0, bounds["x"] - padding)
    y = max(0, bounds["y"] - padding)
    x2 = min(w, bounds["x"] + bounds["width"] + padding)
    y2 = min(h, bounds["y"] + bounds["height"] + padding)

    return image[y:y2, x:x2].copy()


def normalize_page_size(
    image: np.ndarray,
    target_width: int = None,
    target_height: int = None,
    background_color: tuple = (255, 255, 255),
) -> np.ndarray:
    """
    Normalize page to a target size, adding margins if needed.

    Useful for creating uniform output pages.

    Args:
        image: Input image
        target_width: Target width (None = keep original)
        target_height: Target height (None = keep original)
        background_color: Color for added margins

    Returns:
        Normalized image
    """
    h, w = image.shape[:2]

    if target_width is None:
        target_width = w
    if target_height is None:
        target_height = h

    # Create output canvas
    if len(image.shape) == 3:
        output = np.full((target_height, target_width, 3), background_color, dtype=np.uint8)
    else:
        output = np.full((target_height, target_width), background_color[0], dtype=np.uint8)

    # Calculate scaling to fit
    scale = min(target_width / w, target_height / h)

    if scale < 1.0:
        # Need to shrink
        new_w = int(w * scale)
        new_h = int(h * scale)
        resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    else:
        # Keep original size
        resized = image
        new_w, new_h = w, h

    # Center in output
    x_offset = (target_width - new_w) // 2
    y_offset = (target_height - new_h) // 2

    output[y_offset:y_offset+new_h, x_offset:x_offset+new_w] = resized

    return output
