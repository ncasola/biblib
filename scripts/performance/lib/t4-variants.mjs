import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Variantes del experimento T4 de U-FIX-02. Cada una cambia UNA sola cosa respecto al código medido
// (`base`) y solo existe durante el build de esa variante: el runner reescribe los archivos, compila y
// restaura el original antes de arrancar la app. Ninguna variante se integra en el producto; las que
// quitan verificaciones de sesión son diagnósticas y solo se compilan en el perfil de medición.
//
// Cada transformación declara su ancla exacta: si el código cambió y el ancla ya no está, la variante
// falla antes de compilar (no se mide algo distinto de lo que dice el informe).

const POOL = /max: \d+,/
const ACTION_GET_USER = "const { data: { user }, error } = await supabase.auth.getUser()"
const SESSION_ONLY = "const { data: { session }, error } = await supabase.auth.getSession()\n      const user = session?.user ?? null"
const PROXY_GET_USER = "const { data: { user }, error } = await supabase.auth.getUser()"
const PROXY_SESSION_ONLY = "const { data: { session }, error } = await supabase.auth.getSession()\n    const user = session?.user ?? null"
const RLS_SETUP = [
  "    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`)",
  "    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`)",
  "    await tx.execute(sql`set local role authenticated`)",
].join("\n")
const RLS_SETUP_ONE = "    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${userId}, true), set_config('role', 'authenticated', true)`)"
const SUMMARY_ENSURE = "export async function getLibrarySummaryAction() {\n  const userId = await getRequiredUserId()\n  return withRlsContext(userId, async (tx) => {\n    await ensureDefaultShelf(tx, userId)\n"
const SUMMARY_NO_ENSURE = "export async function getLibrarySummaryAction() {\n  const userId = await getRequiredUserId()\n  return withRlsContext(userId, async (tx) => {\n"
const SUMMARY_SHELVES = "    const [shelfTotals] = await tx.select({ totalShelves: count() }).from(shelves).where(eq(shelves.userId, userId))\n"
const SUMMARY_TOTALS = "      unread: sql<number>`count(*) filter (where ${books.status} = 'unread')::int`,\n    }).from(books).where(eq(books.userId, userId))\n"
const SUMMARY_TOTALS_MERGED = "      unread: sql<number>`count(*) filter (where ${books.status} = 'unread')::int`,\n      totalShelves: sql<number>`(select count(*)::int from biblib.shelves s where s.user_id = ${userId})`,\n    }).from(books).where(eq(books.userId, userId))\n    const shelfTotals = { totalShelves: totals.totalShelves }\n"

// Con core.autocrlf la copia de trabajo puede tener CRLF: anclas y reemplazos usan el fin de línea del archivo.
const replace = (anchor, replacement) => (source, file) => {
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const local = (text) => text.replace(/\r?\n/g, eol)
  const target = typeof anchor === "string" ? local(anchor) : anchor
  const found = typeof target === "string" ? source.includes(target) : target.test(source)
  if (!found) throw new Error(`La variante no encuentra su ancla en ${file}: el código cambió desde el experimento.`)
  return source.replace(target, () => local(replacement))
}

/** Variantes en el orden de ejecución por defecto. `files` mapea archivo → transformaciones. */
export const VARIANTS = Object.freeze({
  base: { factor: "ninguno (código medido)", files: {} },
  "pool-2": { factor: "pool de Postgres: 2 conexiones", files: { "lib/db/client.ts": [replace(POOL, "max: 2,")] } },
  "pool-4": { factor: "pool de Postgres: 4 conexiones", files: { "lib/db/client.ts": [replace(POOL, "max: 4,")] } },
  "sin-getuser-accion": {
    factor: "sin la 2.ª llamada a GoTrue (la acción lee la sesión de la cookie ya validada por el proxy; simula T3)",
    diagnostica: true,
    files: { "lib/server-user.ts": [replace(ACTION_GET_USER, SESSION_ONLY)] },
  },
  "idas-minimas": {
    factor: "menos idas y vueltas: preparación RLS en 1 sentencia (3 → 1) y resumen sin ensureDefaultShelf ni recuento aparte (−2)",
    files: {
      "lib/db/client.ts": [replace(RLS_SETUP, RLS_SETUP_ONE)],
      "app/actions/library.ts": [replace(SUMMARY_ENSURE, SUMMARY_NO_ENSURE), replace(SUMMARY_SHELVES, ""), replace(SUMMARY_TOTALS, SUMMARY_TOTALS_MERGED)],
    },
  },
  "sin-getuser": {
    factor: "sin ninguna llamada a GoTrue (proxy y acción leen la sesión de la cookie): solo Next + Postgres",
    diagnostica: true,
    files: { "lib/server-user.ts": [replace(ACTION_GET_USER, SESSION_ONLY)], "proxy.ts": [replace(PROXY_GET_USER, PROXY_SESSION_ONLY)] },
  },
})

export const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS))

/** Aplica la variante sobre `root` y devuelve una función que restaura exactamente el contenido original. */
export function applyVariant(root, name, { read = (file) => readFileSync(file, "utf8"), write = (file, text) => writeFileSync(file, text) } = {}) {
  const variant = VARIANTS[name]
  if (!variant) throw new Error(`Variante desconocida: ${name}.`)
  const originals = new Map()
  const restore = () => { for (const [file, text] of originals) write(file, text) }
  try {
    for (const [relative, transforms] of Object.entries(variant.files)) {
      const file = path.join(root, relative)
      const original = read(file)
      const changed = transforms.reduce((text, transform) => transform(text, relative), original)
      originals.set(file, original)
      write(file, changed)
    }
  } catch (error) {
    restore()
    throw error
  }
  return restore
}
