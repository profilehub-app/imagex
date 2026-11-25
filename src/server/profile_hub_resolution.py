"""Dynamic Original Photo Resolution Service.

Delegates resolution to the unified async `OriginalImageResolver` (`src/server/original_image_resolver.py`)
while preserving all public schemas and helpers (`PhotoResolveRequest`, `PhotoResolveResult`,
`_parse_binary_dimensions`, `resolve_photo_original`).
"""
from __future__ import annotations

import re

from .original_image_resolver import (
    PhotoResolveRequest,
    PhotoResolveResult,
    get_default_resolver,
    parse_binary_dimensions as _parse_binary_dimensions,
)

RE_EXCLUDED_ASSET = re.compile(
    r"(?:logo|icon|banner|avatar|advert|sprite|flag|flags|lang|button|badge|catimg|nav|blank|rating|pixel|arrow|spinner|widget|track|\.svg$|ENG\.PNG)",
    re.IGNORECASE,
)


async def resolve_photo_original(req: PhotoResolveRequest) -> PhotoResolveResult:
    """Dynamically resolves the true high-resolution original image URL for a given photo."""
    return await get_default_resolver().resolve_original(req)
