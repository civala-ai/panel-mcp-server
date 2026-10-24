# Panel MCP Server

An MCP (Model Context Protocol) server that provides LLM council workflow tools for multi-model queries, debates, and reviews.

## Overview

Panel MCP Server enables AI clients (like Claude) to orchestrate multi-model workflows. The calling LLM uses these tools to query multiple models in parallel, run structured debates, get critiques, and then synthesize the results itself.

**Key insight**: The MCP server exposes tools that return structured multi-model responses. The calling LLM decides when/how to use these tools and can further process, compare, or synthesize the collected responses using its own reasoning.

## Features

- **council_query**: Query multiple LLMs in parallel, returning all responses for synthesis
- **debate**: Run structured adversarial debates between two models
- **critique**: Get one model to critique another's response
- **challenge**: Adversarial stress-testing of ideas with multiple models
- **query_model**: Query a single model directly
- **list_models**: Discover available models by provider
- **health_check**: Check provider status and connectivity

### Main LLM Participation

The calling LLM can optionally include its own position when using panel tools via the `proposedThought` parameter:

| Use Case             | Tool            | `proposedThought` Usage                         |
| -------------------- | --------------- | ----------------------------------------------- |
| Gather perspectives  | `council_query` | Optional: share your thought for comparison     |
| Understand tradeoffs | `debate`        | Optional: share thought and which side it leans |
| Get feedback         | `critique`      | Required: provide your response                 |
| Stress-test thinking | `challenge`     | Required: provide thought to stress-test        |

## Provider Support

### Dual-Mode Provider System

1. **OpenRouter mode** (recommended): Use `openrouter/` prefix for any of 300+ models
   - `openrouter/anthropic/claude-sonnet-5`
   - `openrouter/openai/gpt-5.6-sol`
   - `openrouter/meta-llama/llama-3.3-70b-instruct`

2. **Direct mode**: Use provider prefix for direct API calls (lower latency, no fee)
   - `openai/gpt-5.6-sol` - calls OpenAI API directly
   - `anthropic/claude-sonnet-5` - calls Anthropic API directly
   - `google/gemini-3.1-pro-preview` - calls Google API directly
   - `azure/gpt-6-astra` - calls your Azure OpenAI / Microsoft Foundry resource

A direct-mode model whose key is missing falls back to OpenRouter. Set `PANEL_ROUTING=strict` to make it fail instead, so prompts never pass through OpenRouter by accident. `azure/` never falls back.

Every response reports `servedBy`, the provider that actually answered. It also splits `latencyMs` into `queueMs` (waiting for a `PANEL_MAX_CONCURRENT` slot) and `modelMs` (the provider call, including retries). To compare routes, send the same model both ways in one `council_query`, for example `openrouter/anthropic/claude-sonnet-5` and `anthropic/claude-sonnet-5`.

**Default Panel**: GPT-5.6 Sol + Claude Sonnet 5 + Gemini 3.1 Pro (preview)

## Installation

```bash
npm install panel-mcp-server
# or
pnpm add panel-mcp-server
```

## Configuration

Set at least one API key:

```bash
# Required (at least one)
export OPENROUTER_API_KEY=sk-or-...

# Optional direct providers (lower latency)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_GENERATIVE_AI_API_KEY=...
export MISTRAL_API_KEY=...

# Optional configuration
export PANEL_DEFAULT_MODELS=openai/gpt-5.6-sol,anthropic/claude-sonnet-5,google/gemini-3.1-pro-preview
export PANEL_MAX_CONCURRENT=5
export PANEL_REQUEST_TIMEOUT_MS=300000
export PANEL_ROUTING=auto # or strict: no OpenRouter fallback for direct-mode models
```

## Usage

### As MCP Server (stdio)

```bash
panel-mcp-server --stdio
```

### As MCP Server (HTTP)

```bash
panel-mcp-server --http 8080
```

### Claude Desktop Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "panel": {
      "command": "npx",
      "args": ["panel-mcp-server", "--stdio"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here"
      }
    }
  }
}
```

## Tools

### council_query

Query multiple LLM models in parallel. Returns all responses for synthesis.

```typescript
{
  prompt: string,
  models?: string[],  // defaults to GPT-4o, Claude Sonnet 4, Gemini 2.5 Pro
  systemPrompt?: string,
  proposedThought?: string,  // share your thought with the council
  compareMode?: boolean      // ask models to explicitly compare to your thought
}
```

### debate

Run a structured adversarial debate between two models.

```typescript
{
  topic: string,
  affirmativeModel: string,
  negativeModel: string,
  rounds?: number,  // 1-5, default: 2
  proposedThought?: string,  // share your thought on the topic
  leaningSide?: "affirmative" | "negative" | "neutral"  // which side your thought leans
}
```

### critique

Have one model critique a response.

```typescript
{
  originalPrompt: string,
  response: string,
  criticModel: string,
  aspects?: string[]  // e.g., ["accuracy", "completeness"]
}
```

### challenge

Have multiple models find weaknesses in a proposed thought. Use for adversarial stress-testing.

```typescript
{
  proposedThought: string,  // the thought/claim to challenge
  context?: string,         // additional context
  challengers?: string[],   // defaults to GPT-4o, Claude Sonnet 4, Gemini 2.5 Pro
  challengeTypes?: ("logical" | "factual" | "completeness" | "edge_cases" | "alternatives")[]
}
```

Returns structured challenges with severity ratings and reasoning.

### query_model

Query a single model directly.

```typescript
{
  prompt: string,
  model: string,
  systemPrompt?: string
}
```

### list_models

List available models by provider.

```typescript
{
  provider?: "all" | "openrouter" | "openai" | "anthropic" | "google" | "mistral"
}
```

### health_check

Check provider status.

```typescript
{
}
```

## Development

```bash
# Install dependencies
pnpm install

# Validate (format + lint + test + build)
pnpm validate

# Development mode
pnpm dev

# Run tests
pnpm test
```

## Built With

- [SomaMCP](https://github.com/sapientsai/SomaMCP) - MCP server framework
- [Vercel AI SDK](https://sdk.vercel.ai/) - LLM provider integrations
- [functype](https://github.com/jordanburke/functype) - Functional programming patterns
- [ts-builds](https://github.com/jordanburke/ts-builds) - TypeScript build tooling

## License

MIT
