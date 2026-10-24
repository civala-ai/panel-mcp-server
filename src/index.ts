#!/usr/bin/env node
/**
 * Panel MCP Server
 *
 * Provides LLM council workflow tools for multi-model queries, debates, and reviews.
 * The calling LLM uses these tools to orchestrate multi-model workflows and can
 * synthesize/compile the results itself.
 */

import { program } from "commander"
import { List, Option, Try } from "functype"
import { createServer } from "somamcp/node"
import { z } from "zod"

import {
  ALL_CHALLENGE_TYPES,
  DEFAULT_DEBATE_ROUNDS,
  getDefaultChallengerModelsAsync,
  getDefaultModelsAsync,
  MAX_DEBATE_ROUNDS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js"
import { PRIOR_FINDINGS_SCHEMA, renderPriorFindings } from "./prior-findings.js"
import {
  ALL_PROVIDERS,
  getConfiguredProviders,
  isProviderConfigured,
  queryModel,
  queryModels,
  searchModels,
} from "./providers/index.js"
import {
  type Challenge,
  type ChallengeResult,
  type ChallengeType,
  type CouncilQueryResult,
  type Critique,
  type CritiqueResult,
  type DebateResult,
  type DebateRound,
  type HealthCheckResult,
  isModelError,
  type ModelError,
  type ProviderHealth,
} from "./types.js"

// Create the MCP server
const server = createServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
})

// ============================================================================
// Serialization helpers for List -> JSON
// ============================================================================

/**
 * Convert a result with List fields to plain JSON-serializable object
 */
const serializeCouncilResult = (result: CouncilQueryResult): object => ({
  responses: result.responses.toArray(),
  errors: result.errors.toArray(),
  metadata: {
    ...result.metadata,
    failedModels: result.metadata.failedModels.toArray(),
  },
})

const serializeDebateResult = (result: DebateResult): object => ({
  ...result,
  rounds: result.rounds.toArray(),
})

const serializeCritiqueResult = (result: CritiqueResult): object => ({
  critique: {
    strengths: result.critique.strengths.toArray(),
    weaknesses: result.critique.weaknesses.toArray(),
    suggestions: result.critique.suggestions.toArray(),
    overallAssessment: result.critique.overallAssessment,
  },
  metadata: result.metadata,
})

const serializeHealthResult = (result: HealthCheckResult): object => ({
  ...result,
  providers: result.providers.toArray(),
})

const serializeChallengeResult = (result: ChallengeResult): object => ({
  proposedThought: result.proposedThought,
  context: result.context,
  challenges: result.challenges.toArray(),
  errors: result.errors.toArray(),
  summary: result.summary,
  metadata: {
    ...result.metadata,
    challengerModels: result.metadata.challengerModels.toArray(),
  },
})

// ============================================================================
// Health & Discovery Tools
// ============================================================================

server.addTool({
  name: "health_check",
  description:
    "Check the health status of configured providers. Returns status for each provider and overall system health.",
  parameters: z.object({}),
  execute: (): Promise<string> => {
    const providers = getConfiguredProviders()

    const healthResults: List<ProviderHealth> = providers.map((provider): ProviderHealth =>
      isProviderConfigured(provider)
        ? { provider, status: "healthy", latencyMs: 0 }
        : { provider, status: "unconfigured" },
    )

    const healthyCount = healthResults.filter((h) => h.status === "healthy").size
    const totalConfigured = healthResults.filter((h) => h.status !== "unconfigured").size

    const status =
      healthyCount === totalConfigured && totalConfigured > 0
        ? ("healthy" as const)
        : healthyCount > 0
          ? ("degraded" as const)
          : ("unhealthy" as const)

    const result: HealthCheckResult = {
      status,
      providers: healthResults,
      timestamp: new Date().toISOString(),
    }

    return Promise.resolve(JSON.stringify(serializeHealthResult(result), null, 2))
  },
})

