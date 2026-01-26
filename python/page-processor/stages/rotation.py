"""
Stage 1: Rotation Detection and Correction

Detects and corrects page orientation (0, 90, 180, 270 degrees).
Uses text line orientation and edge analysis for robust detection.
"""

import cv2
import numpy as np
from dataclasses import dataclass, asdict
from typing import Literal

from .io import load_image, load_grayscale, save_image
from .geometry import rotate_90


TRotation = Literal[0, 90, 180, 270]


@dataclass
class RotationResult:
    """Result of rotation detection."""
    rotation: TRotation
    confidence: float
    method_used: str
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


def detect_rotation(image_path: str) -> RotationResult:
    """
    Detect optimal rotation for correct page orientation.

    Uses multiple methods:
    1. Text line angle distribution
    2. Edge orientation analysis
    3. Aspect ratio heuristics

    Args:
        image_path: Path to input image

    Returns:
        RotationResult with detected rotation and confidence
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape

    # Method 1: Text line orientation
    text_result = detect_text_orientation(gray)

    # Method 2: Edge orientation
    edge_result = detect_edge_orientation(gray)

    # Method 3: Content distribution (for photos/illustrations)
    content_result = detect_content_orientation(gray)

    # Combine results with weighted voting
    candidates = {
        0: 0.0,
        90: 0.0,
        180: 0.0,
        270: 0.0,
    }

    # Weight: text > edge > content
    weights = {'text': 0.5, 'edge': 0.3, 'content': 0.2}

    for rotation, conf in text_result.items():
        candidates[rotation] += conf * weights['text']

    for rotation, conf in edge_result.items():
        candidates[rotation] += conf * weights['edge']

    for rotation, conf in content_result.items():
        candidates[rotation] += conf * weights['content']

    # Find best rotation
    best_rotation = max(candidates, key=candidates.get)
    confidence = candidates[best_rotation]

    # Determine which method contributed most
    method_contributions = {
        'text': text_result.get(best_rotation, 0) * weights['text'],
        'edge': edge_result.get(best_rotation, 0) * weights['edge'],
        'content': content_result.get(best_rotation, 0) * weights['content'],
    }
    method_used = max(method_contributions, key=method_contributions.get)

    return RotationResult(
        rotation=best_rotation,
        confidence=min(1.0, confidence),
        method_used=method_used,
        debug={
            'text_scores': text_result,
            'edge_scores': edge_result,
            'content_scores': content_result,
            'combined_scores': candidates,
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_text_orientation(gray: np.ndarray) -> dict:
    """
    Detect orientation based on text line angles.

    Horizontal text lines suggest correct orientation.
    Vertical text lines suggest 90 or 270 rotation needed.

    Returns:
        Dictionary mapping rotation values to confidence scores
    """
    h, w = gray.shape
    scores = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}

    # Binarize image
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Create horizontal and vertical kernels for line detection
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 20, 1))
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, h // 20))

    # Detect horizontal and vertical structures
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel_h)
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel_v)

    h_count = np.sum(horizontal) / 255
    v_count = np.sum(vertical) / 255

    total = h_count + v_count
    if total == 0:
        return scores

    h_ratio = h_count / total
    v_ratio = v_count / total

    # Horizontal text dominance suggests 0 or 180 rotation
    if h_ratio > v_ratio:
        # Need to distinguish between 0 and 180
        top_half = binary[:h//2, :]
        bottom_half = binary[h//2:, :]

        top_content = np.sum(top_half)
        bottom_content = np.sum(bottom_half)

        if top_content >= bottom_content:
            # More content at top - likely correct (0)
            scores[0] = h_ratio
            scores[180] = h_ratio * 0.3
        else:
            # More content at bottom - might be upside down
            scores[180] = h_ratio * 0.7
            scores[0] = h_ratio * 0.5
    else:
        # Vertical text dominance suggests 90 or 270 rotation
        left_half = binary[:, :w//2]
        right_half = binary[:, w//2:]

        left_content = np.sum(left_half)
        right_content = np.sum(right_half)

        if left_content >= right_content:
            scores[270] = v_ratio
            scores[90] = v_ratio * 0.3
        else:
            scores[90] = v_ratio
            scores[270] = v_ratio * 0.3

    return scores


def detect_edge_orientation(gray: np.ndarray) -> dict:
    """
    Detect orientation based on edge distribution.

    Documents typically have strong horizontal edges at top (header)
    and bottom (footer/page number).

    Returns:
        Dictionary mapping rotation values to confidence scores
    """
    h, w = gray.shape
    scores = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}

    # Detect edges
    edges = cv2.Canny(gray, 50, 150)

    # Calculate edge density in different regions
    margin = int(min(h, w) * 0.1)  # 10% margin

    top_region = edges[:margin, :]
    bottom_region = edges[-margin:, :]
    left_region = edges[:, :margin]
    right_region = edges[:, -margin:]

    top_density = np.sum(top_region) / (margin * w)
    bottom_density = np.sum(bottom_region) / (margin * w)
    left_density = np.sum(left_region) / (margin * h)
    right_density = np.sum(right_region) / (margin * h)

    # Normalize
    max_density = max(top_density, bottom_density, left_density, right_density, 1)
    top_density /= max_density
    bottom_density /= max_density
    left_density /= max_density
    right_density /= max_density

    # Strong top/bottom edges suggest horizontal orientation
    h_strength = (top_density + bottom_density) / 2
    v_strength = (left_density + right_density) / 2

    if h_strength > v_strength:
        # Horizontal edges dominant
        if top_density >= bottom_density:
            scores[0] = h_strength
            scores[180] = h_strength * 0.4
        else:
            scores[180] = h_strength * 0.7
            scores[0] = h_strength * 0.5
    else:
        # Vertical edges dominant
        if left_density >= right_density:
            scores[270] = v_strength
            scores[90] = v_strength * 0.4
        else:
            scores[90] = v_strength * 0.7
            scores[270] = v_strength * 0.5

    return scores


def detect_content_orientation(gray: np.ndarray) -> dict:
    """
    Detect orientation based on content distribution.

    Most documents have more content at top (title/header) than bottom.

    Returns:
        Dictionary mapping rotation values to confidence scores
    """
    h, w = gray.shape
    scores = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}

    # Binarize
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Divide into quadrants
    top_half = binary[:h//2, :]
    bottom_half = binary[h//2:, :]
    left_half = binary[:, :w//2]
    right_half = binary[:, w//2:]

    top_content = np.sum(top_half) / (h * w // 2)
    bottom_content = np.sum(bottom_half) / (h * w // 2)
    left_content = np.sum(left_half) / (h * w // 2)
    right_content = np.sum(right_half) / (h * w // 2)

    # Normalize
    max_content = max(top_content, bottom_content, left_content, right_content, 1)
    top_content /= max_content
    bottom_content /= max_content
    left_content /= max_content
    right_content /= max_content

    # Determine primary axis and direction
    h_diff = abs(top_content - bottom_content)
    v_diff = abs(left_content - right_content)

    if h_diff >= v_diff:
        # Horizontal content difference
        if top_content >= bottom_content:
            scores[0] = h_diff
        else:
            scores[180] = h_diff
    else:
        # Vertical content difference
        if left_content >= right_content:
            scores[270] = v_diff
        else:
            scores[90] = v_diff

    return scores


def apply_rotation(
    image_path: str,
    output_path: str,
    rotation: TRotation,
) -> dict:
    """
    Apply rotation to image.

    Args:
        image_path: Path to input image
        output_path: Path for output image
        rotation: Rotation angle (0, 90, 180, 270)

    Returns:
        Result dictionary with output path and metadata
    """
    image = load_image(image_path)
    h, w = image.shape[:2]

    if rotation == 0:
        rotated = image.copy()
    else:
        times = rotation // 90
        rotated = rotate_90(image, times)

    new_h, new_w = rotated.shape[:2]
    saved_path = save_image(rotated, output_path)

    return {
        'success': True,
        'output_path': saved_path,
        'rotation_applied': rotation,
        'original_size': {'width': w, 'height': h},
        'output_size': {'width': new_w, 'height': new_h},
    }
