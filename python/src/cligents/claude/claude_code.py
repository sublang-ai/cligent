"""Claude Code specific implementation for parsing JSONL session logs."""

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
class Record:
    """A single JSON line in a JSONL log file."""

    type: str  # user, assistant, tool_use, tool_result, summary
    uuid: str
    parent_uuid: Optional[str] = None
    timestamp: Optional[str] = None
    raw_data: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, json_string: str) -> 'Record':
        """Parse a JSON string into a Record."""
        try:
            data = json.loads(json_string)
            return cls(
                type=data.get('type', 'unknown'),
                uuid=data.get('uuid', ''),
                parent_uuid=data.get('parent_uuid'),
                timestamp=data.get('timestamp'),
                raw_data=data
            )
        except (json.JSONDecodeError, KeyError) as e:
            raise ValueError(f"Invalid JSON record: {e}")

    def extract_message(self) -> Optional[Message]:
        """Get a Message from this record, if applicable."""
        # First check for special tool uses (ExitPlanMode, plan responses)
        # These take priority over regular message extraction
        if self.is_exit_plan_mode():
            return self._extract_plan_message()
            
        # Then check if it's a regular message
        if not self.is_message():
            return None

        # Map Claude types to our Role enum
        role_mapping = {
            'user': Role.USER,
            'assistant': Role.ASSISTANT,
            'system': Role.SYSTEM
        }

        role = role_mapping.get(self.type, Role.ASSISTANT)

        # Claude logs have message content nested under 'message' key
        message_data = self.raw_data.get('message', {})
        content = message_data.get('content', '')

        # Handle content that might be a list (Claude API format)
        if isinstance(content, list) and content:
            # Extract only text blocks - ignore everything else
            content_parts = []
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text':
                    text = block.get('text', '').strip()
                    if text:  # Only include non-empty text
                        content_parts.append(text)

            # If no text content found, skip this message
            if not content_parts:
                return None

            content = '\n'.join(content_parts)
        elif isinstance(content, str):
            content = content.strip()
            # If it's just whitespace or empty, skip
            if not content:
                return None
        else:
            # Skip non-string, non-list content
            return None

        # Parse timestamp if available
        timestamp = None
        if self.timestamp:
            try:
                timestamp = datetime.fromisoformat(self.timestamp.replace('Z', '+00:00'))
            except (ValueError, AttributeError):
                pass

        metadata = {
            'uuid': self.uuid,
            'parent_uuid': self.parent_uuid,
            'raw_type': self.type
        }

        return Message(
            role=role,
            content=content,
            timestamp=timestamp,
            metadata=metadata
        )

    def is_message(self) -> bool:
        """Check if this record represents a message."""
        return self.type in ('user', 'assistant', 'system')

    def is_exit_plan_mode(self) -> bool:
        """Check if this record is an ExitPlanMode tool use."""
        if self.type != 'assistant':
            return False
        
        message_data = self.raw_data.get('message', {})
        content = message_data.get('content', [])
        
        if not isinstance(content, list):
            return False
            
        # Look for ExitPlanMode tool use
        for block in content:
            if (isinstance(block, dict) and 
                block.get('type') == 'tool_use' and 
                block.get('name') == 'ExitPlanMode'):
                return True
        return False

    def _extract_plan_message(self) -> Optional[Message]:
        """Extract plan content from ExitPlanMode tool use."""
        message_data = self.raw_data.get('message', {})
        content = message_data.get('content', [])
        
        if not isinstance(content, list):
            return None
            
        # Find the ExitPlanMode tool use
        plan_content = None
        for block in content:
            if (isinstance(block, dict) and 
                block.get('type') == 'tool_use' and 
                block.get('name') == 'ExitPlanMode'):
                plan_input = block.get('input', {})
                plan_content = plan_input.get('plan', '')
                break
        
        if not plan_content:
            return None
            
        # Format the plan as a readable message
        formatted_content = f"📋 **Plan Proposal**\n\n{plan_content}\n\n---\n*This plan was presented for user approval in Claude Code's planning mode.*"
        
        # Parse timestamp if available
        timestamp = None
        if self.timestamp:
            try:
                timestamp = datetime.fromisoformat(self.timestamp.replace('Z', '+00:00'))
            except (ValueError, AttributeError):
                pass
        
        metadata = {
            'uuid': self.uuid,
            'parent_uuid': self.parent_uuid,
            'raw_type': self.type,
            'tool_type': 'ExitPlanMode',
            'is_plan': True
        }
        
        return Message(
            role=Role.ASSISTANT,
            content=formatted_content,
            timestamp=timestamp,
            metadata=metadata
        )



