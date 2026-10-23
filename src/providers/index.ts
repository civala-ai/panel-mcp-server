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

import { ENV_KEYS, getRequestTimeout, PROVIDER_PREFIXES } from "../constants.js"
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
    .orElse(
      // Default to openrouter if no prefix and openrouter is configured
      isProviderConfigured("openrouter")
        ? Right({ provider: "openrouter" as ProviderType, model: modelString })
        : Left(
            `Cannot determine provider for model: ${modelString}. Use a provider prefix (e.g., openai/gpt-5.6-sol).`,
          ),
    )
}

/**
 * Try to get model from direct provider, falling back to OpenRouter
 */
const getModelWithFallback = <T>(
  directProvider: Option<T>,
  getModel: (provider: T) => LanguageModel,
  openRouterModelPath: string,
): Option<LanguageModel> => {
  return directProvider.map(getModel).fold(
    () => getOpenRouterProvider().map((or) => or(openRouterModelPath) as LanguageModel),
    (model) => Option(model),
  )
}

/**
 * Resolve a model string to a language model instance
 */
export const resolveModel = (modelString: string): Either<string, LanguageModel> => {
  return parseModelString(modelString).flatMap(({ provider, model }) =>
    Match(provider)
      .case("openrouter", () =>
        getOpenRouterProvider()
          .map((openrouter) => openrouter(model) as LanguageModel)
          .toEither("OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable."),
      )
      .case("openai", () =>
        getModelWithFallback(getOpenAIProvider(), (openai) => openai(model), `openai/${model}`).toEither(
          "OpenAI API key not configured. Set OPENAI_API_KEY or OPENROUTER_API_KEY.",
        ),
      )
      .case("anthropic", () =>
        getModelWithFallback(getAnthropicProvider(), (anthropic) => anthropic(model), `anthropic/${model}`).toEither(
          "Anthropic API key not configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
        ),
      )
      .case("google", () =>
        getModelWithFallback(getGoogleProvider(), (google) => google(model), `google/${model}`).toEither(
          "Google API key not configured. Set GOOGLE_GENERATIVE_AI_API_KEY or OPENROUTER_API_KEY.",
        ),
      )
      .case("mistral", () =>
        getModelWithFallback(getMistralProvider(), (mistral) => mistral(model), `mistralai/${model}`).toEither(
          "Mistral API key not configured. Set MISTRAL_API_KEY or OPENROUTER_API_KEY.",
        ),
      )
      // No OpenRouter fallback here on purpose. Asking for azure/ means "bill my
      // Azure resource"; silently rerouting would spend on a different account.
      .case("azure", () =>
        getAzureProvider()
          .map((azure) => azure(model) as LanguageModel)
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
  const startTime = Date.now()

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

  const model = modelResult.fold(
    () => null as never,
    (m) => m,
  )

  const result = await tryCatchAsync(
    async () =>
      withRateLimit(async () =>
        generateText({
          model,
          prompt,
          system: systemPrompt,
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(getRequestTimeout()),
        }),
      ),
    (error): ModelError => ({
      model: modelString,
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return result.fold<QueryResult>(
    (error) => error,
    (response) => {
      // Extract actual model/provider from OpenRouter's metadata if available
      const openrouterMeta = response.providerMetadata?.openrouter as Record<string, unknown> | undefined
      const actualModel = (openrouterMeta?.model ?? openrouterMeta?.provider ?? openrouterMeta?.id) as
        string | undefined
      return {
        model: modelString,
        ...(actualModel && { actualModel }),
        text: response.text,
        latencyMs: Date.now() - startTime,
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