server.addTool({
  name: "list_default_models",
  description:
    "Get the default models used when model parameters are omitted. CALL THIS FIRST to confirm what models will be used. All tools use these defaults when you don't specify models.",
  parameters: z.object({}),
  execute: async (): Promise<string> => {
    const models = await getDefaultModelsAsync()
    return JSON.stringify(
      {
        defaultModels: models.toArray(),
        note: "These models are used by default when no models are specified in council_query, debate, challenge, or critique tools.",
      },
      null,
      2,
    )
  },
})

server.addTool({
  name: "list_providers",
  description:
    "Check which LLM providers are configured. Use search_models to find specific models on OpenRouter (300+ available).",
  parameters: z.object({}),
  execute: (): Promise<string> => {
    const providers = getConfiguredProviders()
    const result = {
      // Derived from ALL_PROVIDERS rather than hardcoded, so a newly added
      // provider can never count toward configuredCount while being invisible
      // in this map — which is exactly what happened when azure was added.
      providers: Object.fromEntries(
        ALL_PROVIDERS.toArray().map((provider) => [provider, { configured: isProviderConfigured(provider) }]),
      ),
      configuredCount: providers.size,
      note: "Use search_models to find specific models on OpenRouter",
    }
    return Promise.resolve(JSON.stringify(result, null, 2))
  },
})

server.addTool({
  name: "search_models",
  description:
    "Search OpenRouter's 300+ models by name, provider, or capabilities. Use this to find specific models for council_query, debate, or other tools.",
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe("Search term (model name or provider like 'sonnet', 'claude', 'llama', 'deepseek')"),
    provider: z
      .string()
      .optional()
      .describe("Filter by provider (e.g., 'anthropic', 'openai', 'meta-llama', 'deepseek')"),
    maxPrice: z.number().optional().describe("Max price per 1M tokens in dollars"),
    freeOnly: z.boolean().optional().describe("Only show free models"),
    limit: z.number().min(1).max(50).optional().describe("Max results (default: 10)"),
  }),
  execute: async (args): Promise<string> => {
    const result = await searchModels({
      query: args.query,
      provider: args.provider,
      maxPrice: args.maxPrice,
      freeOnly: args.freeOnly,
      limit: args.limit,
    })

    return JSON.stringify(
      {
        models: result.models.toArray().map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          contextLength: m.contextLength,
          pricing: {
            promptPer1M: `$${(parseFloat(m.pricing.prompt) * 1_000_000).toFixed(2)}`,
            completionPer1M: `$${(parseFloat(m.pricing.completion) * 1_000_000).toFixed(2)}`,
          },
        })),
        totalMatches: result.totalMatches,
        showing: result.models.size,
        ...(result.query && { query: result.query }),
      },
      null,
      2,
    )
  },
})

// ============================================================================
// Query Tools
// ============================================================================

server.addTool({
  name: "query_model",
  description: "Query a single LLM model directly. Use for targeted queries or building custom workflows.",
  parameters: z.object({
    prompt: z.string().describe("The prompt to send to the model"),
    model: z
      .string()
      .describe(
        "Model identifier (e.g., 'openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5', 'openrouter/meta-llama/llama-3.3-70b-instruct')",
      ),
    systemPrompt: z.string().optional().describe("Optional system prompt for context"),
  }),
  execute: async (args): Promise<string> => {
    const result = await queryModel(args.model, args.prompt, args.systemPrompt)
    return JSON.stringify(result, null, 2)
  },
})

