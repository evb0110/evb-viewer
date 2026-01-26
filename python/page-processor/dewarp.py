"""
Dewarping Module

Removes page curvature from scanned book pages.

Uses page-dewarp library for cubic spline-based dewarping.
"""

import cv2
import numpy as np
import tempfile
import os
from pathlib import Path

# page_dewarp pulls heavy deps (matplotlib/sympy). Import it only when dewarp is requested.
_pd_dewarp = None
_pd_dewarp_available = None


def _load_page_dewarp():
    global _pd_dewarp, _pd_dewarp_available
    if _pd_dewarp_available is not None:
        return
    try:
        from page_dewarp import dewarp as pd_dewarp  # type: ignore
        _pd_dewarp = pd_dewarp
        _pd_dewarp_available = True
    except Exception:
        _pd_dewarp = None
        _pd_dewarp_available = False


def dewarp_page(image: np.ndarray) -> np.ndarray:
    """
    Remove page curvature (dewarping).

    Args:
        image: Input image (BGR format)

    Returns:
        Dewarped image
    """
    _load_page_dewarp()
    if not _pd_dewarp_available or _pd_dewarp is None:
        # Fallback: return original if page-dewarp not available
        return image

    # page-dewarp works on files, so we need to use temp files
    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "input.png")
        output_path = os.path.join(tmpdir, "input_thresh.png")

        # Save input image
        cv2.imwrite(input_path, image)

        try:
            # Run page-dewarp
            # Note: page-dewarp creates output with _thresh suffix
            _pd_dewarp(input_path)

            # Check for output file
            if os.path.exists(output_path):
                result = cv2.imread(output_path)
                if result is not None:
                    return result

            # Also check for non-thresholded output
            output_path_alt = os.path.join(tmpdir, "input_dewarped.png")
            if os.path.exists(output_path_alt):
                result = cv2.imread(output_path_alt)
                if result is not None:
                    return result

        except Exception as e:
            # Log error but return original
            print(f"Dewarp failed: {e}", file=__import__('sys').stderr)

    # Return original if dewarping failed
    return image


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Order points in clockwise order: top-left, top-right, bottom-right, bottom-left.
    """
    rect = np.zeros((4, 2), dtype=np.float32)

    # Top-left has smallest sum, bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Top-right has smallest difference, bottom-left has largest difference
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect
