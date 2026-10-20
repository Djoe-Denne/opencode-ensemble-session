import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = "C:/Users/djden/source/repos/ARTIST/.opencode/agents"
const MARKER = "ensemble-report: final_response"
const BLOCK = [
  "",
  "<!-- ensemble-report: final_response -->",
  "",
  "Rapport d'équipe : profil restrictif sans `execute` ni outils d'équipe. Le lead",
  "le spawn avec `report_mode: \"final_response\"` et relève la réponse finale avec",
  "`team_results` ; il ne lui ouvre ni `team_*` ni `execute` pour l'envoi.",
  "",
].join("\n")

for (const file of readdirSync(dir).filter(name => name.endsWith(".md")).toSorted()) {
  const path = join(dir, file)
  const content = readFileSync(path, "utf8")
  if (content.includes(MARKER)) { console.log(`skip ${file} (already marked)`); continue }
  writeFileSync(path, content.replace(/\n*$/u, "\n") + BLOCK)
  console.log(`marked ${file}`)
}