server.addTool({
  name: "council_query",
  description:
    "Query multiple LLM models in parallel. Returns all responses for the calling LLM to synthesize, compare, or find consensus. Use when you want diverse perspectives on a question.",
  parameters: z.object({
    prompt: z.string().describe("The prompt to send to all models"),
    models: z
      .array(z.string())
      .optional()
      .describe(
        "Model identifiers. OMIT THIS to use server defaults (recommended). Only specify if you need specific models.",
      ),
    systemPrompt: z.string().optional().describe("Optional shared system prompt for all models"),
    proposedThought: z
      .string()
      .optional()
      .describe("A proposed thought/answer to share with the council. Other models will see this context."),
    compareMode: z
      .boolean()
      .optional()
      .describe("When true, models explicitly compare their answer to the proposed thought."),
  }),
  execute: async (args): Promise<string> => {
    const models = args.models ? List(args.models) : await getDefaultModelsAsync()
    const startTime = Date.now()

    // Build context from proposed thought if provided
    const thoughtContext = Option(args.proposedThought)
      .map((thought) => {
        const instruction = args.compareMode
          ? "Compare your analysis with this thought - note agreements and disagreements."
          : "Consider this context, but provide your own independent analysis."
        return `\n\nContext: A proposed thought on this question:\n"${thought}"\n\n${instruction}`
      })
      .orElse("")

    const enhancedPrompt = `${args.prompt}${thoughtContext}`

    const { responses, errors } = await queryModels(models, enhancedPrompt, args.systemPrompt)

    const result: CouncilQueryResult = {
      responses,
      errors,
      metadata: {
        totalLatencyMs: Date.now() - startTime,
        successCount: responses.size,
        failedModels: errors.map((e) => e.model),
      },
    }

    return JSON.stringify(serializeCouncilResult(result), null, 2)
  },
})

// ============================================================================
// Debate Tool
// ============================================================================

