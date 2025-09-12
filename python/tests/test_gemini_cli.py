"""Unit tests for Gemini CLI code agent implementation."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime

from agents.gemini.gemini_cli import (
    GeminiRecord, 
    GeminiLogFile, 
    GeminiStore, 
    GeminiCligent
)
from core.models import Role, Chat


class TestGeminiRecord:
    """Test GeminiRecord class functionality."""

    def test_load_basic_record(self):
        """Test loading a basic Gemini record."""
        json_data = {
            "type": "user",
            "role": "user",
            "content": "Hello, Gemini!",
            "timestamp": "2024-01-01T10:00:00Z",
            "session_id": "test-session-123"
        }
        json_string = json.dumps(json_data)
        
        record = GeminiRecord.load(json_string)
        
        assert record.role == "user"  # type becomes role
        assert record.content == "Hello, Gemini!"
        assert record.timestamp == "2024-01-01T10:00:00Z"
        assert record.session_id == "test-session-123"
        assert record.raw_data == json_data

    def test_load_with_alternative_fields(self):
        """Test loading record with alternative field names."""
        json_data = {
            "type": "assistant",
            "sender": "model",
            "text": "Hello, human!",
            "time": "1704103200",
            "conversation_id": "conv-456"
        }
        json_string = json.dumps(json_data)
        
        record = GeminiRecord.load(json_string)
        
        assert record.role == "assistant"  # type becomes role
        assert record.content == "Hello, human!"
        assert record.timestamp == "1704103200"
        assert record.session_id == "conv-456"

    def test_load_with_message_field(self):
        """Test loading record with 'message' field for content."""
        json_data = {
            "type": "system",
            "role": "system",
            "message": "System initialized",
            "created_at": "2024-01-01T12:00:00+00:00"
        }
        json_string = json.dumps(json_data)
        
        record = GeminiRecord.load(json_string)
        
        assert record.content == "System initialized"
        assert record.timestamp == "2024-01-01T12:00:00+00:00"

    def test_load_invalid_json(self):
        """Test loading invalid JSON raises ValueError."""
        with pytest.raises(ValueError, match="Invalid JSON record"):
            GeminiRecord.load("invalid json")

    def test_extract_message_user_role(self):
        """Test extracting message from user record."""
        record = GeminiRecord(
            role="user",
            content="Test message",
            timestamp="2024-01-01T10:00:00Z"
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.role == Role.USER
        assert message.content == "Test message"
        assert message.timestamp == datetime.fromisoformat("2024-01-01T10:00:00+00:00")

    def test_extract_message_model_role(self):
        """Test extracting message with 'model' role mapped to assistant."""
        record = GeminiRecord(
            role="model",
            content="Assistant response",
            timestamp="1704103200"  # Unix timestamp
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.role == Role.ASSISTANT
        assert message.content == "Assistant response"
        assert message.timestamp == datetime.fromtimestamp(1704103200)

    def test_extract_message_list_content(self):
        """Test extracting message with list content."""
        record = GeminiRecord(
            role="assistant",
            content=[
                {"text": "First part"},
                "Second part",
                {"content": "Third part"}
            ]
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.content == "First part\nSecond part\nThird part"

    def test_extract_message_dict_content(self):
        """Test extracting message with dict content."""
        record = GeminiRecord(
            role="user",
            content={"text": "Message from dict"}
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.content == "Message from dict"

    def test_extract_message_empty_content(self):
        """Test extracting message with empty content returns None."""
        record = GeminiRecord(
            role="user",
            content=""
        )
        
        message = record.extract_message()
        assert message is None

    def test_extract_message_invalid_timestamp(self):
        """Test extracting message with invalid timestamp."""
        record = GeminiRecord(
            role="user",
            content="Test",
            timestamp="invalid-timestamp"
        )
        
        message = record.extract_message()
        
        assert message is not None
        assert message.timestamp is None

    def test_is_message_by_role(self):
        """Test is_message detection by record role."""
        message_roles = ['user', 'assistant', 'system', 'human', 'ai', 'model', 'message']
        
        for role in message_roles:
            record = GeminiRecord(role=role, content="test")
            assert record.is_message()
        
        record = GeminiRecord(role="tool_use", content="test")
        assert not record.is_message()

    def test_is_message_empty_content(self):
        """Test is_message detection requires non-empty content."""
        # Valid role but empty content should return False
        record = GeminiRecord(role="user", content="")
        assert not record.is_message()
        
        # Valid role with content should return True
        record = GeminiRecord(role="user", content="test")
        assert record.is_message()

    def test_role_mapping_variations(self):
        """Test various role mapping scenarios."""
        role_tests = [
            ("user", Role.USER),
            ("human", Role.USER),
            ("assistant", Role.ASSISTANT),
            ("model", Role.ASSISTANT),
            ("ai", Role.ASSISTANT),
            ("system", Role.SYSTEM),
            ("unknown", Role.ASSISTANT),  # Default fallback
        ]
        
        for gemini_role, expected_role in role_tests:
            record = GeminiRecord(role=gemini_role, content="test")
            message = record.extract_message()
            assert message.role == expected_role

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
        
        record = GeminiRecord.load(google_format_json)
        
        assert record.role == "user"
        assert record.content == "Hello, how are you?"
        # Google format records directly map role field
        
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
        
        record = GeminiRecord.load(google_format_json)
        message = record.extract_message()
        
        assert message.role == Role.ASSISTANT
        assert message.content == "I'm doing well, thank you!"

    def test_google_multiple_parts(self):
        """Test handling multiple parts in Google format."""
        google_format_json = """{
            "role": "user",
            "parts": [
                {
                    "text": "First part."
                },
                {
                    "text": "Second part."
                }
            ]
        }"""
        
        record = GeminiRecord.load(google_format_json)
        message = record.extract_message()
        
        assert message.content == "First part.\nSecond part."

    def test_google_parts_with_function_calls(self):
        """Test that function calls are filtered out from parts."""
        google_format_json = """{
            "role": "model",
            "parts": [
                {
                    "text": "Let me help you with that."
                },
                {
                    "functionCall": {
                        "name": "search",
                        "args": {"query": "test"}
                    }
                },
                {
                    "text": "Here's the result."
                }
            ]
        }"""
        
        record = GeminiRecord.load(google_format_json)
        message = record.extract_message()
        
        # Should only extract text parts, skip function calls
        assert message.content == "Let me help you with that.\nHere's the result."


class TestGeminiLogFile:
    """Test GeminiLogFile class functionality."""

    @pytest.fixture
    def temp_jsonl_file(self, tmp_path):
        """Create a temporary JSON file for testing."""
        session_dir = tmp_path / "test_session"
        session_dir.mkdir()
        file_path = session_dir / "logs.json"
        
        records = [
            {"type": "user", "content": "Hello", "session_id": "test-123"},
            {"type": "model", "content": "Hi there!"},
            {"type": "user", "content": "How are you?"},
            {"type": "model", "content": "I'm doing well!"}
        ]
        
        # Write records as JSON array instead of JSONL
        with open(file_path, 'w') as f:
            json.dump(records, f, indent=2)
        
        return file_path

    @pytest.fixture
    def malformed_jsonl_file(self, tmp_path):
        """Create a JSON file with some malformed lines."""
        session_dir = tmp_path / "malformed_session"
        session_dir.mkdir()
        file_path = session_dir / "logs.json"
        
        # Write malformed JSON content
        with open(file_path, 'w') as f:
            f.write('invalid json content')
        
        return file_path

    def test_load_valid_file(self, temp_jsonl_file):
        """Test loading a valid JSONL file."""
        log_file = GeminiLogFile(file_path=temp_jsonl_file)
        session.load()
        
        assert len(session.records) == 4
        assert session.session_id == "test-123"
        assert session.records[0].content == "Hello"
        assert session.records[1].role == "model"

    def test_load_nonexistent_file(self):
        """Test loading a non-existent file raises FileNotFoundError."""
        log_file = GeminiLogFile(file_path=Path("/nonexistent/session/logs.json"))
        
        with pytest.raises(FileNotFoundError, match="Log file not found"):
            session.load()

    def test_load_malformed_file(self, malformed_jsonl_file, capsys):
        """Test loading file with malformed JSON content."""
        log_file = GeminiLogFile(file_path=malformed_jsonl_file)
        session.load()
        
        # Should have 0 records due to malformed JSON
        assert len(session.records) == 0

    def test_to_chat(self, temp_jsonl_file):
        """Test converting session to Chat object."""
        log_file = GeminiLogFile(file_path=temp_jsonl_file)
        session.load()
        
        chat = session.to_chat()
        
        assert isinstance(chat, Chat)
        assert len(chat.messages) == 4
        assert chat.messages[0].role == Role.USER
        assert chat.messages[1].role == Role.ASSISTANT
        assert chat.messages[0].content == "Hello"

    def test_empty_file(self, tmp_path):
        """Test loading empty file."""
        session_dir = tmp_path / "empty_session"
        session_dir.mkdir()
        empty_file = session_dir / "logs.json"
        empty_file.touch()
        
        log_file = GeminiLogFile(file_path=empty_file)
        session.load()
        
        assert len(session.records) == 0
        chat = session.to_chat()
        assert len(chat.messages) == 0


class TestGeminiStore:
    """Test GeminiStore class functionality."""

    @pytest.fixture
    def mock_home_dir(self, tmp_path):
        """Create mock home directory structure."""
        home_dir = tmp_path / "home"
        gemini_dir = home_dir / ".gemini" / "tmp"
        gemini_dir.mkdir(parents=True)
        
        # Create some test session directories with logs.json files
        session1_dir = gemini_dir / "session1"
        session1_dir.mkdir()
        (session1_dir / "logs.json").write_text('{"content": "test1"}')
        
        session2_dir = gemini_dir / "session2"
        session2_dir.mkdir()
        (session2_dir / "logs.json").write_text('{"content": "test2"}')
        
        return home_dir

    def test_init_with_default_location(self):
        """Test initializing store with default location."""
        store = GeminiStore()
        assert store.agent == "gemini-cli"

    def test_init_without_location(self):
        """Test initializing store (location not supported for Gemini)."""
        store = GeminiStore()
        assert store.agent == "gemini-cli"

    def test_list_logs(self, mock_home_dir):
        """Test listing available logs."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = GeminiStore()
            logs = store.list()
        
        assert len(logs) == 2
        log_uris = [log[0] for log in logs]
        assert "session1/logs.json" in log_uris
        assert "session2/logs.json" in log_uris
        
        # Check metadata structure
        metadata = logs[0][1]
        assert "size" in metadata
        assert "modified" in metadata
        assert "accessible" in metadata
        assert "file_name" in metadata
        assert "session_id" in metadata

    def test_list_logs_no_directory(self, tmp_path):
        """Test listing logs when directory doesn't exist."""
        fake_home = tmp_path / "fake_home"
        with patch('pathlib.Path.home', return_value=fake_home):
            store = GeminiStore()
            logs = store.list()
        
        assert logs == []

    def test_get_log_by_session_id(self, mock_home_dir):
        """Test retrieving log content by session ID."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = GeminiStore()
            content = store.get("session1")
        
        assert content == '{"content": "test1"}'

    def test_get_log_by_full_path(self, mock_home_dir):
        """Test retrieving log content by full path."""
        log_path = mock_home_dir / ".gemini" / "tmp" / "session1" / "logs.json"
        
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = GeminiStore()
            content = store.get(str(log_path))
        
        assert content == '{"content": "test1"}'

    def test_get_nonexistent_log(self, mock_home_dir):
        """Test retrieving non-existent log raises FileNotFoundError."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = GeminiStore()
            
            with pytest.raises(FileNotFoundError, match="Session log file not found"):
                store.get("nonexistent")

    def test_live_log(self, mock_home_dir):
        """Test getting most recent log."""
        with patch('pathlib.Path.home', return_value=mock_home_dir):
            store = GeminiStore()
            live_log = store.live()
        
        # Should return one of the sessions with new URI format
        assert live_log in ["session1/logs.json", "session2/logs.json"]

    def test_live_log_no_logs(self, tmp_path):
        """Test getting live log when no logs exist."""
        fake_home = tmp_path / "fake_home"
        with patch('pathlib.Path.home', return_value=fake_home):
            store = GeminiStore()
            live_log = store.live()
        
        assert live_log is None

    def test_fallback_directories(self, tmp_path):
        """Test fallback to different log directories."""
        home_dir = tmp_path / "home"
        
        # Test fallback to logs directory when tmp doesn't exist
        logs_dir = home_dir / ".gemini" / "logs"
        logs_dir.mkdir(parents=True)
        test_session_dir = logs_dir / "test_session"
        test_session_dir.mkdir()
        (test_session_dir / "logs.json").write_text('{"test": "data"}')
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = GeminiStore()
            assert store._logs_dir == logs_dir
            logs = store.list()
            assert len(logs) == 1

    def test_directory_selection_logic(self, tmp_path):
        """Test directory selection follows expected priority."""
        home_dir = tmp_path / "home"
        gemini_base = home_dir / ".gemini"
        
        # Test that when logs directory exists, it's selected over sessions
        logs_dir = gemini_base / "logs"
        logs_dir.mkdir(parents=True)
        test_session_dir = logs_dir / "test_session"
        test_session_dir.mkdir()
        (test_session_dir / "logs.json").write_text('{"test": "data"}')
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = GeminiStore()
            assert store._logs_dir == logs_dir
            logs = store.list()
            assert len(logs) == 1

    def test_checkpoint_files_handling(self, tmp_path):
        """Test that checkpoint files are listed and accessible."""
        home_dir = tmp_path / "home"
        gemini_dir = home_dir / ".gemini" / "tmp"
        gemini_dir.mkdir(parents=True)
        
        # Create session with multiple files
        session_dir = gemini_dir / "session-123"
        session_dir.mkdir()
        
        # Main logs.json
        (session_dir / "logs.json").write_text('[{"type": "user", "content": "Hello"}]')
        # Checkpoint files
        (session_dir / "checkpoint-python-basics.json").write_text('[{"type": "user", "content": "Python help"}]')
        (session_dir / "checkpoint-final.json").write_text('[{"type": "model", "content": "Summary"}]')
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = GeminiStore()
            logs = store.list()
        
        # Should find all JSON files
        assert len(logs) == 3
        
        # Check that URIs use <uuid>/<filename> format
        log_uris = [log[0] for log in logs]
        expected_uris = [
            "session-123/logs.json",
            "session-123/checkpoint-python-basics.json", 
            "session-123/checkpoint-final.json"
        ]
        
        for expected_uri in expected_uris:
            assert expected_uri in log_uris
        
        # Check metadata includes file information
        for uri, metadata in logs:
            assert "file_name" in metadata
            assert "session_id" in metadata
            assert metadata["session_id"] == "session-123"

    def test_get_checkpoint_file_by_uri(self, tmp_path):
        """Test retrieving checkpoint file using <uuid>/<filename> URI format."""
        home_dir = tmp_path / "home"
        gemini_dir = home_dir / ".gemini" / "tmp"
        gemini_dir.mkdir(parents=True)
        
        session_dir = gemini_dir / "session-456"
        session_dir.mkdir()
        
        checkpoint_content = '[{"type": "user", "content": "Checkpoint test"}]'
        (session_dir / "checkpoint-test.json").write_text(checkpoint_content)
        
        with patch('pathlib.Path.home', return_value=home_dir):
            store = GeminiStore()
            
            # Test new URI format
            content = store.get("session-456/checkpoint-test.json")
            assert content == checkpoint_content
            
            # Test that old format still works (backward compatibility)
            main_content = '[{"type": "user", "content": "Main conversation"}]'
            (session_dir / "logs.json").write_text(main_content)
            legacy_content = store.get("session-456")  # Should default to logs.json
            assert legacy_content == main_content

    def test_parse_checkpoint_content(self, tmp_path):
        """Test that checkpoint files can be parsed correctly."""
        home_dir = tmp_path / "home"
        gemini_dir = home_dir / ".gemini" / "tmp"
        gemini_dir.mkdir(parents=True)
        
        session_dir = gemini_dir / "session-789"
        session_dir.mkdir()
        
        checkpoint_data = [
            {"type": "user", "content": "Checkpoint message 1"},
            {"type": "model", "content": "Checkpoint response 1"}
        ]
        (session_dir / "checkpoint-conversation.json").write_text(json.dumps(checkpoint_data))
        
        with patch('pathlib.Path.home', return_value=home_dir):
            agent = GeminiCliAgent()
            
            # Parse using the new URI format
            chat = agent.parse("session-789/checkpoint-conversation.json")
            
            assert len(chat.messages) == 2
            assert chat.messages[0].content == "Checkpoint message 1"
            assert chat.messages[1].content == "Checkpoint response 1"


class TestGeminiCliAgent:
    """Test GeminiCliAgent class functionality."""

    def test_agent_properties(self):
        """Test agent properties."""
        agent = GeminiCliAgent()
        
        assert agent.name == "gemini-cli"
        assert agent.display_name == "Gemini CLI"
        
    def test_store_creation(self):
        """Test that agent has a store."""
        agent = GeminiCliAgent()
        
        assert agent.store is not None
        assert isinstance(agent.store, GeminiStore)
