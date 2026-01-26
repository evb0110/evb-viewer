"""
Stage 3: Deskew Detection and Correction

Detects and corrects page skew (small rotation angles) using:
1. Hough transform line detection
2. Text line angle analysis
3. Edge orientation statistics
"""

import cv2
import numpy as np
from dataclasses import dataclass, asdict
from typing import Optional, List, Tuple

from .io import load_image, load_grayscale, save_image
from .geometry import rotate_angle

# Legacy note: we previously supported the `deskew` library, but we now use OpenCV-only
# methods for performance and packaging simplicity.
DESKEW_LIB_AVAILABLE = False


@dataclass
class DeskewResult:
    """Result of deskew detection."""
    angle: float  # Degrees to rotate (positive = counterclockwise)
    confidence: float  # 0-1
    method_used: str
    needs_correction: bool
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


def detect_deskew(
    image_path: str,
    min_angle: float = 0.5,
    max_angle: float = 15.0,
) -> DeskewResult:
    """
    Detect skew angle of page.

    Uses multiple methods:
    1. Hough transform for line detection
    2. Projection profile analysis
    3. deskew library (if available)

    Args:
        image_path: Path to input image
        min_angle: Minimum angle threshold for correction
        max_angle: Maximum expected angle (larger angles likely errors)

    Returns:
        DeskewResult with detected angle and confidence
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape

    # Method 1: Hough transform
    hough_result = detect_skew_hough(gray, max_angle)

    # Method 2: Projection profile
    projection_result = detect_skew_projection(gray, max_angle)

    # Combine results with weighted voting
    weights = {
        'hough': 0.4,
        'projection': 0.3,
    }

    # Normalize weights (no library method).
    weights['hough'] = 0.55
    weights['projection'] = 0.45

    methods = [
        ('hough', hough_result['angle'], hough_result['confidence']),
        ('projection', projection_result['angle'], projection_result['confidence']),
    ]

    # Calculate weighted angle and confidence
    total_weight = sum(m[2] * weights[m[0]] for m in methods)

    if total_weight == 0:
        final_angle = 0.0
        final_confidence = 0.0
    else:
        # Weighted average of angles
        weighted_sum = sum(m[1] * m[2] * weights[m[0]] for m in methods)
        final_angle = weighted_sum / total_weight

        # Confidence is weighted average of method confidences
        final_confidence = sum(m[2] * weights[m[0]] for m in methods)

    # Clamp angle to max_angle
    if abs(final_angle) > max_angle:
        final_angle = np.sign(final_angle) * max_angle
        final_confidence *= 0.5  # Reduce confidence for clamped angles

    # Determine if correction is needed
    needs_correction = abs(final_angle) >= min_angle

    # Find best method
    method_scores = {m[0]: m[2] * weights[m[0]] for m in methods}
    best_method = max(method_scores, key=method_scores.get)

    return DeskewResult(
        angle=round(final_angle, 3),
        confidence=min(1.0, final_confidence),
        method_used=best_method,
        needs_correction=needs_correction,
        debug={
            'hough_angle': hough_result['angle'],
            'hough_confidence': hough_result['confidence'],
            'hough_lines_count': hough_result.get('lines_count', 0),
            'projection_angle': projection_result['angle'],
            'projection_confidence': projection_result['confidence'],
            'library_available': False,
            'library_angle': 0.0,
            'library_confidence': 0.0,
            'method_scores': method_scores,
            'min_angle_threshold': min_angle,
            'max_angle_limit': max_angle,
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_skew_hough(
    gray: np.ndarray,
    max_angle: float = 15.0,
) -> dict:
    """
    Detect skew using Hough line transform.

    Finds dominant line angles in the image and calculates
    the median deviation from horizontal.

    Args:
        gray: Grayscale image
        max_angle: Maximum expected skew angle

    Returns:
        Dictionary with angle and confidence
    """
    h, w = gray.shape

    # Apply edge detection
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    # Apply morphological operations to connect text
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 30, 1))
    dilated = cv2.dilate(edges, kernel, iterations=1)

    # Hough line detection
    lines = cv2.HoughLinesP(
        dilated,
        rho=1,
        theta=np.pi / 180,
        threshold=100,
        minLineLength=w // 8,
        maxLineGap=w // 20,
    )

    if lines is None or len(lines) == 0:
        return {'angle': 0.0, 'confidence': 0.0, 'lines_count': 0}

    # Calculate angles of all lines
    angles = []
    line_lengths = []

    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = x2 - x1
        dy = y2 - y1

        if abs(dx) < 1:
            continue  # Skip vertical lines

        angle = np.arctan2(dy, dx) * 180 / np.pi
        length = np.sqrt(dx**2 + dy**2)

        # Only consider near-horizontal lines (likely text lines)
        if abs(angle) <= max_angle:
            angles.append(angle)
            line_lengths.append(length)

    if not angles:
        return {'angle': 0.0, 'confidence': 0.0, 'lines_count': len(lines)}

    # Weight by line length
    total_length = sum(line_lengths)
    if total_length == 0:
        weighted_angle = np.median(angles)
    else:
        weighted_angle = sum(a * l for a, l in zip(angles, line_lengths)) / total_length

    # Calculate confidence based on angle consistency
    angle_std = np.std(angles) if len(angles) > 1 else 0.0
    consistency_score = max(0, 1 - angle_std / 5)  # 5 degree std = 0 confidence

    # More lines = higher confidence
    count_score = min(1.0, len(angles) / 20)  # 20+ lines = max confidence

    confidence = consistency_score * 0.7 + count_score * 0.3

    return {
        'angle': weighted_angle,
        'confidence': confidence,
        'lines_count': len(angles),
        'angle_std': angle_std,
    }


def detect_skew_projection(
    gray: np.ndarray,
    max_angle: float = 15.0,
) -> dict:
    """
    Detect skew using projection profile analysis.

    Rotates the image at various angles and finds the angle
    that produces the sharpest horizontal projection profile.

    Args:
        gray: Grayscale image
        max_angle: Maximum angle to test

    Returns:
        Dictionary with angle and confidence
    """
    h, w = gray.shape

    # Binarize
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Test angles from -max_angle to +max_angle
    angles_to_test = np.linspace(-max_angle, max_angle, 31)
    best_angle = 0.0
    best_score = 0.0

    # Calculate score for each angle
    scores = []

    for angle in angles_to_test:
        # Rotate binary image
        center = (w / 2, h / 2)
        matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(binary, matrix, (w, h), borderValue=0)

        # Calculate horizontal projection
        projection = np.sum(rotated, axis=1)

        # Score is variance of projection (higher = sharper peaks)
        score = np.var(projection)
        scores.append(score)

        if score > best_score:
            best_score = score
            best_angle = angle

    # Refine best angle with finer search
    fine_angles = np.linspace(best_angle - 1.0, best_angle + 1.0, 21)
    for angle in fine_angles:
        center = (w / 2, h / 2)
        matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(binary, matrix, (w, h), borderValue=0)
        projection = np.sum(rotated, axis=1)
        score = np.var(projection)

        if score > best_score:
            best_score = score
            best_angle = angle

    # Calculate confidence
    # Compare best score to median score
    median_score = np.median(scores)
    if median_score == 0:
        confidence = 0.0
    else:
        score_ratio = best_score / median_score
        confidence = min(1.0, (score_ratio - 1) / 0.5)  # 50% improvement = full confidence

    return {
        'angle': best_angle,
        'confidence': max(0, confidence),
    }


def detect_skew_library(
    gray: np.ndarray,
    max_angle: float = 15.0,
) -> dict:
    """
    Legacy stub kept for compatibility with older stage debugging.
    The external `deskew` dependency was removed; always returns no correction.
    """
    _ = gray
    _ = max_angle
    return {'angle': 0.0, 'confidence': 0.0}


def apply_deskew(
    image_path: str,
    output_path: str,
    angle: float,
    background_color: Tuple[int, int, int] = (255, 255, 255),
) -> dict:
    """
    Apply deskew (rotation) to image.

    Args:
        image_path: Path to input image
        output_path: Path for output image
        angle: Rotation angle in degrees (positive = counterclockwise)
        background_color: Color for exposed corners

    Returns:
        Result dictionary with output path and metadata
    """
    image = load_image(image_path)
    h, w = image.shape[:2]

    if abs(angle) < 0.01:
        # No rotation needed
        rotated = image.copy()
        rotation_applied = False
    else:
        rotated = rotate_angle(image, angle, background_color, expand=True)
        rotation_applied = True

    new_h, new_w = rotated.shape[:2]
    saved_path = save_image(rotated, output_path)

    return {
        'success': True,
        'output_path': saved_path,
        'rotation_applied': rotation_applied,
        'angle_applied': angle if rotation_applied else 0.0,
        'original_size': {'width': w, 'height': h},
        'output_size': {'width': new_w, 'height': new_h},
    }
