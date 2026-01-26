"""
Stage 3b: Dewarp Detection and Correction

Detects and corrects page curvature (warping from book spine).
Uses page_dewarp library for cubic spline-based dewarping.

This stage typically runs after deskew and before split detection.
"""

import cv2
import numpy as np
import tempfile
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, Tuple

from .io import load_image, load_grayscale, save_image

# Try to import page_dewarp
try:
    from page_dewarp import dewarp as pd_dewarp
    PAGE_DEWARP_AVAILABLE = True
except ImportError:
    PAGE_DEWARP_AVAILABLE = False


@dataclass
class DewarpResult:
    """Result of dewarp detection."""
    needs_dewarp: bool
    curvature_score: float  # 0-1, higher = more curvature
    confidence: float
    method_used: str
    tool_available: bool
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


def detect_dewarp(
    image_path: str,
    min_curvature: float = 0.1,
) -> DewarpResult:
    """
    Detect if page has significant curvature that needs correction.

    Uses text line curvature analysis to estimate warping.

    Args:
        image_path: Path to input image
        min_curvature: Minimum curvature score to trigger dewarping

    Returns:
        DewarpResult with curvature assessment
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape

    # Detect curvature using text line analysis
    curvature_result = detect_curvature_lines(gray)

    needs_dewarp = (
        curvature_result['score'] >= min_curvature and
        PAGE_DEWARP_AVAILABLE
    )

    return DewarpResult(
        needs_dewarp=needs_dewarp,
        curvature_score=curvature_result['score'],
        confidence=curvature_result['confidence'],
        method_used='text_line_curvature',
        tool_available=PAGE_DEWARP_AVAILABLE,
        debug={
            'curvature_score': curvature_result['score'],
            'num_lines_analyzed': curvature_result['num_lines'],
            'avg_curvature': curvature_result['avg_curvature'],
            'max_curvature': curvature_result['max_curvature'],
            'min_curvature_threshold': min_curvature,
            'page_dewarp_available': PAGE_DEWARP_AVAILABLE,
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_curvature_lines(gray: np.ndarray) -> dict:
    """
    Detect page curvature by analyzing text line bending.

    Args:
        gray: Grayscale image

    Returns:
        Dictionary with curvature analysis results
    """
    h, w = gray.shape

    # Threshold to get binary image
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Morphological operations to connect text into lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 20, 1))
    dilated = cv2.dilate(binary, kernel, iterations=1)

    # Find contours (text lines)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Filter for likely text lines (wide, not too tall)
    text_lines = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if cw > w * 0.3 and ch < h * 0.1:  # Wide and not too tall
            text_lines.append(contour)

    if len(text_lines) < 3:
        return {
            'score': 0.0,
            'confidence': 0.0,
            'num_lines': 0,
            'avg_curvature': 0.0,
            'max_curvature': 0.0,
        }

    # Analyze curvature of each text line
    curvatures = []

    for contour in text_lines:
        # Fit a polynomial to the contour points
        points = contour.reshape(-1, 2)

        if len(points) < 10:
            continue

        # Sort by x coordinate
        sorted_indices = points[:, 0].argsort()
        points = points[sorted_indices]
        x_coords = points[:, 0].astype(np.float64)
        y_coords = points[:, 1].astype(np.float64)

        try:
            # Fit quadratic polynomial (parabola)
            coeffs = np.polyfit(x_coords, y_coords, 2)

            # Curvature is related to the quadratic coefficient
            # Normalize by width for scale independence
            curvature = abs(coeffs[0]) * w
            curvatures.append(curvature)
        except (np.RankWarning, np.linalg.LinAlgError):
            continue

    if not curvatures:
        return {
            'score': 0.0,
            'confidence': 0.0,
            'num_lines': len(text_lines),
            'avg_curvature': 0.0,
            'max_curvature': 0.0,
        }

    # Calculate statistics
    avg_curvature = float(np.mean(curvatures))
    max_curvature = float(np.max(curvatures))

    # Normalize score to 0-1 range
    # Typical curvature values: 0-2 for flat, 2-10 for slight curve, 10+ for significant
    score = min(1.0, avg_curvature / 10)

    # Confidence based on number of lines analyzed
    confidence = min(1.0, len(curvatures) / 10)

    return {
        'score': score,
        'confidence': confidence,
        'num_lines': len(curvatures),
        'avg_curvature': avg_curvature,
        'max_curvature': max_curvature,
    }


def apply_dewarp(
    image_path: str,
    output_path: str,
) -> dict:
    """
    Apply dewarping to image using page_dewarp library.

    Args:
        image_path: Path to input image
        output_path: Path for output image

    Returns:
        Result dictionary with output path and metadata
    """
    image = load_image(image_path)
    h, w = image.shape[:2]

    if not PAGE_DEWARP_AVAILABLE:
        # Fallback: copy original
        saved_path = save_image(image, output_path)
        return {
            'success': True,
            'output_path': saved_path,
            'dewarp_applied': False,
            'reason': 'page_dewarp library not available',
            'original_size': {'width': w, 'height': h},
            'output_size': {'width': w, 'height': h},
        }

    # page-dewarp works on files, so we need temp files
    with tempfile.TemporaryDirectory() as tmpdir:
        # Save input image
        input_temp = os.path.join(tmpdir, "input.png")
        cv2.imwrite(input_temp, image)

        try:
            # Run page-dewarp
            pd_dewarp(input_temp)

            # Check for output files (page-dewarp creates various suffixed files)
            possible_outputs = [
                os.path.join(tmpdir, "input_thresh.png"),
                os.path.join(tmpdir, "input_dewarped.png"),
                os.path.join(tmpdir, "input.png"),  # Sometimes overwrites
            ]

            result_image = None
            for output_temp in possible_outputs:
                if os.path.exists(output_temp) and output_temp != input_temp:
                    result_image = cv2.imread(output_temp)
                    if result_image is not None:
                        break

            if result_image is None:
                # Dewarping didn't produce output, use original
                result_image = image
                dewarp_applied = False
                reason = 'page_dewarp produced no output'
            else:
                dewarp_applied = True
                reason = None

        except Exception as e:
            # Dewarping failed, use original
            result_image = image
            dewarp_applied = False
            reason = f'page_dewarp failed: {str(e)}'

    new_h, new_w = result_image.shape[:2]
    saved_path = save_image(result_image, output_path)

    result = {
        'success': True,
        'output_path': saved_path,
        'dewarp_applied': dewarp_applied,
        'original_size': {'width': w, 'height': h},
        'output_size': {'width': new_w, 'height': new_h},
    }

    if reason:
        result['reason'] = reason

    return result
