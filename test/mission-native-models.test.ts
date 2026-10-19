import { describe, expect, test } from "bun:test"
import { nativeMissionModels } from "../src/mission-native-models"

describe("native mission model catalogue", () => {
  test("uses connection/native ID rather than remote modelID and preserves exact variants", () => {
    const native = [{ providerID: "connection", id: "local-alias", modelID: "remote-wire-id", enabled: true, variants: [{ id: "medium" }, { id: "max" }] }]
    expect(nativeMissionModels(native)).toEqual([
      { id: "connection/local-alias" },
      { id: "connection/local-alias", variant: "medium" },
      { id: "connection/local-alias", variant: "max" },
    ])
  })

  test("disabled native models cannot be approved, even if they expose variants", () => {
    expect(nativeMissionModels([{ providerID: "p", id: "disabled", enabled: false, variants: [{ id: "high" }] }])).toEqual([])
    expect(nativeMissionModels([])).toEqual([])
  })
})