server.addTool({
  name: "debate",
  description:
    "Run a structured adversarial debate between two models on a topic. Returns the full transcript for the calling LLM to analyze, judge, or synthesize key arguments.",
  parameters: z.object({
    topic: z.string().describe("The debate topic or proposition"),
    affirmativeModel: z
      .string()
      .optional()
      .describe(
        "Model arguing FOR. OMIT THIS to use server defaults (recommended). Only specify if you need a specific model.",
      ),
    negativeModel: z
      .string()
      .optional()
      .describe(
        "Model arguing AGAINST. OMIT THIS to use server defaults (recommended). Only specify if you need a specific model.",
      ),
    rounds: z
      .number()
      .min(1)
      .max(MAX_DEBATE_ROUNDS)
      .optional()
      .describe(`Number of debate rounds (1-${MAX_DEBATE_ROUNDS}). Default: ${DEFAULT_DEBATE_ROUNDS}`),
    proposedThought: z.string().optional().describe("A proposed thought on the topic to share with debaters."),
    leaningSide: z
      .enum(["affirmative", "negative", "neutral"])
      .optional()
      .describe("Which side the proposed thought leans toward. Default: neutral"),
  }),
  execute: async (args): Promise<string> => {
    const defaultModels = await getDefaultModelsAsync()
    const affirmativeModel = args.affirmativeModel ?? defaultModels.get(0).orElse("openrouter/openrouter/free")
    const negativeModel = args.negativeModel ?? defaultModels.get(1).orElse("openrouter/openrouter/free")
    const numRounds = Option(args.rounds).orElse(DEFAULT_DEBATE_ROUNDS)
    const startTime = Date.now()

    // Build context from proposed thought if provided
    const thoughtContext = Option(args.proposedThought)
      .map((thought) => {
        const leaningSide = Option(args.leaningSide).orElse("neutral")
        const leaningDescription =
          leaningSide === "neutral"
            ? "This thought is presented neutrally for context."
            : `This thought leans toward the ${leaningSide} position.`
        return `\n\nA proposed thought on this topic:\n"${thought}"\n${leaningDescription}`
      })
      .orElse("")

    type DebateState = {
      readonly rounds: List<DebateRound>
      readonly previousArguments: string
    }

    const initialState: DebateState = { rounds: List.empty(), previousArguments: "" }

    const executeRound = async (state: DebateState, round: number): Promise<DebateState> => {
      const roundContext =
        round === 1
          ? thoughtContext
          : `\n\nPrevious arguments in this debate:\n${state.previousArguments}\n\nContinue the debate, responding to the opponent's latest points.`

      // Affirmative argues first
      const affirmativePrompt = `You are participating in a formal debate. You are arguing FOR the following proposition:\n\n"${args.topic}"\n\nThis is round ${round} of ${numRounds}.${roundContext}\n\nPresent your arguments clearly and persuasively. ${round > 1 ? "Address your opponent's points and strengthen your position." : "Make your opening argument."}`

      const affirmativeResult = await queryModel(affirmativeModel, affirmativePrompt)

      if (isModelError(affirmativeResult)) {
        return Promise.reject(new Error(`Affirmative model failed: ${affirmativeResult.error}`))
      }

      // Update context for negative
      const affirmativeArg = `Round ${round} - Affirmative (${affirmativeModel}):\n${affirmativeResult.text}`
      const updatedArgs = state.previousArguments ? `${state.previousArguments}\n\n${affirmativeArg}` : affirmativeArg

      // Negative responds
      const negativePrompt = `You are participating in a formal debate. You are arguing AGAINST the following proposition:\n\n"${args.topic}"\n\nThis is round ${round} of ${numRounds}.\n\nPrevious arguments in this debate:\n${updatedArgs}\n\nPresent your counter-arguments clearly and persuasively. Respond to your opponent's points and make your case against the proposition.`

      const negativeResult = await queryModel(negativeModel, negativePrompt)

      if (isModelError(negativeResult)) {
        return Promise.reject(new Error(`Negative model failed: ${negativeResult.error}`))
      }

      // Update context for next round
      const negativeArg = `Round ${round} - Negative (${negativeModel}):\n${negativeResult.text}`

      return {
        rounds: state.rounds.add({
          round,
          affirmative: affirmativeResult.text,
          negative: negativeResult.text,
        }),
        previousArguments: `${updatedArgs}\n\n${negativeArg}`,
      }
    }

    // Execute rounds sequentially using reduce
    const roundNumbers = List(Array.from({ length: numRounds }, (_, i) => i + 1))
    const finalState = await roundNumbers
      .toArray()
      .reduce(async (accPromise, round) => executeRound(await accPromise, round), Promise.resolve(initialState))

    const result: DebateResult = {
      topic: args.topic,
      affirmativeModel,
      negativeModel,
      rounds: finalState.rounds,
      metadata: {
        totalExchanges: numRounds * 2,
        totalLatencyMs: Date.now() - startTime,
      },
    }

    return JSON.stringify(serializeDebateResult(result), null, 2)
  },
})

// ============================================================================
// Critique Tool
// ============================================================================

