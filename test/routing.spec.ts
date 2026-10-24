import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { generateText } from "ai"

import { getMaxConcurrent } from "../src/constants"
import { queryModel, resolveModel } from "../src/providers/index"
import { getRateLimiter } from "../src/providers/rate-limiter"

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

    it("refuses unprefixed models, so a typo can't reach OpenRouter", () => {
      const error = errorFor("antropic/claude-sonnet-5")
      expect(error).toContain("PANEL_ROUTING=strict")
      expect(error).toContain("openrouter/")
    })
  })

  it("sends unprefixed models through OpenRouter in auto mode", () => {
    expect(servedBy("some-model")).toBe("openrouter")
  })

  it("never falls back for azure/, in either mode", () => {
    expect(errorFor("azure/gpt-6-astra")).toContain("AZURE_API_KEY")
    process.env.PANEL_ROUTING = "strict"
    expect(errorFor("azure/gpt-6-astra")).toContain("AZURE_API_KEY")
  })

  describe("queryModel", () => {
    it("counts time waiting for a concurrency slot as queueMs, not modelMs", async () => {
      process.env.MISTRAL_API_KEY = "test-mistral-key"
      vi.mocked(generateText).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ text: "ok", providerMetadata: {} } as never), 60),
          ) as never,
      )

      // Hold every slot so the call has to queue before it reaches the provider
      const limiter = getRateLimiter()
      const slots = Array.from({ length: getMaxConcurrent() })
      await Promise.all(slots.map(() => limiter.acquire()))
      const pending = queryModel("mistral/mistral-large", "hello")
      await new Promise((resolve) => setTimeout(resolve, 60))
      slots.forEach(() => limiter.release())

      const result = await pending
      expect("text" in result).toBe(true)
      if (!("text" in result)) return
      expect(result.servedBy).toBe("mistral")
      expect(result.queueMs).toBeGreaterThanOrEqual(50)
      expect(result.modelMs).toBeGreaterThanOrEqual(50)
      expect(result.latencyMs).toBe(result.queueMs + result.modelMs)
    })

    it("reports the route on a failed provider call", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("model not found"))
      const result = await queryModel("openai/gpt-5.6-sol", "hello")
      expect(result).toMatchObject({ error: "model not found", servedBy: "openrouter" })
    })

    it("reports a fallback as served by OpenRouter", async () => {
      const result = await queryModel("mistral/mistral-large", "hello")
      expect("text" in result && result.servedBy).toBe("openrouter")
    })
  })
})
