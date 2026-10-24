/**
 * Provider registry and model resolution
 *
 * Dual-mode provider system:
 * 1. OpenRouter mode: Use openrouter/ prefix for any of 300+ models
 * 2. Direct mode: Use provider prefix for direct API calls (lower latency)
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModel } from "ai"
import { generateText } from "ai"
import type { Either } from "functype"
import { Left, List, Match, Option, Right, tryCatchAsync } from "functype"

import { ENV_KEYS, getRequestTimeout, getRoutingMode, PROVIDER_PREFIXES } from "../constants.js"
import type { ModelError, ModelResponse, ProviderType, QueryResult } from "../types.js"
import { isProviderConfigured } from "./config.js"
import { withRateLimit } from "./rate-limiter.js"

/**
 * Lazy-initialized provider instances
 */
type ProviderInstances = {
  openrouter?: ReturnType<typeof createOpenRouter>
  openai?: ReturnType<typeof createOpenAI>
  anthropic?: ReturnType<typeof createAnthropic>
  google?: ReturnType<typeof createGoogleGenerativeAI>
  mistral?: ReturnType<typeof createMistral>
  azure?: ReturnType<typeof createOpenAI>
}

const providers: ProviderInstances = {}

/**
 * Get or create OpenRouter provider
 */
const getOpenRouterProvider = (): Option<ReturnType<typeof createOpenRouter>> => {
  if (!isProviderConfigured("openrouter")) return Option.none()
  providers.openrouter ??= createOpenRouter({
    apiKey: process.env[ENV_KEYS.OPENROUTER_API_KEY],
  })
  return Option(providers.openrouter)
}

/**
 * Get or create OpenAI provider
 */
const getOpenAIProvider = (): Option<ReturnType<typeof createOpenAI>> => {
  if (!isProviderConfigured("openai")) return Option.none()
  providers.openai ??= createOpenAI({
    apiKey: process.env[ENV_KEYS.OPENAI_API_KEY],
  })
  return Option(providers.openai)
}

/**
 * Get or create Anthropic provider
 */
const getAnthropicProvider = (): Option<ReturnType<typeof createAnthropic>> => {
  if (!isProviderConfigured("anthropic")) return Option.none()
  providers.anthropic ??= createAnthropic({
    apiKey: process.env[ENV_KEYS.ANTHROPIC_API_KEY],
  })
  return Option(providers.anthropic)
}

/**
 * Get or create Google provider
 */
const getGoogleProvider = (): Option<ReturnType<typeof createGoogleGenerativeAI>> => {
  if (!isProviderConfigured("google")) return Option.none()
  providers.google ??= createGoogleGenerativeAI({
    apiKey: process.env[ENV_KEYS.GOOGLE_API_KEY],
  })
  return Option(providers.google)
}

/**
 * Get or create Mistral provider
 */
const getMistralProvider = (): Option<ReturnType<typeof createMistral>> => {
  if (!isProviderConfigured("mistral")) return Option.none()
  providers.mistral ??= createMistral({
    apiKey: process.env[ENV_KEYS.MISTRAL_API_KEY],
  })
  return Option(providers.mistral)
}

/**
 * Get or create Azure OpenAI provider
 *
 * Azure's v1 endpoint is OpenAI-compatible, so no Azure-specific SDK is needed:
 * the standard OpenAI client pointed at the resource URL is the documented
 * approach. AZURE_BASE_URL must end in /openai/v1/.
 */
const getAzureProvider = (): Option<ReturnType<typeof createOpenAI>> => {
  if (!isProviderConfigured("azure")) return Option.none()
  providers.azure ??= createOpenAI({
    baseURL: process.env[ENV_KEYS.AZURE_BASE_URL],
    apiKey: process.env[ENV_KEYS.AZURE_API_KEY],
  })
  return Option(providers.azure)
}

/**
 * Parsed model information
 */
type ParsedModel = {
  readonly provider: ProviderType
  readonly model: string
}

