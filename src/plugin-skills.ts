import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/** One skill the plugin ships and self-registers on a capable V2 host. */
export interface SkillDefinition {
  id: string
  name: string
  description: string
  path: string
  content: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function topLevel(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.+)\\s*$`, "mu"))
  return match?.[1] ? unquote(match[1]) : undefined
}

/**
 * Locate the plugin's own skills directory. The sentinel skill pins the layout
 * so a stray `skills` folder is never mistaken for the plugin payload.
 * Accepts the package root or a directory inside it.
 */
export function resolvePluginSkillsDir(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 2; depth++) {
    if (existsSync(join(current, "skills", "ensemble-project-setup", "SKILL.md"))) return join(current, "skills")
    current = dirname(current)
  }
  return undefined
}

/** The skills directory of the running package, or undefined off the plugin root. */
export function bundledSkillsDir(): string | undefined {
  try {
    return resolvePluginSkillsDir(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}

/** Read one `SKILL.md` per subdirectory, with its frontmatter identity. */
export function readSkillDefinitions(skillsDir: string): SkillDefinition[] {
  return readdirSync(skillsDir).filter(name => !name.startsWith(".")).toSorted().flatMap(directory => {
    const path = join(skillsDir, directory, "SKILL.md")
    if (!existsSync(path)) return []
    const content = readFileSync(path, "utf8")
    const end = content.indexOf("\n---", 3)
    const frontmatter = content.startsWith("---") && end > 0 ? content.slice(4, end) : ""
    return [{
      id: directory,
      name: topLevel(frontmatter, "name") ?? directory,
      description: topLevel(frontmatter, "description") ?? "",
      path,
      content,
    }]
  })
}

/**
 * Register the plugin's own skills through the host transform so the shipped
 * guidance can never drift from the running revision. Returns false when the
 * host has no skill transform or nothing is readable — never throws for it.
 */
export async function registerPluginSkills(
  ctx: { skill?: { transform(callback: (editor: { add(definition: SkillDefinition): void }) => unknown): Promise<unknown> } },
  skillsDir?: string,
): Promise<boolean> {
  if (!ctx.skill || !skillsDir) return false
  let definitions: SkillDefinition[]
  try {
    definitions = readSkillDefinitions(skillsDir)
  } catch {
    return false
  }
  if (definitions.length === 0) return false
  await ctx.skill.transform(editor => { definitions.forEach(definition => editor.add(definition)) })
  return true
}
