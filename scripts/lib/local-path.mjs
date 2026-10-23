import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "./exit-codes.mjs"

const refuse = () => { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "ruta", "La ruta debe permanecer dentro de .biblib de esta raíz, sin enlaces ni junctions.") }
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) }

/** Acredita cada componente existente, incluidos enlaces rotos y junctions Windows. */
export function localPath(root, file) {
  const realRoot = realpathSync.native(root)
  const base = path.join(realRoot, ".biblib")
  const absolute = path.resolve(realRoot, file)
  if (!inside(base, absolute)) refuse()
  let current = realRoot
  for (const part of path.relative(realRoot, absolute).split(path.sep)) {
    current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code === "ENOENT") continue; throw error }
    if (stat.isSymbolicLink() || realpathSync.native(current) !== current) refuse()
  }
  return absolute
}

/** No sigue enlaces siquiera dentro del árbol que se va a eliminar. Sin shells. */
export function removeLocalPath(root, file) {
  const absolute = localPath(root, file)
  const check = (entry) => {
    localPath(root, entry)
    if (lstatSync(entry).isDirectory()) for (const name of readdirSync(entry)) check(path.join(entry, name))
  }
  if (existsSync(absolute)) { check(absolute); rmSync(absolute, { recursive: true, force: true }) }
}
