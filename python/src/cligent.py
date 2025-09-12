from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List, Tuple, TYPE_CHECKING
from pathlib import Path
from .core.models import Chat, Message
from .core.errors import ErrorCollector

if TYPE_CHECKING:
    from .core.models import LogStore

class Cligent(ABC):
    """Abstract base class for all agent implementations."""

    def __init__(self):
        """Initialize agent backend."""
        self.error_collector = ErrorCollector()
        self.selected_messages: List[Message] = []
        self._chat_cache: Dict[str, Chat] = {}
        # Automatically create store during initialization
        self._store: 'LogStore' = self._create_store()

    @property
    @abstractmethod 
    def name(self) -> str:
        """Agent name identifier."""
        pass
        
    @property
    @abstractmethod
    def display_name(self) -> str:
        """Agent display name."""
        pass

    @abstractmethod
    def _create_store(self) -> 'LogStore':
        """Create appropriate log store for this agent."""
        pass

    @abstractmethod
    def parse_content(self, content: str, log_uri: str) -> 'Chat':
        """Parse raw log content into Chat object."""
        pass





    # Log Store Management
    @property
    def store(self) -> 'LogStore':
        """Get log store for this agent."""
        return self._store

    # Log Parsing Methods
    def list_logs(self) -> List[Tuple[str, Dict[str, Any]]]:
        """Show available logs for the agent.

        Returns:
            List of (log_uri, metadata) tuples
        """
        return self.store.list()

    def parse(self, log_uri: str = None) -> Chat:
        """Extract chat from specific or live session log.

        Args:
            log_uri: Log URI (None for live session log)

        Returns:
            Parsed Chat object
        """
        if log_uri:
            content = self.store.get(log_uri)
            return self.parse_content(content, log_uri)
        else:
            live_uri = self.store.live()
            if live_uri is None:
                return None
            content = self.store.get(live_uri)
            return self.parse_content(content, live_uri)

    def compose(self, *args) -> str:
        """Create Tigs text output from selected content.

        Args:
            *args: Messages or chats to compose (uses selected items if none provided)

        Returns:
            Tigs text output
        """
        # Determine what to compose
        if args:
            items = list(args)
            if all(isinstance(item, Message) for item in items):
                chat = Chat(messages=items)
            elif all(isinstance(item, Chat) for item in items):
                chat = self._merge_chats(items)
            else:
                raise ValueError("Mixed types in composition")
        else:
            # Use selected messages
            if not self.selected_messages:
                raise ValueError("No messages selected for composition")
            chat = Chat(messages=self.selected_messages)

        return chat.export()

    def select(self, log_uri: str, indices: List[int] = None) -> None:
        """Select messages for composition.

        Args:
            log_uri: Log URI
            indices: Message indices to select (None for all messages)
        """
        # Get or cache the chat
        if log_uri not in self._chat_cache:
            self._chat_cache[log_uri] = self.parse(log_uri)

        chat = self._chat_cache[log_uri]

        if indices is None:
            # Select all messages from the chat
            self.selected_messages.extend(chat.messages)
        else:
            # Select specific messages
            for i in indices:
                if 0 <= i < len(chat.messages):
                    self.selected_messages.append(chat.messages[i])

    def unselect(self, log_uri: str, indices: List[int] = None) -> None:
        """Remove messages from selection.

        Args:
            log_uri: Log URI
            indices: Message indices to unselect (None for all messages from this log)
        """
        # Get or cache the chat
        if log_uri not in self._chat_cache:
            self._chat_cache[log_uri] = self.parse(log_uri)

        chat = self._chat_cache[log_uri]

        if indices is None:
            # Remove all messages from this chat
            self.selected_messages = [msg for msg in self.selected_messages
                                    if msg not in chat.messages]
        else:
            # Remove specific messages
            messages_to_remove = []
            for i in indices:
                if 0 <= i < len(chat.messages):
                    messages_to_remove.append(chat.messages[i])

            self.selected_messages = [msg for msg in self.selected_messages
                                    if msg not in messages_to_remove]

    def clear_selection(self) -> None:
        """Clear current selection."""
        self.selected_messages.clear()
        self._chat_cache.clear()

    def _merge_chats(self, chats: List[Chat]) -> Chat:
        """Merge multiple chats into one.

        Args:
            chats: List of chats to merge

        Returns:
            Merged chat
        """
        if not chats:
            return Chat()

        if len(chats) == 1:
            return chats[0]

        # Use the merge method from the first chat
        result = chats[0]
        for chat in chats[1:]:
            result = result.merge(chat)

        return result

    def get_errors(self) -> Optional[str]:
        """Get error report if any errors occurred.

        Returns:
            Error report string or None
        """
        if self.error_collector.has_errors():
            return self.error_collector.generate_report()
        return None

    # Agent Information
    def get_agent_info(self) -> Dict[str, Any]:
        """Get information about current agent."""
        return {
            "name": self.name,
            "display_name": self.display_name,
        }


    def __repr__(self) -> str:
        """String representation of agent."""
        return f"{self.__class__.__name__}(name='{self.name}')"


# Factory function for creating agent instances
def cligent(agent_type: str = "claude"):
    """Create an agent for the specified type.
    
    Args:
        agent_type: Agent type ("claude", "gemini", "qwen")
        
    Returns:
        Appropriate agent instance
        
    Raises:
        ValueError: If agent_type is not supported
    """
    if agent_type in ["claude", "claude-code"]:
        from .cligents.claude.claude_code import ClaudeCligent
        return ClaudeCligent()
    elif agent_type in ["gemini", "gemini-cli"]:
        from .cligents.gemini.gemini_cli import GeminiCligent
        return GeminiCligent()
    elif agent_type in ["qwen", "qwen-code"]:
        from .cligents.qwen.qwen_code import QwenCligent
        return QwenCligent()
    else:
        supported_types = ["claude", "claude-code", "gemini", "gemini-cli", "qwen", "qwen-code"]
        raise ValueError(f"Unsupported agent type: {agent_type}. Supported: {supported_types}")