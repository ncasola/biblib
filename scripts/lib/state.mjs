import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "./exit-codes.mjs"

function statePath(ctx, suffix = "") {
  const dir = path.join(ctx.root, ".biblib", "state")
  for (const candidate of [path.join(ctx.root, ".biblib"), dir]) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "estado", "El directorio de estado no puede ser un enlace a otra raíz.")
  }
  const file = path.join(dir, `${ctx.profile.name}${suffix}.json`)
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "estado", "El registro de estado no puede ser un enlace.")
  return file
}

export function readState(ctx, suffix = "") {
  const file = statePath(ctx, suffix)
  if (!existsSync(file)) return null
  try {
    const state = JSON.parse(readFileSync(file, "utf8"))
    if (state.schemaVersion !== 1 || state.rootHash !== ctx.identity.hash || state.profile !== ctx.profile.name || state.projectId !== ctx.profile.projectId || state.fingerprint !== ctx.fingerprint) throw new Error()
    if (!suffix && (!Array.isArray(state.resources?.containers) || !Array.isArray(state.resources?.volumes))) throw new Error()
    return state
  } catch { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "estado", "Registro ausente de identidad válida o dañado; no se adoptan recursos automáticamente.") }
}

export function writeState(ctx, data, suffix = "") {
  const file = statePath(ctx, suffix)
  mkdirSync(path.dirname(file), { recursive: true })
  const state = { ...data, schemaVersion: 1, target: "local", profile: ctx.profile.name, projectId: ctx.profile.projectId, root: ctx.identity.root, rootHash: ctx.identity.hash, fingerprint: ctx.fingerprint, updatedAt: new Date().toISOString() }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  return state
}

export function acquireLock(ctx) {
  const file = statePath(ctx, "-lock")
  mkdirSync(path.dirname(file), { recursive: true })
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, rootHash: ctx.identity.hash }), { flag: "wx", mode: 0o600 }) }
  catch { throw new BiblibError(EXIT.LOCK_BUSY, "preflight", "Otro lifecycle ocupa el bloqueo del perfil; comprueba su proceso antes de recuperar un bloqueo residual.") }
  return () => rmSync(file, { force: true })
}
