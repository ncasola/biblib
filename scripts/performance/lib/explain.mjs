import { summarize } from "./stats.mjs"

// EXPLAIN (ANALYZE, BUFFERS) de las consultas principales, ejecutado como el rol `authenticated` con los
// claims de la cuenta de escala (RLS real). Cada medición va en una transacción que se revierte. Los UUID
// de la cuenta se sustituyen en el texto guardado: el informe no contiene identificadores.

const RUNS = 30
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ROLLBACK = Symbol("rollback")

export function redactPlan(text) {
  return text.replace(UUID, "<uuid>")
}

export async function asUser(tx, userId) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" })
  await tx.unsafe(`/* perf */ select set_config('request.jwt.claims', '${claims}', true)`)
  await tx.unsafe(`/* perf */ select set_config('request.jwt.claim.sub', '${userId}', true)`)
  await tx.unsafe("/* perf */ set local role authenticated")
}

/** Ejecuta `work(tx)` en una transacción y la revierte siempre; devuelve lo que `work` devuelva. */
export async function inRolledBackTransaction(sql, work) {
  let result
  try {
    await sql.begin(async (tx) => { result = await work(tx); throw ROLLBACK })
  } catch (error) { if (error !== ROLLBACK) throw error }
  return result
}

function collectNodes(plan, found = new Set()) {
  found.add(plan["Node Type"] + (plan["Index Name"] ? ` (${plan["Index Name"]})` : ""))
  for (const child of plan.Plans ?? []) collectNodes(child, found)
  return found
}

/** Texto completo de un EXPLAIN (ANALYZE, BUFFERS) dentro de la transacción `tx` (ya con el rol aplicado). */
export async function explainTextIn(tx, query) {
  const rows = await tx.unsafe(`/* perf */ explain (analyze, buffers, settings on) ${query.sql}`)
  return redactPlan(rows.map((row) => row["QUERY PLAN"]).join("\n"))
}

/** `runs` ejecuciones con EXPLAIN ANALYZE sin temporización por nodo: tiempo de ejecución y de planificación. */
export async function timeQueryIn(tx, query, { runs = RUNS, warmup = 3 } = {}) {
  const executionMs = []
  const planningMs = []
  let nodeTypes = new Set()
  let jit = false
  for (let i = 0; i < warmup + runs; i++) {
    const rows = await tx.unsafe(`/* perf */ explain (analyze, timing off, summary on, format json) ${query.sql}`)
    const root = rows[0]["QUERY PLAN"][0]
    if (i >= warmup) { executionMs.push(root["Execution Time"]); planningMs.push(root["Planning Time"]) }
    if (i === warmup) { nodeTypes = collectNodes(root.Plan); jit = Boolean(root.JIT) }
  }
  return { id: query.id, ejecucionMs: summarize(executionMs, 3), planificacionMs: summarize(planningMs, 3), nodos: [...nodeTypes], jit }
}

/** Mide todas las consultas y guarda el texto de EXPLAIN de cada una. */
export async function explainAll(sql, userId, queries, options) {
  return inRolledBackTransaction(sql, async (tx) => {
    await asUser(tx, userId)
    const out = []
    for (const query of queries) out.push({ ...(await timeQueryIn(tx, query, options)), accion: query.accion, pantalla: query.pantalla, limite: query.limite, texto: await explainTextIn(tx, query) })
    return out
  })
}
