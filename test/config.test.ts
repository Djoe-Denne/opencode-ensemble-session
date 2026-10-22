import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadConfig, DEFAULT_CONFIG } from "../src/config"

describe("config", () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ensemble-config-"))
    process.env.HOME = path.join(tmpDir, "home")
    delete process.env.USERPROFILE
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    delete process.env.OPENCODE_ENSEMBLE_TIMEOUT
    delete process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
    delete process.env.STALL_THRESHOLD_MS
    delete process.env.OPENCODE_ENSEMBLE_MAX_MEMBERS
  })

  test("DEFAULT_CONFIG has correct values", () => {
    expect(DEFAULT_CONFIG.mergeOnCleanup).toBe(true)
    expect(DEFAULT_CONFIG.stallThresholdMs).toBe(300_000)
    expect(DEFAULT_CONFIG.stallMinSteps).toBe(5)
    expect(DEFAULT_CONFIG.stallTokenThreshold).toBe(200)
    expect(DEFAULT_CONFIG.timeoutMs).toBe(1_800_000)
    expect(DEFAULT_CONFIG.rateLimitCapacity).toBe(10)
    expect(DEFAULT_CONFIG.maxActiveMembers).toBe(0)
    expect(DEFAULT_CONFIG.autoDispatch).toBe(false)
  })

  test("task pool config parses and env override wins", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ maxActiveMembers: 4, autoDispatch: true }))

    const fromFile = loadConfig(tmpDir)
    expect(fromFile.maxActiveMembers).toBe(4)
    expect(fromFile.autoDispatch).toBe(true)

    process.env.OPENCODE_ENSEMBLE_MAX_MEMBERS = "2"
    expect(loadConfig(tmpDir).maxActiveMembers).toBe(2)

    process.env.OPENCODE_ENSEMBLE_MAX_MEMBERS = "0"
    expect(loadConfig(tmpDir).maxActiveMembers).toBe(0)

    process.env.OPENCODE_ENSEMBLE_MAX_MEMBERS = "not-a-number"
    expect(loadConfig(tmpDir).maxActiveMembers).toBe(4) // invalid env preserves file value
  })

  test("returns defaults when no config files exist", () => {
    const config = loadConfig(tmpDir)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("loads routing catalogue and beta from plugin configuration", () => {
    const dir = path.join(tmpDir, ".opencode")
    mkdirSync(dir, { recursive: true })
    const modelRouting = { beta: 0, models: [{ id: "provider/model", intelligenceScore: 40, averageCostPerTask: 0, available: true, reasoningEffort: "high" }] }
    writeFileSync(path.join(dir, "ensemble.json"), JSON.stringify({ modelRouting }))
    expect(loadConfig(tmpDir).modelRouting).toEqual(modelRouting)
  })

  test("classification project overrides retain the globally chosen helper model", () => {
    const globalDir = path.join(process.env.HOME!, ".config", "opencode")
    const projectDir = path.join(tmpDir, ".opencode")
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(globalDir, "ensemble.json"), JSON.stringify({ classification: { helperModel: "fixture/flash", helperVariant: "medium" } }))
    writeFileSync(path.join(projectDir, "ensemble.json"), JSON.stringify({ classification: { timeoutMs: 1000 } }))
    expect(loadConfig(tmpDir).classification).toMatchObject({ mode: "off", helperModel: "fixture/flash", helperVariant: "medium", timeoutMs: 1000 })
  })

  test("invalid classification settings preserve unrelated configuration", () => {
    const dir = path.join(tmpDir, ".opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "ensemble.json"), JSON.stringify({ timeoutMs: 123, classification: { mode: "guess" } }))
    expect(loadConfig(tmpDir).classification).toEqual(DEFAULT_CONFIG.classification)
    expect(loadConfig(tmpDir).timeoutMs).toBe(123)
  })

  test("project routing beta override preserves the global catalogue", () => {
    const globalDir = path.join(process.env.HOME!, ".config", "opencode")
    const projectDir = path.join(tmpDir, ".opencode")
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    const models = [{ id: "provider/model", intelligenceScore: 40, averageCostPerTask: 0, available: true }]
    writeFileSync(path.join(globalDir, "ensemble.json"), JSON.stringify({ modelRouting: { beta: 0.35, models } }))
    writeFileSync(path.join(projectDir, "ensemble.json"), JSON.stringify({ modelRouting: { beta: 0.7 } }))
    expect(loadConfig(tmpDir).modelRouting).toEqual({ beta: 0.7, models })
  })

  test("invalid routing configuration cannot discard unrelated plugin settings", () => {
    const dir = path.join(tmpDir, ".opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "ensemble.json"), JSON.stringify({ timeoutMs: 123, modelRouting: { beta: -1, models: [] } }))
    const config = loadConfig(tmpDir)
    expect(config.timeoutMs).toBe(123)
    expect(config.modelRouting).toEqual(DEFAULT_CONFIG.modelRouting)
  })

  test("project config overrides defaults", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ stallThresholdMs: 60_000 }))

    const config = loadConfig(tmpDir)
    expect(config.stallThresholdMs).toBe(60_000)
    expect(config.mergeOnCleanup).toBe(true) // other defaults preserved
  })

  test("partial config merges correctly", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ mergeOnCleanup: false, rateLimitCapacity: 5 }))

    const config = loadConfig(tmpDir)
    expect(config.mergeOnCleanup).toBe(false)
    expect(config.rateLimitCapacity).toBe(5)
    expect(config.stallThresholdMs).toBe(300_000) // default preserved
  })

  test("invalid JSON logs warning and returns defaults", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), "not json{{{")

    const config = loadConfig(tmpDir)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("env var OPENCODE_ENSEMBLE_TIMEOUT overrides config", () => {
    process.env.OPENCODE_ENSEMBLE_TIMEOUT = "60000"
    const config = loadConfig(tmpDir)
    expect(config.timeoutMs).toBe(60_000)
  })

  test("env var OPENCODE_ENSEMBLE_RATE_LIMIT overrides config", () => {
    process.env.OPENCODE_ENSEMBLE_RATE_LIMIT = "0"
    const config = loadConfig(tmpDir)
    expect(config.rateLimitCapacity).toBe(0)
  })

  test("env var STALL_THRESHOLD_MS overrides config", () => {
    process.env.STALL_THRESHOLD_MS = "0"
    const config = loadConfig(tmpDir)
    expect(config.stallThresholdMs).toBe(0)
  })

  test("env vars override file values", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ timeoutMs: 999 }))
    process.env.OPENCODE_ENSEMBLE_TIMEOUT = "123"

    const config = loadConfig(tmpDir)
    expect(config.timeoutMs).toBe(123)
  })
})
