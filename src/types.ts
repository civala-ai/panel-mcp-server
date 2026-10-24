/**
 * Type definitions for Panel MCP Server
 * Using functype for immutable, type-safe data structures
 */

import type { List } from "functype"

// ============================================================================
// OpenRouter Model Types
// ============================================================================

/**
 * A model from OpenRouter's API
 */
export type OpenRouterModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextLength: number
  readonly pricing: {
    readonly prompt: string
    readonly completion: string
  }
  readonly provider: string
}

/**
 * Options for searching OpenRouter models
 */
export type SearchModelsOptions = {
  readonly query?: string
  readonly provider?: string
  readonly maxPrice?: number
  readonly freeOnly?: boolean
  readonly limit?: number
}

/**
 * Result of a model search
 */
export type SearchModelsResult = {
  readonly models: List<OpenRouterModel>
  readonly query?: string
  readonly totalMatches: number
}

/**
 * Result of a single model query
 */
export type ModelResponse = {
  readonly model: string
  readonly servedBy: ProviderType // Provider that answered; "openrouter" for a prefixed model means it fell back
  readonly actualModel?: string // The actual model used (e.g., from OpenRouter's free router)
  readonly text: string
  readonly latencyMs: number // Total: queueMs + modelMs
  readonly queueMs: number // Waiting for a PANEL_MAX_CONCURRENT slot
  readonly modelMs: number // The provider call, including SDK retries
}

/**
 * Result of a failed model query
 */
export type ModelError = {
  readonly model: string
  readonly error: string
}

/**
 * Union type for query results - success or error
 */
export type QueryResult = ModelResponse | ModelError

/**
 * Type guard for ModelResponse
 */
export const isModelResponse = (result: QueryResult): result is ModelResponse => "text" in result

/**
 * Type guard for ModelError
 */
export const isModelError = (result: QueryResult): result is ModelError => "error" in result

/**
 * Result of a council query (parallel multi-model)
 */
export type CouncilQueryResult = {
  readonly responses: List<ModelResponse>
  readonly errors: List<ModelError>
  readonly metadata: {
    readonly totalLatencyMs: number
    readonly successCount: number
    readonly failedModels: List<string>
  }
}

/**
 * A single round in a debate
 */
export type DebateRound = {
  readonly round: number
  readonly affirmative: string
  readonly negative: string
}

/**
 * Result of a debate
 */
export type DebateResult = {
  readonly topic: string
  readonly affirmativeModel: string
  readonly negativeModel: string
  readonly rounds: List<DebateRound>
  readonly metadata: {
    readonly totalExchanges: number
    readonly totalLatencyMs: number
  }
}

/**
 * Structured critique from a model
 */
export type Critique = {
  readonly strengths: List<string>
  readonly weaknesses: List<string>
  readonly suggestions: List<string>
  readonly overallAssessment: string
}

/**
 * Result of a critique request
 */
export type CritiqueResult = {
  readonly critique: Critique
  readonly metadata: {
    readonly criticModel: string
    readonly latencyMs: number
  }
}

/**
 * Provider type for model resolution
 */
export type ProviderType = "openrouter" | "openai" | "anthropic" | "google" | "mistral" | "azure"

/**
 * Health check result for a provider
 */
export type ProviderHealth = {
  readonly provider: ProviderType
  readonly status: "healthy" | "unhealthy" | "unconfigured"
  readonly latencyMs?: number
  readonly error?: string
}

/**
 * Result of health_check tool
 */
export type HealthCheckResult = {
  readonly status: "healthy" | "degraded" | "unhealthy"
  readonly providers: List<ProviderHealth>
  readonly timestamp: string
}

/**
 * Query parameters for a single model
 */
export type QueryParams = {
  readonly prompt: string
  readonly model: string
  readonly systemPrompt?: string
}

/**
 * Parameters for council query
 */
export type CouncilQueryParams = {
  readonly prompt: string
  readonly models?: List<string>
  readonly systemPrompt?: string
}

/**
 * Parameters for debate
 */
export type DebateParams = {
  readonly topic: string
  readonly affirmativeModel: string
  readonly negativeModel: string
  readonly rounds?: number
}

/**
 * Parameters for critique
 */
export type CritiqueParams = {
  readonly originalPrompt: string
  readonly response: string
  readonly criticModel: string
  readonly aspects?: List<string>
}

/**
 * Challenge types for adversarial stress-testing
 */
export type ChallengeType = "logical" | "factual" | "completeness" | "edge_cases" | "alternatives"

/**
 * A single challenge from a model
 */
export type Challenge = {
  readonly model: string
  readonly servedBy: ProviderType
  readonly actualModel?: string
  readonly challengeType: ChallengeType
  readonly challenge: string
  readonly severity: "minor" | "moderate" | "significant"
  readonly reasoning: string
  readonly latencyMs: number
}

/**
 * Result of a challenge request
 */
export type ChallengeResult = {
  readonly proposedThought: string
  readonly context?: string
  readonly challenges: List<Challenge>
  readonly errors: List<ModelError>
  readonly summary: {
    readonly totalChallenges: number
    readonly bySeverity: Record<"minor" | "moderate" | "significant", number>
    readonly byType: Partial<Record<ChallengeType, number>>
  }
  readonly metadata: {
    readonly totalLatencyMs: number
    readonly successCount: number
    readonly challengerModels: List<string>
  }
}
