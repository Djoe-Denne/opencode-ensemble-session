/** Explicit task constraints applied by both manual spawn and auto-scale. */
export interface TaskSpawnOptions {
  worktree?: boolean
  report_mode?: "team_message" | "final_response"
}

/** Validate and extract explicit task spawn constraints without inventing defaults. */
export function taskSpawnOptions(value: { worktree?: unknown; report_mode?: unknown }): TaskSpawnOptions {
  if (value.worktree !== undefined && typeof value.worktree !== "boolean") throw new Error("worktree must be a boolean")
  if (value.report_mode !== undefined && value.report_mode !== "team_message" && value.report_mode !== "final_response") throw new Error("report_mode must be team_message or final_response")
  return { ...(value.worktree !== undefined ? { worktree: value.worktree } : {}), ...(value.report_mode !== undefined ? { report_mode: value.report_mode } : {}) }
}
