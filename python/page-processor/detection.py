"""
Page Characteristic Detection

Detects properties of scanned book pages:
- Facing pages (double-page spread)
- Skew angle (rotation)
- Curvature (warping from book spine)
- Content bounds (for margin cropping)
"""

import cv2
import numpy as np
from typing import Optional

from split import find_gutter_position


def _detect_skew_hough(
    gray: np.ndarray,
    max_angle: float = 15.0,
) -> tuple[float, float]:
    """
    Fast skew detection using Hough lines on a downscaled image.

    Returns the *correction* angle in degrees (positive = CCW rotation).
    """
    h, w = gray.shape[:2]
    if h < 10 or w < 10:
        return 0.0, 0.0

    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    # Connect text edges into longer line segments to improve Hough stability.
    kernel_w = max(10, w // 30)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, 1))
    dilated = cv2.dilate(edges, kernel, iterations=1)

    lines = cv2.HoughLinesP(
        dilated,
        rho=1,
        theta=np.pi / 180,
        threshold=100,
        minLineLength=max(30, w // 8),
        maxLineGap=max(10, w // 20),
    )

    if lines is None or len(lines) == 0:
        return 0.0, 0.0

    angles: list[float] = []
    lengths: list[float] = []

    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = float(x2 - x1)
        dy = float(y2 - y1)
        if abs(dx) < 1.0:
            continue

        angle = float(np.arctan2(dy, dx) * 180.0 / np.pi)
        if abs(angle) > max_angle:
            continue

        length = float(np.hypot(dx, dy))
        angles.append(angle)
        lengths.append(length)

    if not angles:
        return 0.0, 0.0

    total_len = float(np.sum(lengths)) if lengths else 0.0
    if total_len <= 0:
        line_angle = float(np.median(np.array(angles, dtype=np.float64)))
    else:
        line_angle = float(np.sum(np.array(angles) * np.array(lengths)) / total_len)

    # Confidence: we need enough consistent near-horizontal lines.
    # If the image contains lots of diagonals (e.g. illustrations, borders), skew detection can be unstable.
    angle_std = float(np.std(np.array(angles, dtype=np.float64))) if len(angles) > 1 else 0.0
    # 2 degrees std => good, 4 degrees => poor.
    consistency = max(0.0, 1.0 - (angle_std / 4.0))
    # 15 lines => good signal; fewer => lower confidence.
    count_score = min(1.0, float(len(angles)) / 15.0)
    confidence = float(min(1.0, max(0.0, (consistency * 0.7) + (count_score * 0.3))))

    # Hough finds the angle of the text lines; to deskew we rotate in the opposite direction.
    return -line_angle, confidence


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


def _best_saddle_valley(curve: np.ndarray) -> tuple[int, float]:
    """
    Find a valley between two strong peaks (avoids picking outer margins).

    Returns (index, confidence) where confidence is 0-1.
    """
    if curve.size < 3:
        return curve.size // 2, 0.0

    pad = max(5, curve.size // 20)
    if curve.size <= pad * 2 + 1:
        pad = 1

    left_max = np.maximum.accumulate(curve)
    right_max = np.maximum.accumulate(curve[::-1])[::-1]
    left_peak = np.concatenate(([0.0], left_max[:-1]))
    right_peak = np.concatenate((right_max[1:], [0.0]))
    min_peak = np.minimum(left_peak, right_peak)

    score = min_peak - curve
    score[:pad] = -np.inf
    score[-pad:] = -np.inf

    idx = int(np.argmax(score))
    best_score = float(score[idx])
    best_peak = float(min_peak[idx])

    if not np.isfinite(best_score) or best_score <= 0 or best_peak <= 0:
        return curve.size // 2, 0.0

    conf = best_score / (best_peak + 1e-9)
    return idx, float(min(1.0, max(0.0, conf)))


def detect_facing_pages(image: np.ndarray) -> bool:
    """
    Detect if image contains two facing pages (double-page spread).

    Uses multiple heuristics:
    1. Aspect ratio check (facing pages are typically wider)
    2. Vertical whitespace/gutter detection near center
    3. Symmetry analysis

    Args:
        image: Input image (BGR format)

    Returns:
        True if likely facing pages, False otherwise
    """
    h, w = image.shape[:2]

    # Heuristic 1: Aspect ratio
    # Facing pages are typically wider, but real scans can include large top/bottom margins
    # which reduce the ratio. Keep this as a weak gate, not a hard exclusion.
    aspect_ratio = w / h
    if aspect_ratio < 1.05:
        return False

    # Convert to grayscale and downscale for faster analysis (no quality impact on output).
    gray = _to_gray(image)
    gray_small, _ = _resize_for_analysis(gray, max_dim=1500)
    h_s, w_s = gray_small.shape[:2]

    # Pre-compute edges once; used by multiple heuristics.
    edges = cv2.Canny(gray_small, 50, 150)

    # Robust gutter detection over a broad range. This is especially important for off-center scans.
    start = int(w_s * 0.05)
    end = int(w_s * 0.95)
    if end > start + 10:
        region = gray_small[:, start:end]
        region_w = region.shape[1]

        inverted = 255 - region
        proj = np.sum(inverted.astype(np.float64), axis=0)
        proj_s = _smooth_1d(proj, kernel_size=max(9, region_w // 20))
        _, valley_conf = _best_saddle_valley(proj_s)

        edge_region = edges[:, start:end]
        edge_proj = np.sum((edge_region > 0).astype(np.uint8), axis=0).astype(np.float64)
        edge_s = _smooth_1d(edge_proj, kernel_size=max(9, region_w // 20))
        _, edge_conf = _best_saddle_valley(edge_s)

        try:
            sample = region[::4, :].astype(np.float32) if h_s > 4 else region.astype(np.float32)
            bg_curve = np.percentile(sample, 90, axis=0).astype(np.float64)
            bg_s = _smooth_1d(bg_curve, kernel_size=max(11, region_w // 15))
            mean_bg = float(np.mean(bg_s)) if bg_s.size > 0 else 0.0
            min_bg = float(np.min(bg_s)) if bg_s.size > 0 else mean_bg
            shadow_conf = float(min(1.0, max(0.0, ((mean_bg - min_bg) / mean_bg) * 2.0))) if mean_bg > 0 else 0.0
        except Exception:
            shadow_conf = 0.0

        # Decision rule:
        # - valley alone can be strong evidence (two dense regions with a clear gutter)
        # - otherwise require corroboration (edge valley) or a strong shadow dip
        if valley_conf >= 0.55:
            return True
        if shadow_conf >= 0.45:
            return True
        if valley_conf >= 0.35 and edge_conf >= 0.25:
            return True

    # Heuristic 2: Check for vertical whitespace in center region
    center_width = w_s // 5  # 20% of width around center
    center_x = w_s // 2
    center_strip = gray_small[:, center_x - center_width//2 : center_x + center_width//2]

    # Compute column-wise mean brightness
    col_means = np.mean(center_strip, axis=0)
    center_brightness = np.max(col_means)

    # Compare with edge regions
    left_strip = gray_small[:, :center_width]
    right_strip = gray_small[:, -center_width:]
    edge_brightness = (np.mean(left_strip) + np.mean(right_strip)) / 2

    # If center is significantly brighter (white gutter), likely facing pages
    brightness_diff = center_brightness - edge_brightness
    if brightness_diff > 20:  # Threshold for white gutter
        return True

    # Heuristic 3: Low edge density near the gutter (text gap)
    center_edges = edges[:, center_x - center_width//2 : center_x + center_width//2]
    left_edges = edges[:, :center_width]
    right_edges = edges[:, -center_width:]

    center_density = np.mean(center_edges > 0)
    edge_density = (np.mean(left_edges > 0) + np.mean(right_edges > 0)) / 2

    if edge_density > 0 and center_density < edge_density * 0.6:
        return True

    # Final fallback:
    # Some sources (e.g. 1-bit/mono scans) can defeat brightness/shadow heuristics.
    # Re-use our gutter splitter to propose a center line and verify it looks like
    # a true gutter via projection depth / edge-density dip.
    try:
        gutter_x = find_gutter_position(image)
        gx_s = int(round(gutter_x * (float(w_s) / float(w))))
        gx_s = max(0, min(w_s - 1, gx_s))

        # White-gutter signal: valley in inverted-ink projection.
        inverted = 255 - gray_small
        proj_full = np.sum(inverted.astype(np.float64), axis=0)
        proj_full = _smooth_1d(proj_full, kernel_size=max(9, w_s // 20))
        mean_ink = float(np.mean(proj_full)) if proj_full.size > 0 else 0.0
        at_ink = float(proj_full[gx_s]) if proj_full.size > 0 else mean_ink
        white_valley_depth = ((mean_ink - at_ink) / mean_ink) if mean_ink > 0 else 0.0

        # Dark-gutter signal: dip in brightness along top/bottom margin bands.
        band_h = max(1, int(round(h_s * 0.12)))
        top = gray_small[:band_h:4, :].astype(np.float32)
        bot = gray_small[max(0, h_s - band_h)::4, :].astype(np.float32)
        if top.size > 0 and bot.size > 0:
            sample = np.concatenate([top, bot], axis=0)
        elif top.size > 0:
            sample = top
        elif bot.size > 0:
            sample = bot
        else:
            sample = gray_small[::4, :].astype(np.float32) if h_s > 4 else gray_small.astype(np.float32)
        shadow_curve = np.mean(sample, axis=0).astype(np.float64)
        shadow_curve = _smooth_1d(shadow_curve, kernel_size=max(11, w_s // 20))
        mean_sh = float(np.mean(shadow_curve)) if shadow_curve.size > 0 else 0.0
        at_sh = float(shadow_curve[gx_s]) if shadow_curve.size > 0 else mean_sh
        dark_dip = ((mean_sh - at_sh) / mean_sh) if mean_sh > 0 else 0.0

        win = max(12, w_s // 60)
        a = max(0, gx_s - win)
        b = min(w_s, gx_s + win)
        center_ed = float(np.mean(edges[:, a:b] > 0)) if b > a else 1.0
        overall_ed = float(np.mean(edges > 0)) if edges.size > 0 else 0.0

        # Require a clear dip either in ink (projection) or edges, but only on wide pages.
        if white_valley_depth >= 0.12 and overall_ed > 0 and center_ed < overall_ed * 0.80:
            return True
        if white_valley_depth >= 0.20:
            return True
        gx_norm = float(gutter_x) / float(max(1, w))
        if 0.15 <= gx_norm <= 0.85 and dark_dip >= 0.06:
            return True
    except Exception:
        pass

    return False


def detect_skew_angle(image: np.ndarray) -> float:
    """
    Detect skew (rotation) angle of the page.

    Uses the deskew library's Hough-based detection.

    Args:
        image: Input image (BGR or grayscale)

    Returns:
        Skew angle in degrees (-45 to 45)
    """
    # Convert to grayscale and downscale for faster detection.
    gray = _to_gray(image)
    gray_small, _ = _resize_for_analysis(gray, max_dim=1500)

    # Quickly bail out for very low-contrast/mostly-blank pages.
    try:
        if float(np.std(gray_small)) < 5.0:
            return 0.0
    except Exception:
        pass

    try:
        angle, conf = _detect_skew_hough(gray_small, max_angle=15.0)

        # Guardrail: avoid "random rotations" on pages where skew detection is uncertain.
        # Typical scanner skew is small; larger angles are often false positives.
        if conf < 0.40:
            return 0.0
        if abs(angle) > 5.0 and conf < 0.70:
            return 0.0
        if abs(angle) > 10.0:
            return 0.0

        return float(angle)
    except Exception:
        return 0.0


def detect_curvature(image: np.ndarray) -> float:
    """
    Detect page curvature (warping from book spine).

    Analyzes text line curvature to estimate overall page distortion.

    Args:
        image: Input image (BGR format)

    Returns:
        Curvature score (0.0 = flat, 1.0+ = significant curve)
    """
    # Convert to grayscale and downscale for faster analysis.
    gray = _to_gray(image)
    gray, _ = _resize_for_analysis(gray, max_dim=1500)

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
        return 0.0  # Not enough lines to detect curvature

    # Analyze curvature of each text line
    curvatures = []
    for contour in text_lines:
        # Fit a polynomial to the contour points
        points = contour.reshape(-1, 2)
        if len(points) < 10:
            continue

        # Sort by x coordinate
        points = points[points[:, 0].argsort()]
        x_coords = points[:, 0]
        y_coords = points[:, 1]

        try:
            # Fit quadratic polynomial
            coeffs = np.polyfit(x_coords, y_coords, 2)
            # Curvature is related to the quadratic coefficient
            curvature = abs(coeffs[0]) * w  # Normalize by width
            curvatures.append(curvature)
        except np.RankWarning:
            continue

    if not curvatures:
        return 0.0

    # Return average curvature
    return float(np.mean(curvatures))


def detect_content_bounds(
    image: np.ndarray,
) -> Optional[dict]:
    """
    Detect content bounds for margin cropping.

    Args:
        image: Input image (BGR format)

    Returns:
        Dictionary with x, y, width, height of content region,
        or None if detection fails
    """
    gray = _to_gray(image)
    h, w = gray.shape

    # Downscale for analysis to avoid expensive full-res scans.
    gray_small, scale = _resize_for_analysis(gray, max_dim=1500)

    # Threshold to find content
    _, binary = cv2.threshold(gray_small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Ignore a thin border so scanner edges/borders don't dominate the bounds.
    border = int(round(min(binary.shape[:2]) * 0.01))
    if border > 0:
        binary[:border, :] = 0
        binary[-border:, :] = 0
        binary[:, :border] = 0
        binary[:, -border:] = 0

    # Fast bbox via projections (no huge coordinate list like cv2.findNonZero).
    row_max = cv2.reduce(binary, 1, cv2.REDUCE_MAX).reshape(-1)
    col_max = cv2.reduce(binary, 0, cv2.REDUCE_MAX).reshape(-1)

    ys = np.flatnonzero(row_max)
    xs = np.flatnonzero(col_max)
    if ys.size == 0 or xs.size == 0:
        return None

    x1_s = int(xs[0])
    x2_s = int(xs[-1])
    y1_s = int(ys[0])
    y2_s = int(ys[-1])

    bw_s = x2_s - x1_s + 1
    bh_s = y2_s - y1_s + 1

    # Sanity check - content should be reasonable size
    if bw_s < binary.shape[1] * 0.1 or bh_s < binary.shape[0] * 0.1:
        return None

    inv = 1.0 / float(scale)
    x = int(round(x1_s * inv))
    y = int(round(y1_s * inv))
    bw = int(round(bw_s * inv))
    bh = int(round(bh_s * inv))

    # Clamp to original image bounds
    x = max(0, min(x, w - 1))
    y = max(0, min(y, h - 1))
    bw = max(1, min(bw, w - x))
    bh = max(1, min(bh, h - y))

    return {
        "x": x,
        "y": y,
        "width": bw,
        "height": bh,
    }


def detect_page_characteristics(input_path: str) -> dict:
    """
    Full detection without processing - for UI preview.

    Args:
        input_path: Path to input image

    Returns:
        Dictionary with all detection results
    """
    image = cv2.imread(input_path)
    if image is None:
        raise ValueError(f"Failed to load image: {input_path}")

    h, w = image.shape[:2]

    return {
        "size": {"width": w, "height": h},
        "facing_pages": detect_facing_pages(image),
        "skew_angle": detect_skew_angle(image),
        "curvature_score": detect_curvature(image),
        "content_bounds": detect_content_bounds(image),
    }
