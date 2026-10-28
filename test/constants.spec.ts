import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { List } from "functype"

import {
  DEFAULT_PANEL_MODELS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
  getDefaultModels,
  getDefaultModelsAsync,
  getMaxConcurrent,
  getKeepaliveMs,
  getRequestTimeout,
  getRoutingMode,
} from "../src/constants"
import packageJson from "../package.json" with { type: "json" }

describe("constants", () => {
  describe("default values", () => {
    it("should have default panel models as List", () => {
      expect(DEFAULT_PANEL_MODELS.size).toBe(3)
      expect(DEFAULT_PANEL_MODELS.contains("openai/gpt-5.6-sol")).toBe(true)
      expect(DEFAULT_PANEL_MODELS.contains("anthropic/claude-sonnet-5")).toBe(true)
      expect(DEFAULT_PANEL_MODELS.contains("google/gemini-3.1-pro-preview")).toBe(true)
    })

    it("should have sensible defaults", () => {
      expect(DEFAULT_MAX_CONCURRENT).toBe(5)
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(300_000)
    })

    it("should have server metadata", () => {
      expect(SERVER_NAME).toBe("panel-mcp-server")
      expect(SERVER_VERSION).toBe(packageJson.version)
    })
  })

  describe("getDefaultModels", () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.resetModules()
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it("should return default models when env not set", () => {
      delete process.env.PANEL_DEFAULT_MODELS
      const models = getDefaultModels()
      expect(models.toArray()).toEqual(DEFAULT_PANEL_MODELS.toArray())
    })

    it("should parse models from environment", () => {
      process.env.PANEL_DEFAULT_MODELS = "openai/gpt-4,anthropic/claude-3"
      const models = getDefaultModels()
      expect(models.toArray()).toEqual(["openai/gpt-4", "anthropic/claude-3"])
    })

    it("should return default models when env is an empty string", () => {
      process.env.PANEL_DEFAULT_MODELS = ""
      const models = getDefaultModels()
      expect(models.toArray()).toEqual(DEFAULT_PANEL_MODELS.toArray())
    })

    it("should return default models when env is whitespace only", () => {
      process.env.PANEL_DEFAULT_MODELS = "   "
      const models = getDefaultModels()
      expect(models.toArray()).toEqual(DEFAULT_PANEL_MODELS.toArray())
    })

    it("should agree with the async variant on empty and whitespace values", async () => {
      for (const value of ["", "   "]) {
        process.env.PANEL_DEFAULT_MODELS = value
        expect(getDefaultModels().toArray()).toEqual((await getDefaultModelsAsync()).toArray())
      }
    })
  })

  describe("getMaxConcurrent", () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.resetModules()
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it("should return default when env not set", () => {
      delete process.env.PANEL_MAX_CONCURRENT
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT)
    })

    it("should parse from environment", () => {
      process.env.PANEL_MAX_CONCURRENT = "10"
      expect(getMaxConcurrent()).toBe(10)
    })

    it("should return default for invalid values", () => {
      process.env.PANEL_MAX_CONCURRENT = "invalid"
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT)
    })
  })

  describe("getRequestTimeout", () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.resetModules()
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it("should return default when env not set", () => {
      delete process.env.PANEL_REQUEST_TIMEOUT_MS
      expect(getRequestTimeout()).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    })

    it("should parse from environment", () => {
      process.env.PANEL_REQUEST_TIMEOUT_MS = "30000"
      expect(getRequestTimeout()).toBe(30000)
    })
  })

  describe("getKeepaliveMs", () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it("should default to 5 seconds, under agentgateway's 10-second header deadline", () => {
      delete process.env.PANEL_KEEPALIVE_MS
      expect(getKeepaliveMs()).toBe(5000)
    })

    it("should parse from environment", () => {
      process.env.PANEL_KEEPALIVE_MS = "3000"
      expect(getKeepaliveMs()).toBe(3000)
    })

    it("should accept 0 to turn keepalive off", () => {
      process.env.PANEL_KEEPALIVE_MS = "0"
      expect(getKeepaliveMs()).toBe(0)
    })

    it("should fall back to the default for negative or unparseable values", () => {
      process.env.PANEL_KEEPALIVE_MS = "-1"
      expect(getKeepaliveMs()).toBe(5000)
      process.env.PANEL_KEEPALIVE_MS = "soon"
      expect(getKeepaliveMs()).toBe(5000)
    })
  })

  describe("getRoutingMode", () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it("should default to auto when env not set", () => {
      delete process.env.PANEL_ROUTING
      expect(getRoutingMode()).toBe("auto")
    })

    it("should parse strict, ignoring case and whitespace", () => {
      process.env.PANEL_ROUTING = " Strict "
      expect(getRoutingMode()).toBe("strict")
    })

    it("should fall back to auto for unrecognised values", () => {
      process.env.PANEL_ROUTING = "direct-only"
      expect(getRoutingMode()).toBe("auto")
    })
  })
})
