import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { builtinUnverified, lintAgentProfile, type ProfileFinding } from "../src/profile-lint"

const directory = process.argv[2]
if (!directory) {
  console.error("usage: bun scripts/lint-agent-profiles.ts <dir>")
  process.exit(1)
}

const files = readdirSync(directory).filter(name => name.endsWith(".md")).toSorted()
const report: Array<{ file: string; findings: ProfileFinding[] }> = files.map(file => ({
  file,
  findings: lintAgentProfile(readFileSync(join(directory, file), "utf8")),
}))
for (const name of ["build", "plan", "explore"]) {
  if (!files.includes(`${name}.md`)) report.push({ file: name, findings: [builtinUnverified(name)] })
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.some(entry => entry.findings.some(finding => finding.severity === "error")) ? 1 : 0)
