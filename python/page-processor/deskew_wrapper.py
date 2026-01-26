"""
Deskew Wrapper

Applies a rotation correction given an angle. (Detection happens elsewhere.)
"""

import cv2
import numpy as np
import os


def _interp_flag() -> int:
    # For scanned text, interpolation choice matters at small angles.
    # Default to Lanczos for best visual quality (still no resolution loss).
    v = (os.environ.get("PAGE_PROCESSOR_DESKEW_INTERP") or "lanczos").lower().strip()
    if v in ("linear", "bilinear"):
        return cv2.INTER_LINEAR
    if v in ("cubic", "bicubic"):
        return cv2.INTER_CUBIC
    if v in ("area",):
        return cv2.INTER_AREA
    return cv2.INTER_LANCZOS4


def deskew_page(image: np.ndarray, angle: float = None) -> np.ndarray:
    """
    Correct page rotation (skew).

    Args:
        image: Input image (BGR format)
        angle: Rotation angle in degrees (auto-detected if None)

    Returns:
        Deskewed image
    """
    if angle is None:
        # Fallback for direct use: run our fast detector.
        from detection import detect_skew_angle

        angle = detect_skew_angle(image)

    if abs(angle) < 0.1:
        return image  # No rotation needed

    h, w = image.shape[:2]

    # Calculate rotation matrix
    center = (w // 2, h // 2)
    rotation_matrix = cv2.getRotationMatrix2D(center, angle, 1.0)

    # Calculate new bounding box size
    cos = abs(rotation_matrix[0, 0])
    sin = abs(rotation_matrix[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)

    # Adjust the rotation matrix for the new size
    rotation_matrix[0, 2] += (new_w - w) / 2
    rotation_matrix[1, 2] += (new_h - h) / 2

    # Perform rotation with white background
    background_color = (255, 255, 255) if len(image.shape) == 3 else 255
    rotated = cv2.warpAffine(
        image,
        rotation_matrix,
        (new_w, new_h),
        flags=_interp_flag(),
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=background_color,
    )

    return rotated
