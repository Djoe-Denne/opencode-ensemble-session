import { MEMBER_TOOLS } from "./v2-continuity"

/** One observed permission rule. The last matching rule wins. */
export interface PermissionRuleView {
  action: string
  resource: string
  effect: string
  index: number
}

/** A profile lint finding. Warnings do not fail the script; errors do. */
export interface ProfileFinding {
  id:
    | "missing-ensemble-tools"
    | "relative-glob"
    | "allow-shadowed-by-deny"
    | "coded-model"
    | "model-order-conflict"
    | "execute-body-conflict"
    | "listing-gap"
    | "restrictive-profile"
    | "env-case-duplication"
    | "unparseable"
    | "builtin-unverified"
  severity: "error" | "warning" | "info"
  message: string
}

/** Frontmatter fields the linter understands. Malformed frontmatter is reported, not thrown. */
export interface ParsedAgentProfile {
  body: string
  model?: string
  mode?: string
  rules: PermissionRuleView[]
  unparseable: boolean
}

const MODEL_ID = /[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*/u

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseInline(line: string): { action: string; resource: string; effect: string } | undefined {
  const body = line.match(/^\s*-\s*\{([^}]*)\}\s*$/u)?.[1]
  if (!body) return undefined
  const fields = Object.fromEntries([...body.matchAll(/(\w+)\s*:\s*("[^"]*"|'[^']*'|[^,]+)/gu)].map(match => [match[1] ?? "", unquote(match[2] ?? "")]))
  if (!fields.action || !fields.resource || !fields.effect) return undefined
  return { action: fields.action, resource: fields.resource, effect: fields.effect }
}

function permissionSection(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/u)
  const start = lines.findIndex(line => /^permissions\s*:/u.test(line))
  if (start < 0) return []
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line) && line.includes(":")) break
    section.push(line)
  }
  return section
}

function parseRules(frontmatter: string): PermissionRuleView[] {
  const rules: PermissionRuleView[] = []
  let pending: { action?: string; resource?: string; effect?: string } | undefined
  const flush = (): void => {
    if (!pending?.action || !pending.resource || !pending.effect) {
      pending = undefined
      return
    }
    rules.push({ action: pending.action, resource: pending.resource, effect: pending.effect, index: rules.length })
    pending = undefined
  }
  for (const line of permissionSection(frontmatter)) {
    const inline = parseInline(line)
    if (inline) {
      flush()
      rules.push({ ...inline, index: rules.length })
      continue
    }
    const opened = line.match(/^\s*-\s*action\s*:\s*(.+)\s*$/u)
    if (opened?.[1]) {
      flush()
      pending = { action: unquote(opened[1]) }
      continue
    }
    const resource = line.match(/^\s+resource\s*:\s*(.+)\s*$/u)
    if (resource?.[1] && pending) pending.resource = unquote(resource[1])
    const effect = line.match(/^\s+effect\s*:\s*(.+)\s*$/u)
    if (effect?.[1] && pending) pending.effect = unquote(effect[1])
  }
  flush()
  return rules
}

