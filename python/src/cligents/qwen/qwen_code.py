"""Qwen Code specific implementation for parsing JSONL session logs."""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime

from ...core.models import Message, Chat, ErrorReport, Role
from ...core.models import LogStore
from ...cligent import Cligent


@dataclass
class QwenRecord:
    """A single JSON record from a Qwen log file."""

    role: str  # user, model, assistant, system, etc.
    timestamp: Optional[str] = None
    content: str = ""
    session_id: Optional[str] = None
    checkpoint_tag: Optional[str] = None
    model: Optional[str] = None
    raw_data: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, json_string: str) -> 'QwenRecord':
        """Parse a JSON string into a QwenRecord."""
        try:
            data = json.loads(json_string)
            
            # Handle Google conversation format (checkpoint files)
            if 'role' in data and 'parts' in data:
                # Google format: {"role": "user", "parts": [{"text": "..."}]}
                role = data.get('role', '')
                content = cls._extract_parts_content(data.get('parts', []))
                timestamp = ''  # No timestamp in Google format
                session_id = ''
                checkpoint_tag = ''
                model = ''
            else:
                # Legacy JSONL format - prioritize type/messageType fields for role
                role = data.get('type', data.get('messageType', data.get('role', data.get('sender', data.get('from', 'unknown')))))
                content = data.get('content', data.get('text', data.get('message', '')))
                timestamp = data.get('timestamp', data.get('time', data.get('created_at', '')))
                session_id = data.get('session_id', data.get('sessionId', data.get('conversationId', '')))
                checkpoint_tag = data.get('checkpoint_tag', data.get('checkpointTag', data.get('tag', '')))
                model = data.get('model', data.get('modelName', ''))
            
            return cls(
                role=role,
                content=content,
                timestamp=timestamp,
                session_id=session_id,
                checkpoint_tag=checkpoint_tag,
                model=model,
                raw_data=data
            )
        except (json.JSONDecodeError, KeyError) as e:
            raise ValueError(f"Invalid JSON record: {e}")

    @classmethod
    def _extract_parts_content(cls, parts: List[Dict[str, Any]]) -> str:
        """Extract text content from Google conversation parts array."""
        content_parts = []
        for part in parts:
            if isinstance(part, dict):
                # Extract text from parts
                if 'text' in part:
                    text = part['text'].strip()
                    if text:
                        content_parts.append(text)
                # Skip function calls and other non-text parts for now
        
        return ''.join(content_parts)  # Join without separator for Qwen (parts are often single chars)

    def extract_message(self) -> Optional[Message]:
        """Get a Message from this record, if applicable."""
        if not self.is_message():
            return None

        # Map Qwen Code roles to our Role enum
        role_mapping = {
            'user': Role.USER,
            'assistant': Role.ASSISTANT,
            'model': Role.ASSISTANT,  # Qwen often uses 'model' for assistant
            'qwen': Role.ASSISTANT,   # Qwen-specific role
            'system': Role.SYSTEM,
            'human': Role.USER,       # Alternative user role
            'ai': Role.ASSISTANT,     # Alternative assistant role
        }

        role = role_mapping.get(self.role.lower() if self.role else '', Role.ASSISTANT)

        # Handle different content formats
        content = self.content
        if isinstance(content, list):
            # Extract text from structured content
            content_parts = []
            for item in content:
                if isinstance(item, dict):
                    # Handle various content block types
                    text = item.get('text', item.get('content', ''))
                    if not text and 'tool_use' in item:
                        # Skip tool use blocks for text output
                        continue
                elif isinstance(item, str):
                    text = item
                else:
                    text = str(item)
                
                if text.strip():
                    content_parts.append(text.strip())
            
            content = '\n'.join(content_parts)
        elif isinstance(content, dict):
            # Extract text from dict format
            content = content.get('text', content.get('content', str(content)))
        
        content = str(content).strip()
        
        # Skip empty messages
        if not content:
            return None

        # Parse timestamp
        timestamp = None
        if self.timestamp:
            try:
                # Handle various timestamp formats
                if self.timestamp.endswith('Z'):
                    timestamp = datetime.fromisoformat(self.timestamp.replace('Z', '+00:00'))
                elif '+' in self.timestamp or '-' in self.timestamp[-6:]:
                    timestamp = datetime.fromisoformat(self.timestamp)
                else:
                    # Try parsing as Unix timestamp
                    try:
                        timestamp = datetime.fromtimestamp(float(self.timestamp))
                    except ValueError:
                        pass
            except (ValueError, AttributeError):
                pass

        metadata = {
            'role': self.role,
            'session_id': self.session_id,
            'checkpoint_tag': self.checkpoint_tag,
            'model': self.model,
            'raw_data': self.raw_data
        }

        return Message(
            role=role,
            content=content,
            timestamp=timestamp,
            metadata=metadata
        )

    def is_message(self) -> bool:
        """Check if this record represents a message."""
        message_roles = {
            'user', 'assistant', 'system', 'human', 'ai', 'model', 'qwen', 'message', 'unknown'
        }
        # Skip checkpoint and tool records
        skip_roles = {'checkpoint', 'tool_use', 'tool_result'}
        
        # Check if content has meaningful data
        has_content = False
        if isinstance(self.content, str):
            has_content = bool(self.content.strip())
        elif isinstance(self.content, (list, dict)):
            has_content = bool(self.content)  # Non-empty list or dict
        else:
            has_content = bool(str(self.content).strip())
        
        return (
            self.role and self.role.lower() in message_roles and
            self.role.lower() not in skip_roles and
            has_content
        )


