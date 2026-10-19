import type { Database } from "./db"

const PRESERVED_PREFIX = "ensemble/preserved/"

/** True when a ref is the safety copy, not the live checkout branch. */
export function isPreservedRef(branch: string | null | undefined): boolean {
  return typeof branch === "string" && branch.startsWith(PRESERVED_PREFIX)
}

/**
 * Branch that may still be deleted with the worktree.
 * An already preserved name is not copied again.
 */
export function liveCheckoutBranch(row: { checkout_branch?: string | null; worktree_branch: string | null }): string | null {
  if (row.checkout_branch && !isPreservedRef(row.checkout_branch)) return row.checkout_branch
  if (row.worktree_branch && !isPreservedRef(row.worktree_branch)) return row.worktree_branch
  return null
}

/**
 * Record a safety ref without replacing the live checkout name.
 * `worktree_branch` stays the checkout branch. Merge and cleanup read `preserved_branch`.
 */
export function storePreservedBranch(db: Database, teamId: string, memberName: string, source: string, preserved: string): void {
  db.run(
    `UPDATE team_member
     SET checkout_branch = CASE
           WHEN checkout_branch IS NOT NULL AND checkout_branch NOT LIKE 'ensemble/preserved/%' THEN checkout_branch
           WHEN ? NOT LIKE 'ensemble/preserved/%' THEN ?
           ELSE checkout_branch
         END,
         preserved_branch = ?,
         worktree_state = 'preserved'
     WHERE team_id = ? AND name = ?`,
    [source, source, preserved, teamId, memberName],
  )
}

/** Branch merge and cleanup should apply. The safety ref wins when it exists. */
export function branchToMerge(row: { preserved_branch?: string | null; worktree_branch: string | null }): string | null {
  if (row.preserved_branch) return row.preserved_branch
  return row.worktree_branch
}
