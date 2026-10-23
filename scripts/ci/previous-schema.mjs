import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { inspectJournal } from "../db/journal-guard.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"

// Valida bytes antes del checkout: nunca regenera ni recorta un journal para simular un upgrade.
const previous = process.argv[2]
function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error("No se pudo leer la versión anterior fijada.")
  return result.stdout
}
try {
  if (!/^[0-9a-f]{40}$/.test(previous ?? "")) throw new Error("Falta un SHA completo: configura BIBLIB_PREVIOUS_SCHEMA_COMMIT o el input manual.")
  git(["merge-base", "--is-ancestor", previous, "HEAD"])
  const old = JSON.parse(git(["show", `${previous}:drizzle/meta/_journal.json`]))
  const current = inspectJournal()
  if (current.problems.length || !Array.isArray(old.entries) || !old.entries.length || old.entries.length >= current.entries.length) throw new Error("La versión anterior debe tener un prefijo estricto del historial actual.")
  for (const [index, entry] of old.entries.entries()) {
    const next = current.entries[index]
    if (entry.tag !== next.tag || entry.when !== next.when || entry.idx !== index || git(["show", `${previous}:drizzle/${entry.tag}.sql`]) !== readFileSync(next.file, "utf8")) throw new Error("Una migración aplicada fue alterada entre versiones.")
  }
  console.log(`Upgrade fijado: ${old.entries.at(-1).tag} → ${current.entries.at(-1).tag}.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 5
}
