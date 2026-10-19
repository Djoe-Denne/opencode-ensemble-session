import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty, countBranchCommits } from "./shared"
import type { IsDirtyFn, CommitCountFn } from "./shared"
import { mergeBranch, deleteBranch, getOverlappingFiles, preserveBranch } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, OverlapCheckFn, PreserveBranchFn } from "./merge-helper"
import { log } from "../log"
import { branchToMerge, liveCheckoutBranch } from "../worktree-state"

/**
 * Execute the team_merge tool. Merges a shutdown teammate's preserved
 * branch into the working directory as unstaged changes.
 */
export async function executeTeamMerge(
  deps: ToolDeps,
  args: { member: string },
  sessionId: string,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  overlapCheck: OverlapCheckFn = getOverlappingFiles,
  commitCount: CommitCountFn = countBranchCommits,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = deps.preserveBranch ?? preserveBranch,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT status, worktree_branch, checkout_branch, preserved_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { status: string; worktree_branch: string | null; checkout_branch: string | null; preserved_branch: string | null; worktree_dir: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  if (member.status !== "shutdown" && member.status !== "error") {
    throw new Error(`Teammate "${args.member}" is still active (status: ${member.status}). Shut them down first with team_shutdown.`)
  }

  const branch = branchToMerge(member)
  if (!branch) {
    throw new Error(`No branch to merge for "${args.member}". They may not have a worktree, or their work was already merged.`)
  }
  const source = liveCheckoutBranch(member)
  if (member.preserved_branch && source && !(await preserve(source, member.preserved_branch, deps.directory))) {
    return `Cannot merge ${args.member}: could not refresh preserved ref ${member.preserved_branch} from ${source}. The checkout branch was left in place.`
  }
  log(`merge:start member=${args.member} branch=${branch}`)

  // A branch with zero new commits produces a trivially "successful" no-op squash merge --
  // there is genuinely nothing to apply. Reporting that as "Merged ... changes" is
  // misleading: if the teammate's worktree still has uncommitted work, that work was never
  // captured on the branch at all and is about to be permanently lost the moment the
  // worktree is removed (e.g. by team_cleanup). Say so plainly instead of a false success,
  // and don't tear down the branch/worktree while it may be the only copy of the work.
  // A commit-count check failure returns -1 (unknown) -- never treat that as "nothing to
  // merge"; fall through to the real merge attempt so a check failure can't silently skip
  // real work.
  const commits = await commitCount(branch, deps.directory)
  if (commits === 0) {
    const dirty = member.worktree_dir ? await isDirty(member.worktree_dir).catch(() => false) : false
    if (dirty) {
      return [
        `Nothing to merge for "${args.member}" — their branch (${branch}) has no commits.`,
        `Their worktree still has uncommitted changes that were never captured on the branch.`,
        `This work will be permanently lost if the worktree is removed (e.g. via team_cleanup).`,
        member.worktree_dir ? `Worktree: ${member.worktree_dir}` : ``,
        `Recover manually (copy files out of the worktree) before shutting down/cleaning up, or re-spawn and instruct them to commit their changes before reporting done.`,
      ].filter(Boolean).join("\n")
    }
    return `Nothing to merge for "${args.member}" — their branch (${branch}) has no commits and no uncommitted changes. They made no changes.`
  }

  // Block merge if lead has local changes to files the agent also modified
  try {
    const overlap = await overlapCheck(branch, deps.directory)
    if (overlap.length > 0) {
      const files = overlap.map(f => `  - ${f}`).join("\n")
      return [
        `Cannot merge ${args.member} — you have local changes to the same files:`,
        files,
        ``,
        `Commit or stash your changes first, then retry team_merge.`,
        `Branch preserved: ${branch}`,
      ].join("\n")
    }
  } catch {
    log(`merge:overlap-check:failed member=${args.member} branch=${branch}`)
  }

  const result = await merge(branch, deps.directory)
  if (!result.ok) {
    return [
      `Merge conflict merging ${args.member}'s branch (${branch}).`,
      `Resolve manually:`,
      `  git merge --squash ${branch}`,
      `  git reset HEAD`,
      ``,
      `Error: ${result.error}`,
    ].join("\n")
  }

  // Merge succeeded — delete the preserved branch and clear DB
  await delBranch(branch, deps.directory)
  deps.db.run(
    "UPDATE team_member SET worktree_branch = NULL, preserved_branch = NULL, checkout_branch = NULL, worktree_state = 'released' WHERE team_id = ? AND name = ?",
    [teamInfo.teamId, args.member],
  )

  log(`merge:done member=${args.member} branch=${branch}`)
  return `Merged ${args.member}'s changes into your working directory (unstaged). Review with: git diff`
}