server.addTool({
  name: "critique",
  description:
    "Have a model critique a response. Returns structured feedback with strengths, weaknesses, and suggestions. Use to get a second opinion or improve a response. For a follow-up round on a revised draft, pass priorFindings so the reviewer checks whether they were resolved instead of repeating them.",
  parameters: z.object({
    originalPrompt: z.string().describe("The original prompt that generated the response"),
    response: z.string().describe("The response to critique (from another model or user-provided)"),
    criticModel: z
      .string()
      .optional()
      .describe(
        "Model to critique. OMIT THIS to use server defaults (recommended). Only specify if you need a specific model.",
      ),
    aspects: z
      .array(z.string())
      .optional()
      .describe("Specific aspects to focus on (e.g., ['accuracy', 'completeness', 'clarity'])"),
    priorFindings: PRIOR_FINDINGS_SCHEMA,
  }),
  execute: async (args): Promise<string> => {
    const defaultModels = await getDefaultModelsAsync()
    const criticModel = args.criticModel ?? defaultModels.get(0).orElse("openrouter/openrouter/free")
    const aspectsClause = Option(args.aspects)
      .filter((a) => a.length > 0)
      .map((aspects) => `\n\nFocus particularly on these aspects: ${aspects.join(", ")}`)
      .orElse("")
    const priorClause = renderPriorFindings(Option(args.priorFindings))

    const critiquePrompt = `You are a critical reviewer. Analyze the following response to a prompt and provide structured feedback.

Original prompt:
"${args.originalPrompt}"

Response to critique:
"${args.response}"
${aspectsClause}${priorClause}

Provide your critique in the following JSON format:
{
  "strengths": ["list of strong points"],
  "weaknesses": ["list of weak points or issues"],
  "suggestions": ["list of specific improvements"],
  "overallAssessment": "brief overall assessment"
}

Respond ONLY with the JSON object, no additional text.`

    const startTime = Date.now()
    const result = await queryModel(criticModel, critiquePrompt)

    if (isModelError(result)) {
      return JSON.stringify({ error: `Critique failed: ${result.error}` }, null, 2)
    }

    // Parse the critique response using Try
    const extractJson = (text: string): string => {
      const trimmed = text.trim()
      return trimmed.startsWith("```") ? trimmed.replace(/```(?:json)?\n?/g, "").trim() : trimmed
    }

    const critique = Try(() => {
      return JSON.parse(extractJson(result.text)) as {
        strengths?: string[]
        weaknesses?: string[]
        suggestions?: string[]
        overallAssessment?: string
      }
    }).fold(
      (): Critique => ({
        strengths: List.empty(),
        weaknesses: List.empty(),
        suggestions: List.empty(),
        overallAssessment: result.text,
      }),
      (parsed): Critique => ({
        strengths: List(parsed.strengths ?? []),
        weaknesses: List(parsed.weaknesses ?? []),
        suggestions: List(parsed.suggestions ?? []),
        overallAssessment: parsed.overallAssessment ?? result.text,
      }),
    )

    const critiqueResult: CritiqueResult = {
      critique,
      metadata: {
        criticModel,
        latencyMs: Date.now() - startTime,
      },
    }

    return JSON.stringify(serializeCritiqueResult(critiqueResult), null, 2)
  },
})

// ============================================================================
// Challenge Tool
// ============================================================================

server.addTool({
  name: "challenge",
  description:
    "Have multiple models find weaknesses in a proposed thought. Returns structured challenges to help strengthen the reasoning. Use for adversarial stress-testing of ideas. For a follow-up round on a revised draft, pass priorFindings so challengers verify whether they were resolved instead of repeating them.",
  parameters: z.object({
    proposedThought: z.string().describe("The thought/claim to challenge"),
    context: z.string().optional().describe("Additional context about the thought"),
    challengers: z
      .array(z.string())
      .optional()
      .describe(
        "Challenger models. OMIT THIS to use server defaults (recommended). Only specify if you need specific models.",
      ),
    challengeTypes: z
      .array(z.enum(["logical", "factual", "completeness", "edge_cases", "alternatives"]))
      .optional()
      .describe("Types of challenges to focus on. Defaults to all types."),
    priorFindings: PRIOR_FINDINGS_SCHEMA,
  }),
  execute: async (args): Promise<string> => {
    const challengers = args.challengers ? List(args.challengers) : await getDefaultChallengerModelsAsync()
    const challengeTypes = Option(args.challengeTypes)
      .filter((t) => t.length > 0)
      .orElse([...ALL_CHALLENGE_TYPES])
    const startTime = Date.now()

    const contextClause = Option(args.context)
      .map((ctx) => `\n\nAdditional context:\n${ctx}`)
      .orElse("")
    const priorClause = renderPriorFindings(Option(args.priorFindings))

    const challengePrompt = `You are a critical analyst tasked with finding weaknesses in an argument or position. Your goal is to help strengthen the reasoning by identifying genuine issues.

Position to analyze:
"${args.proposedThought}"${contextClause}${priorClause}

Focus on these types of challenges: ${challengeTypes.join(", ")}

Challenge type definitions:
- logical: Flaws in reasoning, invalid inferences, contradictions
- factual: Incorrect or unverified claims, missing evidence
- completeness: Important considerations not addressed, gaps in analysis
- edge_cases: Scenarios where the position breaks down or fails
- alternatives: Better approaches or solutions not considered

Provide your challenges in the following JSON format (array of challenges):
[
  {
    "challengeType": "logical|factual|completeness|edge_cases|alternatives",
    "challenge": "Description of the weakness",
    "severity": "minor|moderate|significant",
    "reasoning": "Why this matters"
  }
]

Be rigorous but fair. Only raise genuine issues that would help improve the position. If the position is strong, you may return fewer challenges.

Respond ONLY with the JSON array, no additional text.`

    // Query all challengers in parallel
    const { responses, errors } = await queryModels(challengers, challengePrompt)

    // Parse challenges from each response
    const extractJson = (text: string): string => {
      const trimmed = text.trim()
      return trimmed.startsWith("```") ? trimmed.replace(/```(?:json)?\n?/g, "").trim() : trimmed
    }

    type ParsedChallenge = {
      challengeType?: string
      challenge?: string
      severity?: string
      reasoning?: string
    }

    const isChallengeType = (value: unknown): value is ChallengeType =>
      (ALL_CHALLENGE_TYPES as readonly unknown[]).includes(value)

    const allChallenges: Challenge[] = responses.toArray().flatMap((response) => {
      const parsed = Try(() => JSON.parse(extractJson(response.text)) as ParsedChallenge[]).fold(
        () => [] as ParsedChallenge[],
        (result) => (Array.isArray(result) ? result : []),
      )

      return parsed.flatMap((p): Challenge[] =>
        isChallengeType(p.challengeType) && p.challenge && p.severity && p.reasoning
          ? [
              {
                model: response.model,
                actualModel: response.actualModel,
                challengeType: p.challengeType,
                challenge: p.challenge,
                severity: p.severity as "minor" | "moderate" | "significant",
                reasoning: p.reasoning,
                latencyMs: response.latencyMs,
              },
            ]
          : [],
      )
    })

    // Build summary
    const bySeverity = { minor: 0, moderate: 0, significant: 0 }
    const byType: Partial<Record<ChallengeType, number>> = {}

    allChallenges.forEach((c) => {
      bySeverity[c.severity]++
      byType[c.challengeType] = (byType[c.challengeType] ?? 0) + 1
    })

    const result: ChallengeResult = {
      proposedThought: args.proposedThought,
      context: args.context,
      challenges: List(allChallenges),
      errors: errors as List<ModelError>,
      summary: {
        totalChallenges: allChallenges.length,
        bySeverity,
        byType,
      },
      metadata: {
        totalLatencyMs: Date.now() - startTime,
        successCount: responses.size,
        challengerModels: responses.map((r) => r.model),
      },
    }

    return JSON.stringify(serializeChallengeResult(result), null, 2)
  },
})

// ============================================================================
// CLI Entry Point
// ============================================================================

program
  .name("panel-mcp-server")
  .description("MCP server providing LLM council workflow tools")
  .version(SERVER_VERSION)
  .option("--stdio", "Use stdio transport (default)")
  .option("--http <port>", "Use HTTP transport on specified port")
  .action((options) => {
    const httpPort = Option(options.http)
      .map((portStr) => parseInt(portStr, 10))
      .filter((port) => !isNaN(port))

    if (Option.isSome(httpPort)) {
      const port = httpPort.orElse(3000)
      void server.start({
        transportType: "httpStream",
        httpStream: { port, host: "0.0.0.0" },
      })
      console.error(`Panel MCP Server running on http://0.0.0.0:${port}`)
    } else {
      void server.start({
        transportType: "stdio",
      })
    }
  })

program.parse()
