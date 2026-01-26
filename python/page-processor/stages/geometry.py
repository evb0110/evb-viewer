"""
Geometry utilities for stage processing.

Provides rotation, transformation, and coordinate helpers.
"""

import cv2
import numpy as np
from typing import Tuple, Optional


def rotate_90(image: np.ndarray, times: int = 1) -> np.ndarray:
    """
    Rotate image by 90 degree increments.

    Args:
        image: Input image
        times: Number of 90 degree rotations (1=90CW, 2=180, 3=270CW/-90)

    Returns:
        Rotated image
    """
    times = times % 4

    if times == 0:
        return image.copy()
    elif times == 1:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    elif times == 2:
        return cv2.rotate(image, cv2.ROTATE_180)
    elif times == 3:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)

    return image


def rotate_angle(
    image: np.ndarray,
    angle: float,
    background_color: Tuple[int, int, int] = (255, 255, 255),
    expand: bool = True,
) -> np.ndarray:
    """
    Rotate image by arbitrary angle.

    Args:
        image: Input image
        angle: Rotation angle in degrees (positive = counterclockwise)
        background_color: Color for exposed corners
        expand: If True, expand canvas to fit rotated image

    Returns:
        Rotated image
    """
    if abs(angle) < 0.01:
        return image.copy()

    h, w = image.shape[:2]
    center = (w / 2, h / 2)

    # Get rotation matrix
    rotation_matrix = cv2.getRotationMatrix2D(center, angle, 1.0)

    if expand:
        # Calculate new bounding box size
        cos = abs(rotation_matrix[0, 0])
        sin = abs(rotation_matrix[0, 1])
        new_w = int(h * sin + w * cos)
        new_h = int(h * cos + w * sin)

        # Adjust rotation matrix for new center
        rotation_matrix[0, 2] += (new_w - w) / 2
        rotation_matrix[1, 2] += (new_h - h) / 2
    else:
        new_w, new_h = w, h

    # Handle grayscale images
    if len(image.shape) == 2:
        bg = background_color[0]
    else:
        bg = background_color

    rotated = cv2.warpAffine(
        image,
        rotation_matrix,
        (new_w, new_h),
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=bg,
    )

    return rotated


def split_horizontal(
    image: np.ndarray,
    position: float = 0.5,
    overlap: int = 0,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Split image horizontally into left and right halves.

    Args:
        image: Input image
        position: Split position (0-1 normalized, default 0.5 = center)
        overlap: Pixels to include from each side of split

    Returns:
        Tuple of (left_image, right_image)
    """
    h, w = image.shape[:2]
    split_x = int(w * position)

    left_end = min(split_x + overlap, w)
    right_start = max(split_x - overlap, 0)

    left = image[:, :left_end].copy()
    right = image[:, right_start:].copy()

    return left, right


def split_vertical(
    image: np.ndarray,
    position: float = 0.5,
    overlap: int = 0,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Split image vertically into top and bottom halves.

    Args:
        image: Input image
        position: Split position (0-1 normalized, default 0.5 = center)
        overlap: Pixels to include from each side of split

    Returns:
        Tuple of (top_image, bottom_image)
    """
    h, w = image.shape[:2]
    split_y = int(h * position)

    top_end = min(split_y + overlap, h)
    bottom_start = max(split_y - overlap, 0)

    top = image[:top_end, :].copy()
    bottom = image[bottom_start:, :].copy()

    return top, bottom


def crop_rect(
    image: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
    padding: int = 0,
) -> np.ndarray:
    """
    Crop a rectangular region from image.

    Args:
        image: Input image
        x, y: Top-left corner coordinates
        width, height: Region dimensions
        padding: Additional padding to include

    Returns:
        Cropped image region
    """
    h, w = image.shape[:2]

    # Apply padding with bounds checking
    x1 = max(0, x - padding)
    y1 = max(0, y - padding)
    x2 = min(w, x + width + padding)
    y2 = min(h, y + height + padding)

    return image[y1:y2, x1:x2].copy()


def normalize_coordinates(
    x: int,
    y: int,
    width: int,
    height: int,
    image_width: int,
    image_height: int,
) -> Tuple[float, float, float, float]:
    """
    Convert pixel coordinates to normalized (0-1) coordinates.

    Args:
        x, y: Top-left corner in pixels
        width, height: Region dimensions in pixels
        image_width, image_height: Image dimensions

    Returns:
        Tuple of (x, y, width, height) in normalized coordinates
    """
    return (
        x / image_width,
        y / image_height,
        width / image_width,
        height / image_height,
    )


def denormalize_coordinates(
    x: float,
    y: float,
    width: float,
    height: float,
    image_width: int,
    image_height: int,
) -> Tuple[int, int, int, int]:
    """
    Convert normalized (0-1) coordinates to pixel coordinates.

    Args:
        x, y: Top-left corner (0-1)
        width, height: Region dimensions (0-1)
        image_width, image_height: Image dimensions

    Returns:
        Tuple of (x, y, width, height) in pixel coordinates
    """
    return (
        int(x * image_width),
        int(y * image_height),
        int(width * image_width),
        int(height * image_height),
    )


def calculate_rotation_bounds(
    width: int,
    height: int,
    angle: float,
) -> Tuple[int, int]:
    """
    Calculate new dimensions after rotation.

    Args:
        width, height: Original dimensions
        angle: Rotation angle in degrees

    Returns:
        Tuple of (new_width, new_height)
    """
    angle_rad = np.radians(abs(angle))
    cos = np.cos(angle_rad)
    sin = np.sin(angle_rad)

    new_w = int(height * sin + width * cos)
    new_h = int(height * cos + width * sin)

    return new_w, new_h


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Order 4 points in clockwise order: top-left, top-right, bottom-right, bottom-left.

    Args:
        pts: Array of 4 points

    Returns:
        Ordered points array
    """
    rect = np.zeros((4, 2), dtype=np.float32)

    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # Top-left: smallest sum
    rect[2] = pts[np.argmax(s)]  # Bottom-right: largest sum

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # Top-right: smallest difference
    rect[3] = pts[np.argmax(diff)]  # Bottom-left: largest difference

    return rect


def perspective_transform(
    image: np.ndarray,
    src_points: np.ndarray,
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> np.ndarray:
    """
    Apply perspective transform to straighten a quadrilateral region.

    Args:
        image: Input image
        src_points: 4 corner points of source quadrilateral
        width: Output width (auto-calculated if None)
        height: Output height (auto-calculated if None)

    Returns:
        Perspective-corrected image
    """
    rect = order_points(src_points)
    tl, tr, br, bl = rect

    if width is None:
        width_a = np.linalg.norm(br - bl)
        width_b = np.linalg.norm(tr - tl)
        width = int(max(width_a, width_b))

    if height is None:
        height_a = np.linalg.norm(tr - br)
        height_b = np.linalg.norm(tl - bl)
        height = int(max(height_a, height_b))

    dst_points = np.array([
        [0, 0],
        [width - 1, 0],
        [width - 1, height - 1],
        [0, height - 1]
    ], dtype=np.float32)

    matrix = cv2.getPerspectiveTransform(rect, dst_points)
    warped = cv2.warpPerspective(image, matrix, (width, height))

    return warped
