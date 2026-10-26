import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"

const refuse = () => { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "fixtures", "El registro privado de fixtures no pertenece a este censo, perfil y raíz, o atraviesa un enlace.") }

export function fixtureId(censusId, userId, kind, fixtureKey) {
  const hex = createHash("sha256").update(JSON.stringify([censusId, userId, kind, fixtureKey])).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function fixtureFile(resolved) {
  const root = resolved.stack.root
  const file = path.join(root, ".biblib", "fixtures", `${resolved.profile}.json`)
  for (const entry of [path.join(root, ".biblib"), path.dirname(file), file]) {
    if (existsSync(entry) && lstatSync(entry).isSymbolicLink()) refuse()
  }
  return file
}

// chmod no restringe una ACL de Windows. Se elimina la herencia antes de escribir secretos.
function restrict(file, directory = false) {
  if (process.platform !== "win32") { chmodSync(file, directory ? 0o700 : 0o600); return }
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username
  try {
    execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${account}:${directory ? "(OI)(CI)" : ""}F`, "*S-1-5-18:F"], { windowsHide: true, stdio: "pipe" })
  } catch { throw new BiblibError(EXIT.SEED_FAILED, "registro", "No se pudieron restringir los permisos del registro privado; no se escribieron credenciales.") }
}

export function readFixtureStore(resolved, census) {
  const file = fixtureFile(resolved)
  if (!existsSync(file)) return null
  restrict(path.dirname(file), true)
  restrict(file)
  let store
  try { store = JSON.parse(readFileSync(file, "utf8")) } catch { refuse() }
  if (store.schemaVersion !== 1 || store.fingerprint !== resolved.fingerprint || store.censusId !== census.censusId || store.censusVersion !== census.censusVersion) refuse()
  if (!store.accounts || Object.keys(store.accounts).some((key) => !census.accounts.some((a) => a.key === key))) refuse()
  for (const account of census.accounts) {
    const saved = store.accounts[account.key]
    if (saved && (saved.email !== account.email || typeof saved.password !== "string" || saved.password.length < 32 || (saved.id && !/^[0-9a-f-]{36}$/i.test(saved.id)))) refuse()
  }
  return store
}

export function writeFixtureStore(resolved, store) {
  const file = fixtureFile(resolved)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  restrict(path.dirname(file), true)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, "", { mode: 0o600, flag: "wx" })
    restrict(temporary)
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
  return file
}
