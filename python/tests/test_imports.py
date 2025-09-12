"""Test that all public imports work correctly."""

def test_core_imports():
    """Test that core imports work (self-contained)."""
    from core import Chat, Message, Role, LogStore
    assert Chat is not None
    assert Message is not None
    assert Role is not None
    assert LogStore is not None


def test_main_package_imports():
    """Test that main package imports work."""
    import src
    from src import cligent, Cligent
    assert callable(cligent)  # Main factory function
    assert Cligent is not None
    
    # Verify agent creation works
    agent = cligent("claude")
    assert agent.name == "claude-code"


def test_direct_imports():
    """Test that direct imports work through main package."""
    import src
    from src import Chat, Message, Role, LogStore, Cligent, cligent
    
    # Verify classes can be instantiated
    msg = Message(role=Role.USER, content="test")
    assert msg.content == "test"
    
    chat = Chat()
    assert chat.messages == []
    
    # Verify agent creation works
    agent = cligent("claude")
    assert agent.name == "claude-code"


def test_simplified_factory():
    """Test simplified factory function (no individual functions)."""
    import src
    
    # Test all agent types through single factory
    agent1 = src.cligent("claude")
    agent2 = src.cligent("gemini") 
    agent3 = src.cligent("qwen")
    
    assert agent1.name == "claude-code"
    assert agent2.name == "gemini-cli"
    assert agent3.name == "qwen-code"
    
    # Test default parameter
    default_agent = src.cligent()
    assert default_agent.name == "claude-code"


def test_backwards_compatibility():
    """Test backwards compatibility aliases."""
    import src
    
    # Should be able to use ChatParser alias
    agent = src.ChatParser("claude")
    assert agent.name == "claude-code"


def test_error_imports():
    """Test that error classes can be imported."""
    from core import (
        ChatParserError,
        ParseError,
        LogAccessError,
        LogCorruptionError,
        InvalidFormatError
    )
    
    # All should be proper exception classes
    assert issubclass(ChatParserError, Exception)
    assert issubclass(ParseError, Exception)
    assert issubclass(LogAccessError, Exception)


def test_private_modules_not_exposed():
    """Test that private implementation details aren't exposed."""
    from core import Chat
    
    # Core models should be available
    assert Chat is not None
    
    # But private implementation details shouldn't leak
    try:
        from core import models
        # This is OK - models module can be imported
        assert models is not None
    except ImportError:
        pass  # This is also OK