@dataclass
class LogFile:
    """A complete JSONL log file representing a chat."""

    file_path: Path
    session_id: Optional[str] = None
    records: List[Record] = field(default_factory=list)
    summary: Optional[str] = None

    def load(self) -> None:
        """Read and parse all Records from the file."""
        if not self.file_path.exists():
            raise FileNotFoundError(f"Log file not found: {self.file_path}")

        self.records.clear()
        try:
            with open(self.file_path, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        record = Record.load(line)
                        self.records.append(record)

                        # Extract session metadata
                        if not self.session_id and 'sessionId' in record.raw_data:
                            self.session_id = record.raw_data.get('sessionId')
                        elif record.type == 'summary':
                            self.summary = record.raw_data.get('summary', '')

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


class ClaudeStore(LogStore):
    """Claude Code log store implementation."""

    def __init__(self):
        """Initialize with base path for Claude session logs.

        Uses current working directory to find Claude session logs.
        """
        # Use current working directory
        working_dir = Path.cwd()

        # Convert working directory to Claude project folder name
        # Claude uses path with / replaced by -
        project_folder_name = str(working_dir.absolute()).replace("/", "-")

        # Find the Claude session logs directory for this project
        claude_base = Path.home() / ".claude" / "projects"
        self._project_dir = claude_base / project_folder_name

        super().__init__("claude-code", str(working_dir))
        self.project_folder_name = project_folder_name
        self.session_pattern = "*.jsonl"  # Pattern for session file names

    def list(self) -> List[Tuple[str, Dict[str, Any]]]:
        """Show available session logs for the current project."""
        logs = []

        try:
            if not self._project_dir.exists():
                return logs

            # Scan for JSONL files in this project's directory only
            for log_file in self._project_dir.glob(self.session_pattern):
                if log_file.is_file():
                    stat = log_file.stat()
                    # Use session ID (filename without path) as URI
                    session_id = log_file.stem  # filename without .jsonl extension
                    metadata = {
                        "size": stat.st_size,
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "project": self.project_folder_name,
                        "accessible": log_file.is_file() and os.access(log_file, os.R_OK)
                    }
                    # Return session ID as URI, not full path
                    logs.append((session_id, metadata))

        except (OSError, PermissionError):
            # Return empty list if we can't access the directory
            pass

        return logs

    def get(self, log_uri: str) -> str:
        """Retrieve raw content of a specific log.

        Args:
            log_uri: Either a session ID or full path to session log file
        """
        # Handle both session IDs and full paths for compatibility
        if "/" in log_uri or "\\" in log_uri:
            # Full path provided (backwards compatibility)
            log_path = Path(log_uri)
        else:
            # Session ID provided - construct full path
            log_path = self._project_dir / f"{log_uri}.jsonl"

        try:
            if not log_path.exists():
                raise FileNotFoundError(f"Session log file not found: {log_uri}")

            with open(log_path, 'r', encoding='utf-8') as f:
                return f.read()

        except (OSError, PermissionError, UnicodeDecodeError) as e:
            if isinstance(e, FileNotFoundError):
                raise  # Re-raise FileNotFoundError as-is
            raise IOError(f"Cannot read session log file {log_uri}: {e}")

    def live(self) -> Optional[str]:
        """Get URI of currently active log (most recent)."""
        # Find the most recently modified log file
        logs = self.list()
        if not logs:
            return None

        # Sort by modification time (most recent first)
        sorted_logs = sorted(logs, key=lambda x: x[1].get('modified', ''), reverse=True)
        # Return session ID of most recent log
        return sorted_logs[0][0] if sorted_logs else None

class ClaudeCligent(Cligent):
    """Claude Code agent implementation."""

    def __init__(self):
        """Initialize Claude Code agent."""
        super().__init__()

    @property
    def name(self) -> str:
        return "claude-code"
        
    @property
    def display_name(self) -> str:
        return "Claude Code"

    def _create_store(self) -> LogStore:
        return ClaudeStore()

    def parse_content(self, content: str, log_uri: str) -> Chat:
        # 使用现有的LogFile逻辑
        if "/" in log_uri or "\\" in log_uri:
            file_path = Path(log_uri)
        else:
            file_path = self.store._project_dir / f"{log_uri}.jsonl"

        log_file = LogFile(file_path=file_path)
        log_file.load()
        return log_file.to_chat()



