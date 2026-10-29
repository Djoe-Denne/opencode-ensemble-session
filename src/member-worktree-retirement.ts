import type { ToolDeps } from "./types"
import { worktreeSlug } from "./worktree-guard"

/** Retire a persisted member checkout using verified native retirement when supported. */
export async function retireMemberWorktree(deps: ToolDeps, teamId: string, memberName: string, member: {
  worktree_dir: string | null; checkout_branch: string | null; preserved_branch: string | null; worktree_branch: string | null
}): Promise<void> {
  if (!member.worktree_dir) return
  if (!deps.client.worktree.retire) {
    await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } })
    return
  }
  const team = deps.db.query("SELECT project_id FROM team WHERE id = ?").get(teamId) as { project_id: string } | null
  if (!team) throw new Error("Cannot verify member project ownership for retirement")
  await deps.client.worktree.retire({ directory: member.worktree_dir, canonicalDirectory: deps.directory,
    expectedName: worktreeSlug(team.project_id, teamId, memberName),
    checkoutBranch: member.checkout_branch ?? (member.worktree_branch?.startsWith("ensemble/preserved/") ? null : member.worktree_branch),
    preservedBranch: member.preserved_branch,
  })
}
