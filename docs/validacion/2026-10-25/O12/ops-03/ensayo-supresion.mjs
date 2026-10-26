// U-OPS-03 · Ensayo G12 «un backup restaurado no resucita la cuenta suprimida» sobre el perfil scratch.
// node docs/validacion/2026-10-25/O12/ops-03/ensayo-supresion.mjs cargar|solicitar|comprobar|retirar
//   cargar     crea la cuenta desechable C (ops03-ensayo-…@biblib.test) con su biblioteca y portadas privadas.
//   solicitar  pide la eliminación de C con sus propios claims (la Server Action la cubre el grupo account).
//   comprobar  imprime los restos de C (filas, objetos, identidad) y el estado de su marca, sin datos de biblioteca.
//   retirar    borra el registro privado del ensayo (la cuenta ya no existe tras la supresión).
// El registro privado (.biblib/ensayo-ops03.json, fuera de Git) guarda el ID y la contraseña aleatoria de C.
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { REPO_ROOT } from "../../../../../scripts/lib/profiles.mjs"

process.env.BIBLIB_PROFILE = "scratch"
process.env.BIBLIB_ACCOUNT_RUN_ID ||= randomBytes(6).toString("hex")
const { accountContext } = await import("../../../../../tests/integration/account/lib/context.mjs")
const file = path.join(REPO_ROOT, ".biblib", "ensayo-ops03.json")
const command = process.argv[2]
const ctx = await accountContext()
try {
  if (command === "cargar") {
    const c = await ctx.account("ensayo")
    const library = await ctx.library(c.id)
    writeFileSync(file, JSON.stringify({ ...c, keys: library.keys.length }), { mode: 0o600 })
    console.log(JSON.stringify({ cuenta: "C", restos: await ctx.residue(c.id), objetos: (await ctx.objects(c.id)).length }))
  } else {
    if (!existsSync(file)) throw new Error("Falta el registro del ensayo; ejecuta antes «cargar».")
    const c = JSON.parse(readFileSync(file, "utf8"))
    if (command === "solicitar") {
      const [{ r }] = await ctx.asUser(c.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("ensayo")}) as r`)
      console.log(JSON.stringify({ cuenta: "C", estado: r.state, paso: r.step, creada: r.created }))
    } else if (command === "comprobar") {
      const mark = await ctx.deletion(c.id)
      console.log(JSON.stringify({ cuenta: "C", restos: await ctx.residue(c.id), identidad: Boolean(await ctx.identity(c.id)), marca: mark ? { estado: mark.state, paso: mark.step, plazoDias: mark.purge_after ? Math.round((mark.purge_after - Date.now()) / 86_400_000) : null } : null }))
    } else if (command === "retirar") {
      rmSync(file, { force: true })
      console.log("Registro del ensayo retirado.")
    } else throw new Error("Uso: ensayo-supresion.mjs cargar|solicitar|comprobar|retirar")
  }
} finally {
  await ctx.close()
}
