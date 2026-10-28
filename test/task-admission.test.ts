import { expect, test } from "bun:test"
import { taskSpawnOptions } from "../src/task-admission"

test("extracts only explicit spawn constraints, including false", () => {
  const task = { worktree: false, report_mode: "final_response", complexity: 66 }
  expect(taskSpawnOptions(task)).toEqual({ worktree: false, report_mode: "final_response" })
  expect(taskSpawnOptions({})).toEqual({})
})

test.each([{ worktree: null }, { worktree: "false" }, { report_mode: null }, { report_mode: "other" }])("rejects malformed spawn constraints: %j", value => {
  expect(() => taskSpawnOptions(value)).toThrow()
})
