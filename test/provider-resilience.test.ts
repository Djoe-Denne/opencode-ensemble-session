import { describe, expect, test } from "bun:test"
import { classifyProviderEvent } from "../src/provider-resilience"

const alternatives = [
  { id: "openai/gpt-6.1-sol", variant: "low" },
  { id: "opencode-go/gpt-6-luna", variant: "none" },
]

describe("provider resilience", () => {
  test("keeps the admitted model for the first three rate-limit observations", () => {
    expect(classifyProviderEvent({
      message: "Rate limit reached",
      attempt: 1,
      admittedProvider: "openai",
      alternatives,
      failoverUsed: false,
    })).toEqual({ kind: "retry" })
    expect(classifyProviderEvent({
      message: "HTTP 500",
      attempt: 3,
      admittedProvider: "openai",
      alternatives,
      failoverUsed: false,
    })).toEqual({ kind: "retry" })
  })

  test("switches once after the ceiling when another provider is approved", () => {
    expect(classifyProviderEvent({
      message: "Rate limit reached",
      attempt: 4,
      admittedProvider: "openai",
      alternatives,
      failoverUsed: false,
    })).toEqual({ kind: "failover", model: { id: "opencode-go/gpt-6-luna", variant: "none" } })
  })

  test("switches on an explicit host refusal and stops when no other provider exists", () => {
    expect(classifyProviderEvent({
      message: "No automatic retry or provider switch",
      attempt: 1,
      admittedProvider: "openai",
      alternatives,
      failoverUsed: false,
    }).kind).toBe("failover")
    expect(classifyProviderEvent({
      message: "No automatic retry or provider switch",
      attempt: 1,
      admittedProvider: "openai",
      alternatives: [{ id: "openai/other", variant: "high" }],
      failoverUsed: false,
    }).kind).toBe("stop")
  })

  test("fails over once to another approved provider after an authentication failure", () => {
    expect(classifyProviderEvent({
      message: "provider.auth rejected",
      attempt: 1,
      admittedProvider: "openai",
      alternatives,
      failoverUsed: false,
    })).toEqual({ kind: "failover", model: { id: "opencode-go/gpt-6-luna", variant: "none" } })
  })

  test("does not walk same-provider alternatives after an authentication failure", () => {
    expect(classifyProviderEvent({
      message: "authentication failed",
      attempt: 1,
      admittedProvider: "openai",
      alternatives: [{ id: "openai/other", variant: "high" }],
      failoverUsed: false,
    }).kind).toBe("stop")
  })

  test("stops a second switch for the same work generation", () => {
    expect(classifyProviderEvent({
      message: "model is unavailable",
      attempt: 1,
      admittedProvider: "opencode-go",
      alternatives,
      failoverUsed: true,
    }).kind).toBe("stop")
  })
})
