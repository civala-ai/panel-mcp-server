# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Panel MCP Server is an MCP (Model Context Protocol) server that provides LLM council workflow tools for multi-model queries, debates, and reviews. It enables AI clients to orchestrate multi-model workflows where the calling LLM can query multiple models, run debates, get critiques, and synthesize the results.

## Development Commands

All commands delegate to `ts-builds` for consistency:

```bash
pnpm validate        # Main command: format + lint + test + build (use before commits)

pnpm format          # Format code with Prettier
pnpm lint            # Fix ESLint issues
pnpm test            # Run tests once
pnpm build           # Production build (outputs to dist/)
pnpm dev             # Development build with watch mode
pnpm typecheck       # Check TypeScript types
```

### Running the Server

```bash
# stdio transport (for MCP clients)
node dist/index.js --stdio

# HTTP transport
node dist/index.js --http 8080
```

## Architecture

### Source Structure

```
src/
├── index.ts              # CLI entry point + MCP server with all tools
├── constants.ts          # Configuration constants with env var support
├── types.ts              # TypeScript types using functype List
└── providers/
    ├── index.ts          # Provider registry, model resolution, query functions
    ├── config.ts         # Provider configuration from env vars
    └── rate-limiter.ts   # Semaphore-based rate limiting
```

### Key Dependencies

- **somamcp**: MCP server framework (tool registration, transports, built-in `info` tool and `/health` endpoint). Import from `somamcp/node`, the entry that can listen on a port or stdio. It runs on the official MCP SDK 2.x: stateless, and serves both `2026-07-28` and 2025-era clients
- **ai** (Vercel AI SDK): Unified interface for LLM providers
- **@ai-sdk/\***: Direct provider SDKs (OpenAI, Anthropic, Google, Mistral)
- **@openrouter/ai-sdk-provider**: OpenRouter for 300+ models
- **functype**: Functional programming patterns (Option, Either, List, Match, Try)
- **commander**: CLI argument parsing
- **zod**: Schema validation for tool parameters

### Provider System

Dual-mode provider support:

1. **OpenRouter mode**: `openrouter/{provider}/{model}` - routes through OpenRouter
2. **Direct mode**: `{provider}/{model}` - uses direct API if key configured, falls back to OpenRouter unless `PANEL_ROUTING=strict`

Model resolution logic in `src/providers/index.ts`:

- Parse model string to determine provider
- Try direct provider if API key configured
- Fall back to OpenRouter if available, unless `PANEL_ROUTING=strict` (`azure/` never falls back)
- A model with no known prefix goes to OpenRouter in auto mode; strict mode rejects it, so OpenRouter is reached only through an explicit `openrouter/` prefix
- `resolveModel` returns the `servedBy` provider, so responses report the route actually taken rather than inferring it

### Functype Patterns

The codebase uses functype for functional programming:

- **List<T>**: Immutable lists for responses, errors, models
- **Option<T>**: Safe nullable handling (env vars, optional params)
- **Either<E, A>**: Error handling in model resolution
- **Match**: Pattern matching for provider selection
- **Try**: Safe JSON parsing
- **tryCatchAsync**: Async error handling for API calls

## MCP Tools

| Tool            | Description                               |
| --------------- | ----------------------------------------- |
| `health_check`  | Check provider status                     |
| `list_models`   | List available models by provider         |
| `query_model`   | Query a single model                      |
| `council_query` | Query multiple models in parallel         |
| `debate`        | Run adversarial debate between two models |
| `critique`      | Get structured critique of a response     |

### Review rounds are stateless by design

`critique` and `challenge` take an optional `priorFindings` array. The tools hold
no session state: the models behind them have no memory, so a server-side
session would only replay accumulated context on every call while moving the
"what still matters" judgement away from the calling LLM, which holds the full
conversation. The caller hands back the previous round's findings instead.

Reviewers are then told to check whether each prior finding is resolved rather
than repeat it, so a second round reports what remains plus anything the
revision introduced. See `src/prior-findings.ts`.

## Environment Variables

```bash
# Required (at least one)
OPENROUTER_API_KEY=sk-or-...

# Optional direct providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_GENERATIVE_AI_API_KEY=...
MISTRAL_API_KEY=...

# Azure OpenAI / Microsoft Foundry (both required together).
# Model strings are deployment names: azure/gpt-6-astra -> deployment "gpt-6-astra"
AZURE_API_KEY=...
AZURE_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1/

# Configuration
PANEL_DEFAULT_MODELS=openai/gpt-5.6-sol,anthropic/claude-sonnet-5,google/gemini-3.1-pro-preview
PANEL_MAX_CONCURRENT=5
PANEL_REQUEST_TIMEOUT_MS=300000
PANEL_ROUTING=auto   # strict: no fallback, and OpenRouter only for openrouter/ models
```

## Testing

Tests are in `test/*.spec.ts`:

- `constants.spec.ts` - Configuration and env var handling
- `provider-config.spec.ts` - Provider configuration
- `rate-limiter.spec.ts` - Semaphore rate limiting
- `routing.spec.ts` - Direct vs OpenRouter routing, `PANEL_ROUTING`, and the latency split

Run specific test:

```bash
pnpm test -- --testNamePattern="pattern"
pnpm test -- test/specific.spec.ts
```

## Publishing

```bash
npm version patch|minor|major
npm publish --access public
```

The `prepublishOnly` hook automatically runs `pnpm validate` before publishing.