/**
 * Parse a model string to determine provider and model name
 *
 * Examples:
 * - "openrouter/anthropic/claude-sonnet-5" -> { provider: "openrouter", model: "anthropic/claude-sonnet-5" }
 * - "openai/gpt-5.6-sol" -> { provider: "openai", model: "gpt-5.6-sol" }
 * - "anthropic/claude-sonnet-5" -> { provider: "anthropic", model: "claude-sonnet-5" }
 * - "azure/gpt-6-astra" -> { provider: "azure", model: "gpt-6-astra" } (deployment name)
 */
const parseModelString = (modelString: string): Either<string, ParsedModel> => {
  // Check for openrouter/ prefix first (it contains nested provider)
  if (modelString.startsWith(PROVIDER_PREFIXES.openrouter)) {
    return Right({
      provider: "openrouter" as ProviderType,
      model: modelString.slice(PROVIDER_PREFIXES.openrouter.length),
    })
  }

  // Check other provider prefixes
  const providerEntries = Object.entries(PROVIDER_PREFIXES).filter(([p]) => p !== "openrouter")

  const matchedEntry = providerEntries.find(([, prefix]) => modelString.startsWith(prefix))

  return Option(matchedEntry)
    .map(([provider, prefix]): ParsedModel => ({
      provider: provider as ProviderType,
      model: modelString.slice(prefix.length),
    }))
    .map((parsed): Either<string, ParsedModel> => Right(parsed))
    .orElse(parseUnprefixedModel(modelString))
}

/**
 * A model with no known prefix goes to OpenRouter in auto mode. Strict mode
 * refuses it, so a typo such as "antropic/..." cannot quietly reach OpenRouter.
 */
const parseUnprefixedModel = (modelString: string): Either<string, ParsedModel> => {
  if (getRoutingMode() === "strict") {
    return Left(
      `Cannot determine provider for model: ${modelString}. PANEL_ROUTING=strict needs a provider prefix; ` +
        "use openrouter/ to send a model through OpenRouter.",
    )
  }
  return isProviderConfigured("openrouter")
    ? Right({ provider: "openrouter" as ProviderType, model: modelString })
    : Left(`Cannot determine provider for model: ${modelString}. Use a provider prefix (e.g., openai/gpt-5.6-sol).`)
}

/**
 * A resolved model and the provider that will serve it.
 * servedBy differs from requested only when a direct call fell back to OpenRouter.
 */
export type ResolvedModel = {
  readonly model: LanguageModel
  readonly requested: ProviderType
  readonly servedBy: ProviderType
}

/**
 * Try to get model from direct provider, falling back to OpenRouter unless
 * PANEL_ROUTING=strict
 */
const getModelWithFallback = <T>(
  requested: ProviderType,
  directProvider: Option<T>,
  getModel: (provider: T) => LanguageModel,
  openRouterModelPath: string,
): Option<ResolvedModel> =>
  directProvider.fold(
    () =>
      getRoutingMode() === "strict"
        ? Option.none<ResolvedModel>()
        : getOpenRouterProvider().map((or): ResolvedModel => ({
            model: or(openRouterModelPath) as LanguageModel,
            requested,
            servedBy: "openrouter",
          })),
    (provider) => Option<ResolvedModel>({ model: getModel(provider), requested, servedBy: requested }),
  )

/**
 * Error for a direct provider with no key. In strict mode OpenRouter is not an
 * option, so the message must not suggest it.
 */
const missingKeyError = (label: string, envKey: string): string =>
  getRoutingMode() === "strict"
    ? `${label} API key not configured. Set ${envKey} (PANEL_ROUTING=strict turns off the OpenRouter fallback).`
    : `${label} API key not configured. Set ${envKey} or OPENROUTER_API_KEY.`

/**
 * Resolve a model string to a language model instance and its serving provider
 */
