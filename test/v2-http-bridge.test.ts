import { expect, test } from "bun:test"
import { discoverV2HttpBridge } from "../src/v2-http-bridge"

test("discovery uses only discover and headers, returning credentials in memory", async () => {
  const endpoint = { url: "http://127.0.0.1:41037", auth: { type: "basic" as const, username: "fixture", password: "fixture" } }
  const result = await discoverV2HttpBridge({
    discover: async () => endpoint,
    headers: value => { expect(value).toBe(endpoint); return { authorization: "Basic fixture" } },
  })
  expect(result).toEqual({ apiUrl: endpoint.url, authorization: "Basic fixture" })
})

test("an absent service is not started and headers are not requested", async () => {
  expect(await discoverV2HttpBridge({
    discover: async () => undefined,
    headers: () => { throw new Error("must not request credentials") },
  })).toBeUndefined()
})
