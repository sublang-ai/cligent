#!/usr/bin/env python3
"""Interactive CLI tool for cligent chat parser."""

import sys
from typing import Optional

# Add python/src to path so we can import from the flattened structure
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from src import cligent, Cligent


def get_agent() -> Cligent:
    """Get agent from user input."""
    print("Cligent Chat Parser - Interactive CLI")
    print("=" * 40)
    
    # Get agent type
    while True:
        agent_type = input("\nEnter agent type (claude/gemini/qwen): ").strip().lower()
        if agent_type in ['claude', 'gemini', 'qwen']:
            break
        print("Invalid agent type. Please enter: claude, gemini, or qwen")
    
    # Create agent
    try:
        agent = cligent(agent_type)
        print(f"\n✓ Created {agent.display_name} agent")
        if agent_type in ['claude', 'claude-code']:
            print("  Using current working directory for Claude session logs")
        else:
            print("  Using default session log location")
        return agent
    except Exception as e:
        print(f"✗ Error creating agent: {e}")
        sys.exit(1)


def show_menu():
    """Show available commands."""
    print("\nAvailable commands:")
    print("  1. info      - Show agent information")
    print("  2. list      - List available logs")
    print("  3. parse     - Parse a specific log")
    print("  4. live      - Parse live/most recent log")
    print("  5. select    - Select messages from a log")
    print("  6. compose   - Generate YAML from selected messages")
    print("  7. clear     - Clear selected messages")
    print("  8. menu      - Show this menu")
    print("  9. quit      - Exit")


def handle_info(agent: Cligent):
    """Handle info command."""
    info = agent.get_agent_info()
    print(f"\nAgent Information:")
    print(f"  Name: {info['name']}")
    print(f"  Display Name: {info['display_name']}")


def handle_list(agent: Cligent):
    """Handle list command."""
    print("\nListing logs...")
    try:
        logs = agent.list_logs()
        if logs:
            # Sort logs by modified time (newest first)
            sorted_logs = sorted(logs, key=lambda x: x[1].get('modified', ''), reverse=True)
            print(f"Found {len(sorted_logs)} logs (sorted by modified time):")
            for i, (uri, metadata) in enumerate(sorted_logs[:50], 1):  # Show first 50
                size = metadata.get('size', 0)
                modified = metadata.get('modified', 'unknown')
                print(f"  {i:2d}. {uri[:50]}{'...' if len(uri) > 50 else ''}")
                print(f"      Size: {size} bytes, Modified: {modified[:19]}")
            
            if len(sorted_logs) > 50:
                print(f"  ... and {len(sorted_logs) - 50} more")
        else:
            print("No logs found")
    except Exception as e:
        print(f"✗ Error listing logs: {e}")


def handle_parse(agent: Cligent):
    """Handle parse command."""
    log_uri = input("Enter log URI/ID to parse: ").strip()
    if not log_uri:
        print("No log URI provided")
        return
    
    try:
        print(f"\nParsing log: {log_uri}")
        chat = agent.parse(log_uri)
        if chat:
            print(f"✓ Parsed {len(chat.messages)} messages")
            print("\nMessages:")
            print("=" * 60)
            
            # Show all messages with full content
            for i, msg in enumerate(chat.messages, 0):
                timestamp_str = f" [{msg.timestamp}]" if msg.timestamp else ""
                print(f"\n{i}. {msg.role.value.upper()}{timestamp_str}:")
                print("-" * 40)
                print(msg.content)
                print("-" * 40)
        else:
            print("No chat data found")
    except Exception as e:
        print(f"✗ Error parsing log: {e}")


def handle_live(agent: Cligent):
    """Handle live command."""
    try:
        print("\nParsing live/most recent log...")
        chat = agent.parse()  # No URI = live log
        if chat:
            print(f"✓ Parsed {len(chat.messages)} messages from live log")
            
            # Show last few messages
            for i, msg in enumerate(chat.messages[-3:], len(chat.messages) - 2):
                content_preview = msg.content[:100] + "..." if len(msg.content) > 100 else msg.content
                print(f"  {i}. [{msg.role.value}] {content_preview}")
        else:
            print("No live log found")
    except Exception as e:
        print(f"✗ Error parsing live log: {e}")


def handle_select(agent: Cligent):
    """Handle select command."""
    log_uri = input("Enter log URI/ID to select from: ").strip()
    if not log_uri:
        print("No log URI provided")
        return
    
    indices_input = input("Enter message indices (comma-separated, or 'all' for all): ").strip()
    
    try:
        if indices_input.lower() == 'all':
            agent.select(log_uri)
            print(f"✓ Selected all messages from {log_uri}")
        else:
            indices = [int(x.strip()) for x in indices_input.split(',') if x.strip()]
            agent.select(log_uri, indices)
            print(f"✓ Selected {len(indices)} messages from {log_uri}")
        
        print(f"Total selected messages: {len(agent.selected_messages)}")
    except ValueError:
        print("✗ Invalid indices format. Use comma-separated numbers or 'all'")
    except Exception as e:
        print(f"✗ Error selecting messages: {e}")


def handle_compose(agent: Cligent):
    """Handle compose command."""
    try:
        if not agent.selected_messages:
            print("No messages selected. Use 'select' command first.")
            return
        
        print(f"\nGenerating YAML from {len(agent.selected_messages)} selected messages...")
        yaml_output = agent.compose()
        
        # Ask if user wants to save to file
        save = input("Save to file? (y/n): ").strip().lower()
        if save == 'y':
            filename = input("Enter filename (or press Enter for 'output.yaml'): ").strip()
            if not filename:
                filename = 'output.yaml'
            
            with open(filename, 'w') as f:
                f.write(yaml_output)
            print(f"✓ YAML saved to {filename}")
        else:
            # Show preview
            lines = yaml_output.split('\n')
            print(f"\nYAML preview ({len(lines)} lines):")
            for line in lines[:50]:
                print(f"  {line}")
            if len(lines) > 50:
                print(f"  ... and {len(lines) - 50} more lines")
    except Exception as e:
        print(f"✗ Error composing YAML: {e}")


def handle_clear(agent: Cligent):
    """Handle clear command."""
    count = len(agent.selected_messages)
    agent.clear_selection()
    print(f"✓ Cleared {count} selected messages")


def main():
    """Main CLI loop."""
    agent = get_agent()
    
    show_menu()
    
    while True:
        try:
            command = input(f"\n[{agent.name}]> ").strip().lower()
            
            if command in ['quit', 'exit', 'q']:
                print("Goodbye!")
                break
            elif command in ['info', '1']:
                handle_info(agent)
            elif command in ['list', '2']:
                handle_list(agent)
            elif command in ['parse', '3']:
                handle_parse(agent)
            elif command in ['live', '4']:
                handle_live(agent)
            elif command in ['select', '5']:
                handle_select(agent)
            elif command in ['compose', '6']:
                handle_compose(agent)
            elif command in ['clear', '7']:
                handle_clear(agent)
            elif command in ['menu', '8']:
                show_menu()
            elif command == '':
                continue
            else:
                print(f"Unknown command: {command}. Type 'menu' to see available commands.")
                
        except KeyboardInterrupt:
            print("\nGoodbye!")
            break
        except Exception as e:
            print(f"✗ Error: {e}")


if __name__ == "__main__":
    main()