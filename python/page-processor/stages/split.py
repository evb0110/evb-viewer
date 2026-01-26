"""
Stage 2: Split Detection and Application

Detects and splits facing pages (double-page spreads) into individual pages.
Uses multiple detection methods with weighted confidence aggregation.

Detection methods:
1. Aspect ratio (weak signal)
2. Vertical projection valley detection
3. Gutter shadow detection
4. Content symmetry analysis
"""

import cv2
import numpy as np
from dataclasses import dataclass, asdict
from typing import Literal, Optional, Tuple, List

from .io import load_image, load_grayscale, save_image
from .geometry import split_horizontal, split_vertical


TSplitType = Literal['none', 'vertical', 'horizontal']


@dataclass
class SplitResult:
    """Result of split detection."""
    should_split: bool
    split_type: TSplitType
    position: float  # 0-1 normalized
    confidence: float  # 0-1
    method_used: str
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


@dataclass
class ValleyResult:
    """Result of vertical valley detection."""
    confidence: float
    position: float


@dataclass
class GutterResult:
    """Result of gutter shadow detection."""
    confidence: float
    position: float


@dataclass
class SymmetryResult:
    """Result of content symmetry detection."""
    confidence: float
    position: float


def detect_split(
    image_path: str,
    min_confidence: float = 0.6,
) -> SplitResult:
    """
    Multi-method split detection for facing pages.

    Uses multiple detection methods and combines results:
    1. Aspect ratio (weak signal only)
    2. Vertical projection valley
    3. Gutter shadow detection
    4. Content symmetry analysis

    Args:
        image_path: Path to input image
        min_confidence: Minimum confidence threshold for split decision

    Returns:
        SplitResult with detection results and confidence
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape
    aspect_ratio = w / h

    # Method 1: Aspect ratio (weak indicator only)
    # Book spreads are typically 1.15-1.8 wide
    # But this alone is NOT sufficient - just adds weak signal
    aspect_suggests_split = 1.15 < aspect_ratio < 1.8
    aspect_confidence = 0.3 if aspect_suggests_split else 0.0

    # Method 2: Vertical projection profile
    valley_result = detect_vertical_valley(gray)

    # Method 3: Gutter shadow detection
    gutter_result = detect_gutter_shadow(gray)

    # Method 4: Content symmetry
    symmetry_result = detect_content_symmetry(gray)

    # Combine results with weighted voting
    # Weights: valley > gutter > symmetry > aspect
    weights = {
        'aspect': 0.1,
        'valley': 0.4,
        'gutter': 0.3,
        'symmetry': 0.2,
    }

    methods = [
        ('aspect', aspect_confidence, 0.5),
        ('valley', valley_result.confidence, valley_result.position),
        ('gutter', gutter_result.confidence, gutter_result.position),
        ('symmetry', symmetry_result.confidence, symmetry_result.position),
    ]

    # Calculate total weighted confidence
    total_confidence = sum(m[1] * weights[m[0]] for m in methods)

    # Find best position estimate from methods with confidence > 0.3
    position_votes = [
        (m[2], m[1] * weights[m[0]])
        for m in methods
        if m[1] > 0.3
    ]

    if position_votes:
        total_weight = sum(w for _, w in position_votes)
        if total_weight > 0:
            weighted_position = sum(p * w for p, w in position_votes) / total_weight
        else:
            weighted_position = 0.5
    else:
        weighted_position = 0.5

    # Determine best method for debugging
    method_scores = {m[0]: m[1] * weights[m[0]] for m in methods}
    best_method = max(method_scores, key=method_scores.get)

    should_split = total_confidence >= min_confidence

    return SplitResult(
        should_split=should_split,
        split_type='vertical' if should_split else 'none',
        position=weighted_position,
        confidence=min(1.0, total_confidence),
        method_used=best_method,
        debug={
            'aspect_ratio': aspect_ratio,
            'aspect_confidence': aspect_confidence,
            'valley_confidence': valley_result.confidence,
            'valley_position': valley_result.position,
            'gutter_confidence': gutter_result.confidence,
            'gutter_position': gutter_result.position,
            'symmetry_confidence': symmetry_result.confidence,
            'symmetry_position': symmetry_result.position,
            'method_scores': method_scores,
            'position_votes': [(p, w) for p, w in position_votes],
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_vertical_valley(gray: np.ndarray) -> ValleyResult:
    """
    Detect valley (minimum) in vertical projection profile.

    Book gutters appear as vertical strip with less content,
    creating a valley in the horizontal projection.

    Args:
        gray: Grayscale image

    Returns:
        ValleyResult with confidence and position
    """
    h, w = gray.shape

    # Focus on center 60% of image (gutter is always roughly center)
    center_start = int(w * 0.2)
    center_end = int(w * 0.8)
    center_region = gray[:, center_start:center_end]

    # Calculate vertical projection (sum along columns)
    # Invert so text areas have high values
    inverted = 255 - center_region
    projection = np.sum(inverted.astype(np.float64), axis=0)

    if len(projection) == 0:
        return ValleyResult(confidence=0.0, position=0.5)

    # Smooth to reduce noise
    kernel_size = max(5, w // 50)
    if kernel_size % 2 == 0:
        kernel_size += 1

    smoothed = cv2.GaussianBlur(
        projection.reshape(1, -1).astype(np.float32),
        (kernel_size, 1),
        0
    ).flatten()

    # Find minimum (valley) in smoothed projection
    min_idx = np.argmin(smoothed)
    min_val = smoothed[min_idx]

    # Calculate confidence based on valley depth
    max_val = np.max(smoothed)
    mean_val = np.mean(smoothed)

    if max_val == 0 or mean_val == 0:
        return ValleyResult(confidence=0.0, position=0.5)

    # Valley should be significantly below mean
    valley_depth = (mean_val - min_val) / mean_val

    # Convert local position to global position
    global_position = (center_start + min_idx) / w

    # Confidence based on valley prominence
    # Scale so 50% depth = 100% confidence
    confidence = min(1.0, valley_depth * 2)

    return ValleyResult(confidence=confidence, position=global_position)


def detect_gutter_shadow(gray: np.ndarray) -> GutterResult:
    """
    Detect gutter shadow - the dark vertical band where book binding creates shadow.

    Args:
        gray: Grayscale image

    Returns:
        GutterResult with confidence and position
    """
    h, w = gray.shape

    # Focus on center 30% region (tighter focus than valley detection)
    center_start = int(w * 0.35)
    center_end = int(w * 0.65)
    center_region = gray[:, center_start:center_end]

    # Calculate column-wise mean intensity
    column_means = np.mean(center_region.astype(np.float64), axis=0)

    if len(column_means) == 0:
        return GutterResult(confidence=0.0, position=0.5)

    # Find darkest vertical strip (potential gutter shadow)
    # Use sliding window to find consistent dark region
    window_size = max(3, (center_end - center_start) // 20)

    min_avg = float('inf')
    min_pos = len(column_means) // 2

    for i in range(len(column_means) - window_size):
        window_avg = np.mean(column_means[i:i+window_size])
        if window_avg < min_avg:
            min_avg = window_avg
            min_pos = i + window_size // 2

    # Calculate confidence based on how much darker gutter is
    overall_mean = np.mean(column_means)

    if overall_mean == 0:
        return GutterResult(confidence=0.0, position=0.5)

    # Darkness ratio: lower = darker gutter
    darkness_ratio = min_avg / overall_mean

    # Convert to confidence (1 - ratio, scaled up)
    confidence = max(0, 1 - darkness_ratio) * 1.5
    confidence = min(1.0, confidence)

    # Convert to global position
    global_position = (center_start + min_pos) / w

    return GutterResult(confidence=confidence, position=global_position)


def detect_content_symmetry(gray: np.ndarray) -> SymmetryResult:
    """
    Detect if image has two symmetric content regions (left/right pages).

    Compares vertical alignment and size of content on left and right halves.

    Args:
        gray: Grayscale image

    Returns:
        SymmetryResult with confidence and position (always 0.5 for symmetry)
    """
    h, w = gray.shape

    # Threshold to binary
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Find content bounding boxes on left and right halves
    left_half = binary[:, :w//2]
    right_half = binary[:, w//2:]

    left_bounds = find_content_bounds(left_half)
    right_bounds = find_content_bounds(right_half)

    if left_bounds is None or right_bounds is None:
        return SymmetryResult(confidence=0.0, position=0.5)

    lx, ly, lw, lh = left_bounds
    rx, ry, rw, rh = right_bounds

    # Check vertical alignment similarity
    left_y_center = ly + lh / 2
    right_y_center = ry + rh / 2

    y_diff = abs(left_y_center - right_y_center) / h

    # Check height similarity
    left_height = lh
    right_height = rh

    if max(left_height, right_height) == 0:
        height_ratio = 0
    else:
        height_ratio = min(left_height, right_height) / max(left_height, right_height)

    # Check width similarity (both halves should have similar content width)
    if max(lw, rw) == 0:
        width_ratio = 0
    else:
        width_ratio = min(lw, rw) / max(lw, rw)

    # Confidence based on alignment, height similarity, and width similarity
    alignment_score = max(0, 1 - y_diff * 10)  # 10% difference = 0 score
    height_score = height_ratio
    width_score = width_ratio

    confidence = (alignment_score * 0.4 + height_score * 0.3 + width_score * 0.3)

    return SymmetryResult(confidence=confidence, position=0.5)


def find_content_bounds(binary: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """
    Find bounding box of content in binary image.

    Args:
        binary: Binary image (white content on black background)

    Returns:
        Tuple of (x, y, width, height) or None if no content found
    """
    coords = cv2.findNonZero(binary)

    if coords is None:
        return None

    return cv2.boundingRect(coords)


def apply_split(
    image_path: str,
    output_dir: str,
    split_type: TSplitType,
    position: float = 0.5,
    overlap: int = 0,
) -> dict:
    """
    Apply split to image.

    Args:
        image_path: Path to input image
        output_dir: Directory for output images
        split_type: Type of split ('none', 'vertical', 'horizontal')
        position: Split position (0-1 normalized)
        overlap: Pixels to include from each side of split

    Returns:
        Result dictionary with output paths and metadata
    """
    from pathlib import Path

    image = load_image(image_path)
    h, w = image.shape[:2]

    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    input_stem = Path(image_path).stem

    if split_type == 'none':
        # No split - just copy
        output_path = output_dir_path / f"{input_stem}.png"
        saved_path = save_image(image, str(output_path))

        return {
            'success': True,
            'split_applied': False,
            'split_type': 'none',
            'output_paths': [saved_path],
            'page_count': 1,
            'original_size': {'width': w, 'height': h},
        }

    elif split_type == 'vertical':
        # Split into left and right pages
        left, right = split_horizontal(image, position, overlap)

        left_path = output_dir_path / f"{input_stem}_1.png"
        right_path = output_dir_path / f"{input_stem}_2.png"

        left_saved = save_image(left, str(left_path))
        right_saved = save_image(right, str(right_path))

        return {
            'success': True,
            'split_applied': True,
            'split_type': 'vertical',
            'split_position': position,
            'overlap': overlap,
            'output_paths': [left_saved, right_saved],
            'page_count': 2,
            'original_size': {'width': w, 'height': h},
            'output_sizes': [
                {'width': left.shape[1], 'height': left.shape[0]},
                {'width': right.shape[1], 'height': right.shape[0]},
            ],
        }

    elif split_type == 'horizontal':
        # Split into top and bottom pages
        top, bottom = split_vertical(image, position, overlap)

        top_path = output_dir_path / f"{input_stem}_1.png"
        bottom_path = output_dir_path / f"{input_stem}_2.png"

        top_saved = save_image(top, str(top_path))
        bottom_saved = save_image(bottom, str(bottom_path))

        return {
            'success': True,
            'split_applied': True,
            'split_type': 'horizontal',
            'split_position': position,
            'overlap': overlap,
            'output_paths': [top_saved, bottom_saved],
            'page_count': 2,
            'original_size': {'width': w, 'height': h},
            'output_sizes': [
                {'width': top.shape[1], 'height': top.shape[0]},
                {'width': bottom.shape[1], 'height': bottom.shape[0]},
            ],
        }

    else:
        raise ValueError(f"Unknown split type: {split_type}")
