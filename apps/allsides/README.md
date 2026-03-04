# AllSides

Multi-agent tmux chat app powered by [cligent](https://github.com/sublang-dev/cligent).

Broadcast a single prompt to multiple AI coding agents in parallel. Each agent's streaming response appears in its own tmux pane.

```
┌───────────┬───────────┬───────────┐
│  claude   │   codex   │  gemini   │
│           │           │           │
│  (agent   │  (agent   │  (agent   │
│   output) │   output) │   output) │
│           │           │           │
├───────────┴───────────┴───────────┤
│ boss$  _                          │
└───────────────────────────────────┘
```

## Prerequisites

- [tmux](https://github.com/tmux/tmux)
- Node.js >= 18
- At least one supported agent:

| Agent | Requires |
| --- | --- |
| `claude` | [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| `codex` | [@openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk) |
| `gemini` | [gemini CLI](https://github.com/google-gemini/gemini-cli) |
| `opencode` | [@opencode-ai/sdk](https://www.npmjs.com/package/@opencode-ai/sdk) |

## Usage

```bash
# Auto-detect all available agents
npx @sublang/allsides

# Pick specific agents
npx @sublang/allsides --agent claude --agent gemini

# Override models
npx @sublang/allsides --agent claude=claude-sonnet-4-6 --agent gemini=gemini-2.5-pro

# Set working directory for agent tasks
npx @sublang/allsides --agent claude --cwd /path/to/project
```

Type at the `boss$` prompt. Your input is sent to all agents simultaneously and streaming responses appear in real time. Press Ctrl+C to exit.

## Contributing

AllSides is part of the [cligent](https://github.com/sublang-dev/cligent) project. We welcome contributions of all kinds. If you'd like to help:

- [Open an issue](https://github.com/sublang-dev/cligent/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-dev/cligent/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/cxUsykWr) for support or new ideas.
- Star the repo if you find it useful — it helps others discover the project.

## License

[Apache-2.0](LICENSE)
