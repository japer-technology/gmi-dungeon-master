# Dependencies

> No repo is an island.
> Every codebase depends on memory, intent, and shared understanding

## Direct Dependencies

### Runtime (npm)

| Package | Version | Description |
|---------|---------|-------------|
| [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono) | ^0.52.5 | Coding agent CLI with read, bash, edit, and write tools and session management. This is the core AI agent that powers the entire Minimum Intelligence system - it processes prompts, interacts with LLM providers, and manages conversation sessions. |

## Infrastructure Dependencies

These are not package dependencies but are required for the system to function:

| Dependency | Description |
|------------|-------------|
| [GitHub Actions](https://github.com/features/actions) | The sole compute runtime. Every issue event triggers a workflow that runs the AI agent. No external servers or containers are needed. |
| [GitHub Issues](https://docs.github.com/en/issues) | Used as the conversation interface. Each issue maps to a persistent AI conversation thread. |
| [Git](https://git-scm.com/) | All session state, conversation history, and agent edits are committed to the repository. Git serves as the memory and storage layer. |
| [Bun](https://bun.sh) | JavaScript/TypeScript runtime used to execute the agent orchestrator and install dependencies. |
| [gh CLI](https://cli.github.com/) | GitHub's official CLI tool, used by the agent lifecycle scripts to interact with the GitHub API (fetching issues, posting comments, managing reactions). |

## GitHub Actions Workflow Dependencies

These are referenced in `.github/workflows/github-minimum-intelligence-agent.yml`:

| Action | Description |
|--------|-------------|
| [actions/checkout@v4](https://github.com/actions/checkout) | Checks out the repository so the agent can read and write files. |
| [oven-sh/setup-bun@v2](https://github.com/oven-sh/setup-bun) | Installs the Bun runtime in the GitHub Actions environment. |
| [actions/create-github-app-token@v1](https://github.com/actions/create-github-app-token) | Generates a short-lived token from GitHub App credentials (used only when running as a GitHub App — see Method 3 in the README). |

## LLM Provider Dependencies (one required)

An API key from at least one supported LLM provider is needed:

| Provider | API Key Secret | Description |
|----------|---------------|-------------|
| [OpenAI](https://platform.openai.com/) | `OPENAI_API_KEY` | GPT models including GPT-5.3 Codex (default provider). |
| [Anthropic](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` | Claude models. |
| [Google Gemini](https://aistudio.google.com/) | `GEMINI_API_KEY` | Gemini 2.5 Pro and Flash models. |
| [xAI](https://console.x.ai/) | `XAI_API_KEY` | Grok 3 and Grok 3 Mini models. |
| [OpenRouter](https://openrouter.ai/) | `OPENROUTER_API_KEY` | Access to DeepSeek, and hundreds of other models via a unified API. |
| [Mistral](https://console.mistral.ai/) | `MISTRAL_API_KEY` | Mistral Large and other Mistral models. |
| [Groq](https://console.groq.com/) | `GROQ_API_KEY` | Fast inference for open-source models like DeepSeek R1 distills. |

## Transitive Dependencies (notable)

These are pulled in transitively by `@mariozechner/pi-coding-agent`:

| Package | Description |
|---------|-------------|
| `@anthropic-ai/sdk` | Official Anthropic API client for Claude models. |
| `@aws-sdk/client-bedrock-runtime` | AWS Bedrock client for accessing models via AWS infrastructure. |
| `openai` | Official OpenAI API client. |
| `@google/generative-ai` | Google's Generative AI SDK for Gemini models. |
| `fast-xml-parser` | Fast XML parser used by AWS SDK internals. |
| `tslib` | TypeScript runtime helpers used throughout the dependency tree. |

<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/japer-technology/github-minimum-intelligence/main/.github-minimum-intelligence/logo.png" alt="Minimum Intelligence" width="500">
  </picture>
</p>
