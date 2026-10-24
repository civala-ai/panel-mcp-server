/**
 * Panel MCP Server Configuration Constants
 *
 * All configuration is self-documenting with sensible defaults.
 * Override via environment variables as noted.
 */

import { List, Option } from "functype"

import packageJson from "../package.json" with { type: "json" }
import { FALLBACK_FREE_MODELS, getFreeModels } from "./providers/openrouter-models.js"

/**
 * Default panel of models for council queries.
 * Balanced selection of capability, cost, and provider diversity.
 *
 * Note: gemini-3.1-pro-preview is a preview model — Google has no GA 3.x Pro yet.
 *
 * Override: PANEL_DEFAULT_MODELS (comma-separated list)
 * Use "free" as a special value to dynamically fetch free OpenRouter models.
 */
export const DEFAULT_PANEL_MODELS = List.of(
  "openai/gpt-5.6-sol",
  "anthropic/claude-sonnet-5",
  "google/gemini-3.1-pro-preview",
)

/**
 * Maximum concurrent requests per provider.
 * Prevents rate limiting while allowing parallel execution.
 *
 * Override: PANEL_MAX_CONCURRENT
 */
export const DEFAULT_MAX_CONCURRENT = 5

/**
 * Request timeout in milliseconds.
 *
 * Sized for frontier reasoning models, which are far slower than chat models
 * and highly variable. Measured on gpt-6-astra for a five-token reply:
 * 3.9s / 4.8s / 10.7s / 13.1s / 26.7s / 62.6s / 122.8s — roughly 30x spread on
 * near-identical prompts. The previous 60s default cut off responses the model
 * was about to return, which surfaces as a timeout error rather than a slow
 * answer. 300s leaves ~2.5x headroom over the slowest observed run.
 *
 * Override: PANEL_REQUEST_TIMEOUT_MS
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/**
 * Maximum debate rounds allowed.
 * Prevents runaway costs while allowing substantive debates.
 */
export const MAX_DEBATE_ROUNDS = 5

/**
 * Default debate rounds if not specified.
 */
export const DEFAULT_DEBATE_ROUNDS = 2

/**
 * Server metadata
 */
export const SERVER_NAME = "panel-mcp-server"
export const SERVER_VERSION = packageJson.version as `${number}.${number}.${number}`

/**
 * Provider prefixes for model resolution
 */
export const PROVIDER_PREFIXES = {
  openrouter: "openrouter/",
  openai: "openai/",
  anthropic: "anthropic/",
  google: "google/",
  mistral: "mistral/",
  azure: "azure/",
} as const

/**
 * Environment variable names
 */
export const ENV_KEYS = {
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  GOOGLE_API_KEY: "GOOGLE_GENERATIVE_AI_API_KEY",
  MISTRAL_API_KEY: "MISTRAL_API_KEY",
  // Azure OpenAI / Microsoft Foundry. The v1 endpoint is OpenAI-compatible, so
  // it is reached with the standard OpenAI client pointed at the resource URL.
  // AZURE_BASE_URL must end in /openai/v1/ and model strings are *deployment
  // names*, not model ids (e.g. "azure/gpt-6-astra" -> deployment "gpt-6-astra").
  AZURE_API_KEY: "AZURE_API_KEY",
  AZURE_BASE_URL: "AZURE_BASE_URL",
  DEFAULT_MODELS: "PANEL_DEFAULT_MODELS",
  MAX_CONCURRENT: "PANEL_MAX_CONCURRENT",
  REQUEST_TIMEOUT: "PANEL_REQUEST_TIMEOUT_MS",
  ROUTING: "PANEL_ROUTING",
} as const

/**
 * Sentinel value indicating dynamic free models should be fetched
 */
export const FREE_MODELS_SENTINEL = "free" as const

/**
 * Check if environment is configured for free models
 */
export const isUsingFreeModels = (): boolean =>
  Option(process.env[ENV_KEYS.DEFAULT_MODELS])
    .map((v) => v.trim().toLowerCase() === FREE_MODELS_SENTINEL)
    .orElse(false)

