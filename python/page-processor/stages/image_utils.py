"""
Shared image utility functions for page processing stages.

These functions are used across multiple modules (detection, split, etc.)
and are collected here to avoid duplication.
"""

import cv2
import numpy as np


def _to_gray(image: np.ndarray) -> np.ndarray:
    """Return a single-channel grayscale image."""
    if len(image.shape) == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image


def _resize_for_analysis(gray: np.ndarray, max_dim: int = 1500) -> tuple[np.ndarray, float]:
    """
    Downscale an image for fast analysis.

    Returns (resized, scale) where scale is the multiplier applied to the original
    dimensions (i.e. resized = original * scale). If no resize is needed, scale=1.0.
    """
    h, w = gray.shape[:2]
    if max(h, w) <= max_dim:
        return gray, 1.0

    scale = max_dim / float(max(h, w))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, scale


def _smooth_1d(values: np.ndarray, kernel_size: int) -> np.ndarray:
    if values.size == 0:
        return values
    k = max(3, int(kernel_size))
    if k % 2 == 0:
        k += 1
    return cv2.GaussianBlur(values.reshape(1, -1).astype(np.float32), (k, 1), 0).reshape(-1)