export const resolveModel = (modelString: string): Either<string, ResolvedModel> => {
  return parseModelString(modelString).flatMap(({ provider, model }) =>
    Match(provider)
      .case("openrouter", () =>
        getOpenRouterProvider()
          .map((openrouter): ResolvedModel => ({
            model: openrouter(model) as LanguageModel,
            requested: "openrouter",
            servedBy: "openrouter",
          }))
          .toEither("OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable."),
      )
      .case("openai", () =>
        getModelWithFallback("openai", getOpenAIProvider(), (openai) => openai(model), `openai/${model}`).toEither(
          missingKeyError("OpenAI", ENV_KEYS.OPENAI_API_KEY),
        ),
      )
      .case("anthropic", () =>
        getModelWithFallback(
          "anthropic",
          getAnthropicProvider(),
          (anthropic) => anthropic(model),
          `anthropic/${model}`,
        ).toEither(missingKeyError("Anthropic", ENV_KEYS.ANTHROPIC_API_KEY)),
      )
      .case("google", () =>
        getModelWithFallback("google", getGoogleProvider(), (google) => google(model), `google/${model}`).toEither(
          missingKeyError("Google", ENV_KEYS.GOOGLE_API_KEY),
        ),
      )
      .case("mistral", () =>
        getModelWithFallback(
          "mistral",
          getMistralProvider(),
          (mistral) => mistral(model),
          `mistralai/${model}`,
        ).toEither(missingKeyError("Mistral", ENV_KEYS.MISTRAL_API_KEY)),
      )
      // No OpenRouter fallback here on purpose. Asking for azure/ means "bill my
      // Azure resource"; silently rerouting would spend on a different account.
      .case("azure", () =>
        getAzureProvider()
          .map((azure): ResolvedModel => ({
            model: azure(model) as LanguageModel,
            requested: "azure",
            servedBy: "azure",
          }))
          .toEither(
            "Azure not configured. Set AZURE_API_KEY and AZURE_BASE_URL " +
              "(the resource URL ending in /openai/v1/). Note the model must be a deployment name.",
          ),
      )
      .exhaustive(),
  )
}

/**
 * Query a single model with rate limiting
 */
export const queryModel = async (modelString: string, prompt: string, systemPrompt?: string): Promise<QueryResult> => {
  // performance.now() rather than Date.now(): a wall-clock correction mid-call can't skew the timings
  const startTime = performance.now()

  const modelResult = resolveModel(modelString)

  if (modelResult.isLeft()) {
    return {
      model: modelString,
      error: modelResult.fold(
        (err) => err,
        () => "Unknown error",
      ),
    }
  }

  const resolved = modelResult.fold(
    () => null as never,
    (m) => m,
  )

  const result = await tryCatchAsync(
    async () =>
      withRateLimit(async () => {
        // Taken inside the permit, so queue wait and the provider call are timed separately
        const callStart = performance.now()
        const response = await generateText({
          model: resolved.model,
          prompt,
          system: systemPrompt,
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(getRequestTimeout()),
        })
        return { response, callStart }
      }),
    (error): ModelError => ({
      model: modelString,
      servedBy: resolved.servedBy,
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return result.fold<QueryResult>(
    (error) => error,
    ({ response, callStart }) => {
      const queueMs = Math.round(callStart - startTime)
      const modelMs = Math.round(performance.now() - callStart)
      // Extract actual model/provider from OpenRouter's metadata if available
      const openrouterMeta = response.providerMetadata?.openrouter as Record<string, unknown> | undefined
      const actualModel = (openrouterMeta?.model ?? openrouterMeta?.provider ?? openrouterMeta?.id) as
        string | undefined
      return {
        model: modelString,
        servedBy: resolved.servedBy,
        ...(actualModel && { actualModel }),
        text: response.text,
        latencyMs: queueMs + modelMs,
        queueMs,
        modelMs,
      }
    },
  )
}

/**
 * Query multiple models in parallel
 */
export const queryModels = async (
  models: List<string>,
  prompt: string,
  systemPrompt?: string,
): Promise<{ responses: List<ModelResponse>; errors: List<ModelError> }> => {
  const results = await Promise.all(models.toArray().map((model) => queryModel(model, prompt, systemPrompt)))

  const responses = List(results.filter((r): r is ModelResponse => "text" in r))
  const errors = List(results.filter((r): r is ModelError => "error" in r))

  return { responses, errors }
}

export { ALL_PROVIDERS, getConfiguredProviders, isProviderConfigured } from "./config.js"
export { searchModels } from "./openrouter-models.js"