function topLevel(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.+)\\s*$`, "mu"))
  return match?.[1] ? unquote(match[1]) : undefined
}

/** Parse agent markdown. A frontmatter block without a closing fence is unparseable and does not throw. */
export function parseAgentMarkdown(text: string): ParsedAgentProfile {
  const source = text.replace(/^\uFEFF/u, "")
  if (!source.startsWith("---")) return { body: source, rules: [], unparseable: false }
  const end = source.indexOf("\n---", 3)
  if (end < 0) return { body: "", rules: [], unparseable: true }
  const frontmatter = source.slice(3, end)
  return {
    body: source.slice(end + 4).replace(/^\r?\n/u, ""),
    model: topLevel(frontmatter, "model"),
    mode: topLevel(frontmatter, "mode"),
    rules: parseRules(frontmatter),
    unparseable: false,
  }
}

function effective(rules: readonly PermissionRuleView[], action: string, resource = "*"): string | undefined {
  return rules.reduce<string | undefined>((current, rule) => {
    const actionMatches = rule.action === "*" || rule.action === action
    const resourceMatches = rule.resource === "*" || rule.resource === resource
    return actionMatches && resourceMatches ? rule.effect : current
  }, undefined)
}

function anchored(resource: string): boolean {
  return resource === "*" || resource.startsWith("/") || resource.startsWith("~") || resource.startsWith("*") || /^[A-Za-z]:/u.test(resource)
}

function modelIdentity(value: string): string {
  return value.split("#")[0] ?? value
}

function forbidsExecute(body: string): boolean {
  return /même via\s+code mode/iu.test(body)
    || /(?:interdit|forbidden|do not use|ne pas utiliser|n['’]utilise pas).{0,80}(?:code mode|execute)/iu.test(body)
}

function envDenies(rules: readonly PermissionRuleView[]): string[] {
  return rules.filter(rule => rule.effect === "deny" && /\.env\b/iu.test(rule.resource)).map(rule => rule.resource)
}

/**
 * Lint one agent profile. Findings are stable ids from the teammate-profile contract.
 * Restrictive profiles are detected from the body marker and are not rewritten.
 */
export function lintAgentProfile(text: string): ProfileFinding[] {
  const parsed = parseAgentMarkdown(text)
  if (parsed.unparseable) return [{ id: "unparseable", severity: "error", message: "Agent frontmatter has no closing fence" }]
  const restrictive = parsed.body.includes("ensemble-report: final_response")
  const findings: ProfileFinding[] = []
  if (restrictive) findings.push({ id: "restrictive-profile", severity: "info", message: "final_response marker: Ensemble tools are not required" })
  if (!restrictive) {
    const missing = ["execute", ...MEMBER_TOOLS].filter(action => effective(parsed.rules, action) !== "allow")
    if (missing.length > 0) {
      findings.push({ id: "missing-ensemble-tools", severity: "warning", message: `Effective permission is not allow for ${missing.join(", ")}` })
    }
  }
  parsed.rules.forEach(rule => {
    if (rule.effect !== "allow" || anchored(rule.resource)) return
    if (rule.action === "edit") findings.push({ id: "relative-glob", severity: "error", message: `edit allow ${rule.resource} is a relative glob; use a **/ prefix` })
    if (rule.action === "read") findings.push({ id: "relative-glob", severity: "warning", message: `read allow ${rule.resource} is a relative glob` })
  })
  parsed.rules.forEach(rule => {
    if (rule.effect !== "allow") return
    const shadowed = parsed.rules.slice(rule.index + 1).some(later => later.action === rule.action && later.resource === "*" && later.effect === "deny")
    if (shadowed) findings.push({ id: "allow-shadowed-by-deny", severity: "warning", message: `allow ${rule.action} ${rule.resource} is followed by deny ${rule.action} *` })
  })
  if (parsed.model) {
    findings.push({ id: "coded-model", severity: "warning", message: `model ${parsed.model} is not binding for a mission teammate` })
    const bodyModel = parsed.body.match(MODEL_ID)?.[0]?.replace(/\.+$/u, "")
    if (bodyModel && bodyModel !== modelIdentity(parsed.model)) {
      findings.push({ id: "model-order-conflict", severity: "warning", message: `body model ${bodyModel} differs from frontmatter ${modelIdentity(parsed.model)}` })
    }
  }
  if (effective(parsed.rules, "execute") === "allow" && forbidsExecute(parsed.body)) {
    findings.push({ id: "execute-body-conflict", severity: "warning", message: "Frontmatter allows execute while the body forbids Code Mode or execute" })
  }
  const readDirectory = parsed.rules.some(rule => rule.action === "read" && rule.effect === "allow" && rule.resource.includes("/*"))
  if (readDirectory && effective(parsed.rules, "glob") !== "allow") {
    findings.push({ id: "listing-gap", severity: "warning", message: "read allow on a directory glob has no glob allow" })
  }
  const env = envDenies(parsed.rules)
  const folded = new Map<string, string[]>()
  env.forEach(resource => {
    const key = resource.toLowerCase()
    folded.set(key, [...(folded.get(key) ?? []), resource])
  })
  if ([...folded.values()].some(group => new Set(group).size > 1)) {
    findings.push({ id: "env-case-duplication", severity: "info", message: "Several .env denies differ only by case" })
  }
  return findings
}

/** Info finding for a built-in agent that has no project file. Not an error. */
export function builtinUnverified(name: string): ProfileFinding {
  return { id: "builtin-unverified", severity: "info", message: `${name} has no project agent file` }
}
