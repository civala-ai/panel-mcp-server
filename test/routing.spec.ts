import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { queryModel, resolveModel } from "../src/providers/index"

// Stand in for the network call so queryModel can be timed without a provider
vi.mock("ai", () => ({
  generateText: vi.fn(() => Promise.resolve({ text: "ok", providerMetadata: {} })),
}))

const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "AZURE_API_KEY",
  "AZURE_BASE_URL",
  "PANEL_ROUTING",
]

const servedBy = (modelString: string): string =>
  resolveModel(modelString).fold(
    (error) => `error: ${error}`,
    (resolved) => resolved.servedBy,
  )

const errorFor = (modelString: string): string =>
  resolveModel(modelString).fold(
    (error) => error,
    () => "",
  )

describe("model routing", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    PROVIDER_KEYS.forEach((key) => delete process.env[key])
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("auto (default)", () => {
    it("falls back to OpenRouter when the direct key is missing", () => {
      const resolved = resolveModel("anthropic/claude-sonnet-5").fold(
        () => undefined,
        (r) => r,
      )
      expect(resolved?.requested).toBe("anthropic")
      expect(resolved?.servedBy).toBe("openrouter")
    })

    it("uses the direct provider when its key is set", () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
      expect(servedBy("anthropic/claude-sonnet-5")).toBe("anthropic")
    })

    it("suggests OpenRouter when neither key is set", () => {
      delete process.env.OPENROUTER_API_KEY
      expect(errorFor("openai/gpt-5.6-sol")).toContain("OPENAI_API_KEY or OPENROUTER_API_KEY")
    })
  })

  describe("strict", () => {
    beforeEach(() => {
      process.env.PANEL_ROUTING = "strict"
    })

    it("fails instead of falling back to OpenRouter", () => {
      const error = errorFor("anthropic/claude-sonnet-5")
      expect(error).toContain("ANTHROPIC_API_KEY")
      expect(error).toContain("PANEL_ROUTING=strict")
      expect(error).not.toContain("OPENROUTER_API_KEY")
    })

    it("still uses the direct provider when its key is set", () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key"
      expect(servedBy("google/gemini-3.1-pro-preview")).toBe("google")
    })

    it("still sends openrouter/ models through OpenRouter", () => {
      expect(servedBy("openrouter/anthropic/claude-sonnet-5")).toBe("openrouter")
    })

    it("still sends unprefixed models through OpenRouter", () => {
      expect(servedBy("some-model")).toBe("openrouter")
    })
  })

  it("never falls back for azure/, in either mode", () => {
    expect(errorFor("azure/gpt-6-astra")).toContain("AZURE_API_KEY")
    process.env.PANEL_ROUTING = "strict"
    expect(errorFor("azure/gpt-6-astra")).toContain("AZURE_API_KEY")
  })

  describe("queryModel", () => {
    it("reports the serving provider and splits latency into queue and model time", async () => {
      process.env.MISTRAL_API_KEY = "test-mistral-key"
      const result = await queryModel("mistral/mistral-large", "hello")

      expect("text" in result).toBe(true)
      if (!("text" in result)) return
      expect(result.servedBy).toBe("mistral")
      expect(result.queueMs).toBeGreaterThanOrEqual(0)
      expect(result.modelMs).toBeGreaterThanOrEqual(0)
      expect(result.latencyMs).toBe(result.queueMs + result.modelMs)
    })

    it("reports a fallback as served by OpenRouter", async () => {
      const result = await queryModel("mistral/mistral-large", "hello")
      expect("text" in result && result.servedBy).toBe("openrouter")
    })
  })
})