@dataclass
class QwenLogFile:
    """A complete JSONL log file representing a Qwen Code chat."""

    file_path: Path
    session_id: Optional[str] = None
    checkpoint_tags: List[str] = field(default_factory=list)
    records: List[QwenRecord] = field(default_factory=list)

    def load(self) -> None:
        """Read and parse all Records from the file."""
        if not self.file_path.exists():
            raise FileNotFoundError(f"Log file not found: {self.file_path}")

        self.records.clear()
        self.checkpoint_tags.clear()
        
        try:
            with open(self.file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if not content:
                    return

                try:
                    # Try to parse as JSON array first (checkpoint files)
                    data = json.loads(content)
                    if isinstance(data, list):
                        # Handle JSON array format
                        for record_data in data:
                            try:
                                record = QwenRecord.load(json.dumps(record_data))
                                self.records.append(record)

                                # Extract session metadata
                                if not self.session_id and record.session_id:
                                    self.session_id = record.session_id
                                
                                # Collect checkpoint tags
                                if record.checkpoint_tag and record.checkpoint_tag not in self.checkpoint_tags:
                                    self.checkpoint_tags.append(record.checkpoint_tag)

                            except ValueError as e:
                                print(f"Warning: Skipped invalid record: {e}")
                                continue
                    else:
                        # Handle single JSON object
                        record = QwenRecord.load(content)
                        self.records.append(record)
                        if not self.session_id and record.session_id:
                            self.session_id = record.session_id
                        if record.checkpoint_tag and record.checkpoint_tag not in self.checkpoint_tags:
                            self.checkpoint_tags.append(record.checkpoint_tag)

                except json.JSONDecodeError:
                    # Fall back to JSONL format for backward compatibility
                    for line_num, line in enumerate(content.split('\n'), 1):
                        line = line.strip()
                        if not line:
                            continue

                        try:
                            record = QwenRecord.load(line)
                            self.records.append(record)

                            # Extract session metadata
                            if not self.session_id and record.session_id:
                                self.session_id = record.session_id
                            
                            # Collect checkpoint tags
                            if record.checkpoint_tag and record.checkpoint_tag not in self.checkpoint_tags:
                                self.checkpoint_tags.append(record.checkpoint_tag)

                        except ValueError as e:
                            # Log parsing error but continue
                            print(f"Warning: Skipped invalid record at line {line_num}: {e}")
                            continue

        except (IOError, OSError) as e:
            raise FileNotFoundError(f"Cannot read log file: {e}")

    def to_chat(self) -> Chat:
        """Convert session records to a Chat object."""
        messages = []

        for record in self.records:
            message = record.extract_message()
            if message:
                messages.append(message)

        return Chat(messages=messages)


class QwenStore(LogStore):
    """Qwen Code log store implementation."""

    def __init__(self):
        """Initialize with base path for Qwen Code logs.
        
        Note: Qwen Code stores logs globally in ~/.qwen/, not per-project.
        """
        # Qwen Code stores logs in ~/.qwen/ directory
        qwen_base = Path.home() / ".qwen"
        
        # Qwen uses the same structure as Gemini - session directories in tmp folder
        self._logs_dir = qwen_base / "tmp"
        
        # Fallback to other directories if tmp doesn't exist
        if not self._logs_dir.exists():
            possible_dirs = [
                qwen_base / "logs",
                qwen_base / "sessions", 
                qwen_base / "conversations",
                qwen_base,  # Root qwen directory
            ]
            
            for dir_path in possible_dirs:
                if dir_path.exists():
                    self._logs_dir = dir_path
                    break
            else:
                # Default to logs directory if none found
                self._logs_dir = qwen_base / "logs"

        # Use current directory for LogStore base class compatibility
        super().__init__("qwen-code", str(Path.cwd()))

    def list(self) -> List[Tuple[str, Dict[str, Any]]]:
        """Show available session logs, including checkpoint files."""
        logs = []

        try:
            if not self._logs_dir.exists():
                return logs

            # Scan for all JSON files in session directories (like Gemini)
            for session_dir in self._logs_dir.iterdir():
                if not session_dir.is_dir():
                    continue
                    
                session_id = session_dir.name
                
                # Find all JSON files in this session directory
                for json_file in session_dir.glob("*.json"):
                    if json_file.is_file():
                        stat = json_file.stat()
                        # Use <uuid>/<file_name> format as URI
                        log_uri = f"{session_id}/{json_file.name}"
                        metadata = {
                            "size": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            "accessible": json_file.is_file() and os.access(json_file, os.R_OK),
                            "file_name": json_file.name,
                            "session_id": session_id
                        }
                        logs.append((log_uri, metadata))

            # Also scan for legacy JSONL files in the logs directory for backward compatibility
            for log_file in self._logs_dir.glob("*.jsonl"):
                if log_file.is_file():
                    stat = log_file.stat()
                    session_id = log_file.stem
                    metadata = {
                        "size": stat.st_size,
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "accessible": log_file.is_file() and os.access(log_file, os.R_OK),
                        "file_name": log_file.name,
                        "session_id": session_id
                    }
                    logs.append((session_id, metadata))

        except (OSError, PermissionError):
            # Return empty list if we can't access the directory
            pass

        return logs

    def get(self, log_uri: str) -> str:
        """Retrieve raw content of a specific log.

        Args:
            log_uri: Either <uuid>/<file_name> format, session ID, or full path
        """
        # Handle new <uuid>/<file_name> format
        if "/" in log_uri and not log_uri.startswith("/"):
            # Format: <uuid>/<file_name>
            parts = log_uri.split("/", 1)
            if len(parts) == 2:
                session_id, file_name = parts
                log_path = self._logs_dir / session_id / file_name
            else:
                # Fallback to old format
                log_path = Path(log_uri)
        elif "\\" in log_uri or log_uri.startswith("/"):
            # Full path format
            log_path = Path(log_uri)
        else:
            # Legacy: just session ID, try JSON first, then JSONL
            json_path = self._logs_dir / log_uri / "logs.json"
            jsonl_path = self._logs_dir / f"{log_uri}.jsonl"
            
            if json_path.exists():
                log_path = json_path
            elif jsonl_path.exists():
                log_path = jsonl_path
            else:
                log_path = json_path  # Will fail with proper error message

        try:
            if not log_path.exists():
                raise FileNotFoundError(f"Session log file not found: {log_uri}")

            with open(log_path, 'r', encoding='utf-8') as f:
                return f.read()

        except (OSError, PermissionError, UnicodeDecodeError) as e:
            if isinstance(e, FileNotFoundError):
                raise
            raise IOError(f"Cannot read session log file {log_uri}: {e}")

    def live(self) -> Optional[str]:
        """Get URI of currently active log (most recent)."""
        logs = self.list()
        if not logs:
            return None

        # Sort by modification time (most recent first)
        sorted_logs = sorted(logs, key=lambda x: x[1].get('modified', ''), reverse=True)
        return sorted_logs[0][0] if sorted_logs else None


class QwenCligent(Cligent):
    """Qwen Code agent implementation."""

    def __init__(self):
        """Initialize Qwen Code agent."""
        super().__init__()

    @property
    def name(self) -> str:
        return "qwen-code"
        
    @property
    def display_name(self) -> str:
        return "Qwen Code"

    def _create_store(self) -> LogStore:
        return QwenStore()

    def parse_content(self, content: str, log_uri: str) -> Chat:
        # Handle new <uuid>/<file_name> format
        if "/" in log_uri and not log_uri.startswith("/"):
            # Format: <uuid>/<file_name>
            parts = log_uri.split("/", 1)
            if len(parts) == 2:
                session_id, file_name = parts
                file_path = self.store._logs_dir / session_id / file_name
            else:
                # Fallback to old format
                file_path = Path(log_uri)
        elif "\\" in log_uri or log_uri.startswith("/"):
            # Full path format
            file_path = Path(log_uri)
        else:
            # Legacy: just session ID, try JSON first, then JSONL
            json_path = self.store._logs_dir / log_uri / "logs.json"
            jsonl_path = self.store._logs_dir / f"{log_uri}.jsonl"
            
            if json_path.exists():
                file_path = json_path
            elif jsonl_path.exists():
                file_path = jsonl_path
            else:
                file_path = json_path  # Will fail with proper error message

        log_file = QwenLogFile(file_path=file_path)
        log_file.load()
        return log_file.to_chat()



