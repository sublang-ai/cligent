"""Unit tests for Qwen Code agent implementation."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime

from agents.qwen.qwen_code import (
    QwenRecord, 
    QwenLogFile, 
    QwenStore, 
    QwenCligent
)
from core.models import Role, Chat


class TestQwenRecord:
    """Test QwenRecord class functionality."""

    def test_load_basic_record(self):
        """Test loading a basic Qwen record."""
        json_data = {
            "type": "user",
            "content": "Hello, Qwen!",
            "timestamp": "2024-01-01T10:00:00Z",
            "session_id": "test-session-123",
            "model": "qwen-coder"
        }
        json_string = json.dumps(json_data)
        
        record = QwenRecord.load(json_string)
        
        assert record.role == "user"  # type becomes role
        assert record.content == "Hello, Qwen!"
        assert record.timestamp == "2024-01-01T10:00:00Z"
        assert record.session_id == "test-session-123"
        assert record.model == "qwen-coder"
        assert record.raw_data == json_data

    def test_load_with_alternative_fields(self):
        """Test loading record with alternative field names."""
        json_data = {
            "messageType": "assistant",
            "sender": "qwen",
            "text": "Hello, human!",
            "time": "1704103200",
            "conversationId": "conv-456",
            "modelName": "qwen-turbo"
        }
        json_string = json.dumps(json_data)
        
        record = QwenRecord.load(json_string)
        
        assert record.role == "assistant"  # messageType becomes role
        assert record.content == "Hello, human!"
        assert record.timestamp == "1704103200"
        assert record.session_id == "conv-456"
        assert record.model == "qwen-turbo"

    def test_load_with_checkpoint_fields(self):
        """Test loading record with checkpoint-specific fields."""
        json_data = {
            "type": "checkpoint",
            "checkpoint_tag": "checkpoint_001",
            "checkpointTag": "alternate_name",  # Should use checkpoint_tag over checkpointTag
            "timestamp": "2024-01-01T12:00:00+08:00",
            "session_id": "checkpoint-session"
        }
        json_string = json.dumps(json_data)
        
        record = QwenRecord.load(json_string)
        
        assert record.role == "checkpoint"
        assert record.checkpoint_tag == "checkpoint_001"  # Should prioritize checkpoint_tag
        assert record.timestamp == "2024-01-01T12:00:00+08:00"

    def test_load_invalid_json(self):
        """Test loading invalid JSON raises ValueError."""
        with pytest.raises(ValueError, match="Invalid JSON record"):
            QwenRecord.load("invalid json")

    def test_extract_message_user_role(self):
        """Test extracting message from user record."""
        record = QwenRecord(
            role="user",
            content="Test message",
            timestamp="2024-01-01T10:00:00Z",
            session_id="test-session"
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.role.value == "user"
        assert message.content == "Test message"

    def test_google_conversation_format(self):
        """Test parsing Google conversation format (checkpoint files)."""
        google_format_json = """{
            "role": "user",
            "parts": [
                {
                    "text": "Hello, how are you?"
                }
            ]
        }"""
        
        record = QwenRecord.load(google_format_json)
        
        assert record.role == "user"
        assert record.content == "Hello, how are you?"
        # Google format records don't have a separate type field
        
        message = record.extract_message()
        assert message is not None
        assert message.role == Role.USER
        assert message.content == "Hello, how are you?"

    def test_google_model_role(self):
        """Test Google 'model' role maps to assistant."""
        google_format_json = """{
            "role": "model",
            "parts": [
                {
                    "text": "I'm doing well, thank you!"
                }
            ]
        }"""
        
        record = QwenRecord.load(google_format_json)
        message = record.extract_message()
        
        assert message.role == Role.ASSISTANT
        assert message.content == "I'm doing well, thank you!"

    def test_google_multiple_parts_qwen_style(self):
        """Test handling multiple parts in Google format (Qwen style - no separator)."""
        google_format_json = """{
            "role": "model",
            "parts": [
                {
                    "text": "你"
                },
                {
                    "text": "好"
                },
                {
                    "text": "！"
                }
            ]
        }"""
        
        record = QwenRecord.load(google_format_json)
        message = record.extract_message()
        
        # Qwen joins parts without separator (characters come separately)
        assert message.content == "你好！"

    def test_google_parts_with_function_calls(self):
        """Test that function calls are filtered out from parts."""
        google_format_json = """{
            "role": "model",
            "parts": [
                {
                    "text": "Let me help"
                },
                {
                    "functionCall": {
                        "name": "search",
                        "args": {"query": "test"}
                    }
                },
                {
                    "text": " you with that."
                }
            ]
        }"""
        
        record = QwenRecord.load(google_format_json)
        message = record.extract_message()
        
        # Should only extract text parts, skip function calls
        assert message.content == "Let me helpyou with that."

    def test_extract_message_qwen_role(self):
        """Test extracting message with 'qwen' role mapped to assistant."""
        record = QwenRecord(
            role="qwen",
            content="Assistant response",
            timestamp="1704103200",  # Unix timestamp
            model="qwen-coder"
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.role.value == "assistant"
        assert message.content == "Assistant response"
        assert message.timestamp == datetime.fromtimestamp(1704103200)
        assert message.metadata["model"] == "qwen-coder"

    def test_extract_message_list_content(self):
        """Test extracting message with list content."""
        record = QwenRecord(
            role="assistant",
            content=[
                {"type": "text", "text": "First part"},
                {"text": "Second part"},
                "Third part string"
            ]
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.content == "First part\nSecond part\nThird part string"

    def test_extract_message_dict_content(self):
        """Test extracting message with dict content."""
        record = QwenRecord(
            role="user",
            content={"text": "Message from dict"}
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.content == "Message from dict"

    def test_extract_message_filters_tool_blocks(self):
        """Test extracting message filters out tool blocks."""
        record = QwenRecord(
            role="assistant",
            content=[
                {"type": "text", "text": "Here's some code:"},
                {"tool_use": "# This should be filtered"},  # This format triggers the filter
                {"text": "And here's the explanation."}
            ]
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert "Here's some code:" in message.content
        assert "And here's the explanation." in message.content
        assert "This should be filtered" not in message.content

    def test_extract_message_empty_content(self):
        """Test extracting message with empty content returns None."""
        record = QwenRecord(
            role="user",
            content=""
        )
        
        message = record.extract_message()
        assert message is None

    def test_extract_message_invalid_timestamp(self):
        """Test extracting message with invalid timestamp."""
        record = QwenRecord(
            role="user",
            content="Test",
            timestamp="invalid-timestamp"
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.timestamp is None

    def test_is_message_by_role(self):
        """Test is_message detection by record role."""
        message_roles = ['user', 'assistant', 'system', 'human', 'ai', 'qwen', 'message']
        
        for role in message_roles:
            record = QwenRecord(role=role, content="test")
            assert record.is_message()
        
        non_message_roles = ['tool_use', 'tool_result', 'checkpoint']
        for role in non_message_roles:
            record = QwenRecord(role=role, content="test")
            assert not record.is_message()

    def test_is_message_empty_content(self):
        """Test is_message detection requires non-empty content."""
        # Valid role but empty content should return False
        record = QwenRecord(role="user", content="")
        assert not record.is_message()
        
        # Valid role with content should return True
        record = QwenRecord(role="user", content="test")
        assert record.is_message()

    def test_role_mapping_variations(self):
        """Test various role mapping scenarios."""
        role_tests = [
            ("user", "user"),
            ("human", "user"),
            ("assistant", "assistant"),
            ("qwen", "assistant"),
            ("ai", "assistant"),
            ("model", "assistant"),
            ("system", "system"),
            ("unknown", "assistant"),  # Default fallback
        ]
        
        for qwen_role, expected_role in role_tests:
            record = QwenRecord(role=qwen_role, content="test")
            message = record.extract_message()
            assert message.role.value == expected_role


class TestQwenLogFile:
    """Test QwenLogFile class functionality."""

    @pytest.fixture
    def temp_jsonl_file(self, tmp_path):
        """Create a temporary JSONL file for testing."""
        file_path = tmp_path / "test_session.jsonl"
        
        records = [
            {"role": "user", "content": "Hello", "session_id": "test-123"},
            {"role": "checkpoint", "checkpoint_tag": "start", "session_id": "test-123"},
            {"role": "qwen", "content": "Hi there!", "session_id": "test-123"},
            {"role": "user", "content": "How are you?", "session_id": "test-123"},
            {"role": "qwen", "content": "I'm doing well!", "session_id": "test-123"}
        ]
        
        with open(file_path, 'w') as f:
            for record in records:
                f.write(json.dumps(record) + '\n')
        
        return file_path

    @pytest.fixture
    def malformed_jsonl_file(self, tmp_path):
        """Create a JSONL file with some malformed lines."""
        file_path = tmp_path / "malformed_session.jsonl"
        
        with open(file_path, 'w') as f:
            f.write('{"role": "user", "content": "Good line"}\n')
            f.write('invalid json line\n')
            f.write('{"role": "assistant", "content": "Another good line"}\n')
        
        return file_path

    def test_load_valid_file(self, temp_jsonl_file):
        """Test loading a valid JSONL file."""
        log_file = QwenLogFile(file_path=temp_jsonl_file)
        session.load()
        
        assert len(session.records) == 5
        assert session.session_id == "test-123"
        assert "start" in session.checkpoint_tags
        assert session.records[0].content == "Hello"
        assert session.records[2].role == "qwen"

    def test_load_nonexistent_file(self):
        """Test loading a non-existent file raises FileNotFoundError."""
        log_file = QwenLogFile(file_path=Path("/nonexistent/file.jsonl"))
        
        with pytest.raises(FileNotFoundError, match="Log file not found"):
            session.load()

    def test_load_malformed_file(self, malformed_jsonl_file, capsys):
        """Test loading file with malformed JSON lines."""
        log_file = QwenLogFile(file_path=malformed_jsonl_file)
        session.load()
        
        # Should have 2 valid records despite malformed line
        assert len(session.records) == 2
        
        # Check warning was printed
        captured = capsys.readouterr()
        assert "Warning: Skipped invalid record" in captured.out

    def test_to_chat(self, temp_jsonl_file):
        """Test converting session to Chat object."""
        log_file = QwenLogFile(file_path=temp_jsonl_file)
        session.load()
        
        chat = session.to_chat()
        
        assert chat is not None
        assert hasattr(chat, 'messages')
        assert len(chat.messages) == 4  # Excludes checkpoint records
        assert chat.messages[0].role.value == "user"
        assert chat.messages[1].role.value == "assistant"
        assert chat.messages[0].content == "Hello"

    def test_empty_file(self, tmp_path):
        """Test loading empty file."""
        empty_file = tmp_path / "empty.jsonl"
        empty_file.touch()
        
        log_file = QwenLogFile(file_path=empty_file)
        session.load()
        
        assert len(session.records) == 0
        assert len(session.checkpoint_tags) == 0
        chat = session.to_chat()
        assert len(chat.messages) == 0


class TestQwenStore:
    """Test QwenStore class functionality."""

    @pytest.fixture
    def mock_home_dir(self, tmp_path):
        """Create mock home directory structure."""
        home_dir = tmp_path / "home"
        qwen_dir = home_dir / ".qwen" / "logs"
        qwen_dir.mkdir(parents=True)
        
        # Create some test log files
        (qwen_dir / "session1.jsonl").write_text('{"content": "test1", "model": "qwen"}')
        (qwen_dir / "session2.jsonl").write_text('{"content": "test2", "model": "qwen"}')
        
        return home_dir

    def test_init_with_default_location(self):
        """Test initializing store with default location."""
        store = QwenStore()
        assert store.agent == "qwen-code"

    def test_init_without_location(self):
        """Test initializing store (location not supported for Qwen)."""
        store = QwenStore()
        assert store.agent == "qwen-code"

    def test_list_logs(self, mock_home_dir):
        """Test listing available logs."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = QwenStore()
            logs = store.list()
        
        assert len(logs) == 2
        session_ids = [log[0] for log in logs]
        assert "session1" in session_ids
        assert "session2" in session_ids
        
        # Check metadata structure
        metadata = logs[0][1]
        assert "size" in metadata
        assert "modified" in metadata
        assert "accessible" in metadata

    def test_list_logs_no_directory(self, tmp_path):
        """Test listing logs when directory doesn't exist."""
        fake_home = tmp_path / "fake_home"
        with patch('pathlib.Path.home', return_value=fake_home):
            store = QwenStore()
            logs = store.list()
        
        assert logs == []

    def test_get_log_by_session_id(self, mock_home_dir):
        """Test retrieving log content by session ID."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = QwenStore()
            content = store.get("session1")
        
        assert content == '{"content": "test1", "model": "qwen"}'

    def test_get_log_by_full_path(self, mock_home_dir):
        """Test retrieving log content by full path."""
        log_path = mock_home_dir / ".qwen" / "logs" / "session1.jsonl"
        
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = QwenStore()
            content = store.get(str(log_path))
        
        assert content == '{"content": "test1", "model": "qwen"}'

    def test_get_nonexistent_log(self, mock_home_dir):
        """Test retrieving non-existent log raises FileNotFoundError."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = QwenStore()
            
            with pytest.raises(FileNotFoundError, match="Session log file not found"):
                store.get("nonexistent")

    def test_live_log(self, mock_home_dir):
        """Test getting most recent log."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = QwenStore()
            live_log = store.live()
        
        # Should return one of the sessions (most recent)
        assert live_log in ["session1", "session2"]

    def test_live_log_no_logs(self, tmp_path):
        """Test getting live log when no logs exist."""
        fake_home = tmp_path / "fake_home"
        with patch('pathlib.Path.home', return_value=fake_home):
            store = QwenStore()
            live_log = store.live()
        
        assert live_log is None

    def test_directory_search_order(self, tmp_path):
        """Test directory search follows priority order."""
        home_dir = tmp_path / "home"
        qwen_base = home_dir / ".qwen"
        
        # Create multiple directories with different priorities
        sessions_dir = qwen_base / "sessions"
        sessions_dir.mkdir(parents=True)
        (sessions_dir / "session.jsonl").write_text('{"sessions": "data"}')
        
        conversations_dir = qwen_base / "conversations"  
        conversations_dir.mkdir(parents=True)
        (conversations_dir / "conv.jsonl").write_text('{"conversations": "data"}')
        
        # logs should have highest priority
        logs_dir = qwen_base / "logs"
        logs_dir.mkdir(parents=True)
        (logs_dir / "log.jsonl").write_text('{"logs": "data"}')
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = QwenStore()

    def test_checkpoint_files_handling(self, tmp_path):
        """Test that checkpoint files are listed and accessible."""
        home_dir = tmp_path / "home"
        qwen_dir = home_dir / ".qwen" / "tmp"
        qwen_dir.mkdir(parents=True)
        
        # Create session with multiple files
        session_dir = qwen_dir / "session-abc123"
        session_dir.mkdir()
        
        # Main logs.json
        (session_dir / "logs.json").write_text('[{"role": "user", "parts": [{"text": "Hello"}]}]')
        # Checkpoint files
        (session_dir / "checkpoint-test.json").write_text('[{"role": "user", "parts": [{"text": "Checkpoint test"}]}]')
        (session_dir / "checkpoint-final.json").write_text('[{"role": "model", "parts": [{"text": "Final thoughts"}]}]')
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = QwenStore()
            logs = store.list()
        
        # Should find all JSON files
        assert len(logs) == 3
        
        # Check that URIs use <uuid>/<filename> format
        log_uris = [log[0] for log in logs]
        expected_uris = [
            "session-abc123/logs.json",
            "session-abc123/checkpoint-test.json", 
            "session-abc123/checkpoint-final.json"
        ]
        
        for expected_uri in expected_uris:
            assert expected_uri in log_uris
        
        # Check metadata includes file information
        for uri, metadata in logs:
            assert "file_name" in metadata
            assert "session_id" in metadata
            assert metadata["session_id"] == "session-abc123"

    def test_get_checkpoint_file_by_uri(self, tmp_path):
        """Test retrieving checkpoint file using <uuid>/<filename> URI format."""
        home_dir = tmp_path / "home"
        qwen_dir = home_dir / ".qwen" / "tmp"
        qwen_dir.mkdir(parents=True)
        
        session_dir = qwen_dir / "session-def456"
        session_dir.mkdir()
        
        checkpoint_content = '[{"role": "user", "parts": [{"text": "Qwen checkpoint test"}]}]'
        (session_dir / "checkpoint-test.json").write_text(checkpoint_content)
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = QwenStore()
            
            # Test new URI format
            content = store.get("session-def456/checkpoint-test.json")
            assert content == checkpoint_content
            
            # Test that old format still works (backward compatibility)
            main_content = '[{"role": "user", "parts": [{"text": "Main conversation"}]}]'
            (session_dir / "logs.json").write_text(main_content)
            legacy_content = store.get("session-def456")  # Should default to logs.json
            assert legacy_content == main_content

    def test_parse_checkpoint_content(self, tmp_path):
        """Test that checkpoint files can be parsed correctly."""
        home_dir = tmp_path / "home"
        qwen_dir = home_dir / ".qwen" / "tmp"
        qwen_dir.mkdir(parents=True)
        
        session_dir = qwen_dir / "session-ghi789"
        session_dir.mkdir()
        
        checkpoint_data = [
            {"role": "user", "parts": [{"text": "Qwen checkpoint message 1"}]},
            {"role": "model", "parts": [{"text": "Qwen"}, {"text": " checkpoint"}, {"text": " response"}]}
        ]
        (session_dir / "checkpoint-conversation.json").write_text(json.dumps(checkpoint_data))
        
        with patch('pathlib.Path.home', return_value=home_dir):
            agent = QwenCodeAgent()
            
            # Parse using the new URI format
            chat = agent.parse("session-ghi789/checkpoint-conversation.json")
            
            assert len(chat.messages) == 2
            assert chat.messages[0].content == "Qwen checkpoint message 1"
            assert chat.messages[1].content == "Qwencheckpointresponse"  # Joined without separator


class TestQwenCodeAgent:
    """Test QwenCodeAgent class functionality."""

    def test_agent_properties(self):
        """Test agent properties."""
        agent = QwenCodeAgent()
        
        assert agent.name == "qwen-code"
        assert agent.display_name == "Qwen Code"
        
    def test_store_creation(self):
        """Test that agent has a store."""
        agent = QwenCodeAgent()
        
        assert agent.store is not None
        assert isinstance(agent.store, QwenStore)
