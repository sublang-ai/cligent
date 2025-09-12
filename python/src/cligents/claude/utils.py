"""Utility functions for Claude Code implementation."""

import json
from datetime import datetime
from typing import Any, Dict, Optional


def parse_timestamp(timestamp_str: str) -> Optional[datetime]:
    """Parse Claude Code timestamp formats to datetime.
    
    Args:
        timestamp_str: Timestamp string to parse
        
    Returns:
        Parsed datetime or None if parsing fails
    """
    # Common Claude Code timestamp formats
    formats = [
        "%Y-%m-%dT%H:%M:%S.%fZ",  # ISO 8601 with microseconds
        "%Y-%m-%dT%H:%M:%SZ",      # ISO 8601 without microseconds
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(timestamp_str, fmt)
        except ValueError:
            continue
    
    return None


def safe_json_loads(json_str: str) -> Optional[Dict[str, Any]]:
    """Safely parse JSON string from Claude Code logs.
    
    Args:
        json_str: JSON string to parse
        
    Returns:
        Parsed dictionary or None
    """
    try:
        return json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return None