/**
 * Get configured default models from environment or use defaults.
 * Special value "free" dynamically fetches free models from OpenRouter.
 *
 * Note: This is the synchronous version that returns fallback free models
 * when "free" is configured. Use getDefaultModelsAsync for dynamic fetching.
 */
export const getDefaultModels = (): List<string> =>
  Option(process.env[ENV_KEYS.DEFAULT_MODELS])
    .filter((envModels) => envModels.trim().length > 0)
    .map((envModels) => {
      const trimmed = envModels.trim().toLowerCase()
      // Special "free" keyword returns fallback free models synchronously
      if (trimmed === FREE_MODELS_SENTINEL) {
        return FALLBACK_FREE_MODELS
      }
      return List(
        envModels
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
      )
    })
    .orElse(DEFAULT_PANEL_MODELS)

/**
 * Get configured default models from environment or use defaults (async version).
 * Special value "free" dynamically fetches free models from OpenRouter API.
 */
export const getDefaultModelsAsync = async (): Promise<List<string>> => {
  const envModels = process.env[ENV_KEYS.DEFAULT_MODELS]

  if (!envModels || envModels.trim().length === 0) {
    return DEFAULT_PANEL_MODELS
  }

  const trimmed = envModels.trim().toLowerCase()

  // Special "free" keyword fetches dynamic free models
  if (trimmed === FREE_MODELS_SENTINEL) {
    return getFreeModels()
  }

  return List(
    envModels
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0),
  )
}

/**
 * Get max concurrent requests from environment or use default
 */
export const getMaxConcurrent = (): number =>
  Option(process.env[ENV_KEYS.MAX_CONCURRENT])
    .map((v) => parseInt(v, 10))
    .filter((n) => !isNaN(n) && n > 0)
    .orElse(DEFAULT_MAX_CONCURRENT)

/**
 * Get request timeout from environment or use default
 */
export const getRequestTimeout = (): number =>
  Option(process.env[ENV_KEYS.REQUEST_TIMEOUT])
    .map((v) => parseInt(v, 10))
    .filter((n) => !isNaN(n) && n > 0)
    .orElse(DEFAULT_REQUEST_TIMEOUT_MS)

/**
 * Default challenger models for the challenge tool (sync version).
 * Uses the same models as council queries (respects PANEL_DEFAULT_MODELS).
 */
export const getDefaultChallengerModels = (): List<string> => getDefaultModels()

/**
 * Default challenger models for the challenge tool (async version).
 * Uses the same models as council queries (respects PANEL_DEFAULT_MODELS).
 */
export const getDefaultChallengerModelsAsync = (): Promise<List<string>> => getDefaultModelsAsync()

/**
 * Routing modes for provider-prefixed model strings (PANEL_ROUTING).
 *
 * - auto: a prefixed model (e.g. "anthropic/...") uses its direct API when the
 *   key is set, and falls back to OpenRouter when it is not.
 * - strict: no fallback. A prefixed model is served by its own provider or the
 *   call fails, so a missing key can never quietly send prompts through OpenRouter.
 *
 * "openrouter/..." always goes through OpenRouter, and "azure/..." never does,
 * in either mode.
 */
export const ROUTING_MODES = ["auto", "strict"] as const

export type RoutingMode = (typeof ROUTING_MODES)[number]

export const DEFAULT_ROUTING_MODE: RoutingMode = "auto"

const isRoutingMode = (value: string): value is RoutingMode => (ROUTING_MODES as readonly string[]).includes(value)

/**
 * Get the routing mode from environment or use default.
 * Unrecognised values fall back to the default rather than failing startup.
 */
export const getRoutingMode = (): RoutingMode => {
  const value = Option(process.env[ENV_KEYS.ROUTING])
    .map((v) => v.trim().toLowerCase())
    .orElse("")
  return isRoutingMode(value) ? value : DEFAULT_ROUTING_MODE
}

/**
 * All available challenge types for stress-testing
 */
export const ALL_CHALLENGE_TYPES = ["logical", "factual", "completeness", "edge_cases", "alternatives"] as const
