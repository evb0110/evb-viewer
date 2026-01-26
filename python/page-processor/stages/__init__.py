"""
Stage-based processing modules for page processing pipeline.

Each stage has:
- detect_<stage>(image_path) -> StageResult: Run detection and return results
- apply_<stage>(image_path, output_path, params) -> dict: Apply transformation

Stages follow ScanTailor's proven workflow:
1. Rotation - Fix page orientation (0/90/180/270)
2. Split - Separate facing pages
3. Deskew - Correct skew angle
4. Dewarp - Fix perspective/curvature
"""

from .rotation import detect_rotation, apply_rotation, RotationResult
from .split import detect_split, apply_split, SplitResult
from .deskew import detect_deskew, apply_deskew, DeskewResult
from .dewarp import detect_dewarp, apply_dewarp, DewarpResult

__all__ = [
    # Rotation stage
    'detect_rotation',
    'apply_rotation',
    'RotationResult',
    # Split stage
    'detect_split',
    'apply_split',
    'SplitResult',
    # Deskew stage
    'detect_deskew',
    'apply_deskew',
    'DeskewResult',
    # Dewarp stage
    'detect_dewarp',
    'apply_dewarp',
    'DewarpResult',
]
