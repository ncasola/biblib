// Contrato de salida de `perf:local --json` (fijado por el coordinador para U-QA-04):
//   { schemaVersion, profile, scale, results: [{ scenario, p50, p95, budget, status }] }
// `status` es «ok», «over-budget» (presupuesto propuesto incumplido: se informa, no falla el comando) o
// «no-budget» (medida sin presupuesto propuesto). Las unidades van en `unit` (ms o puntuación de CLS).

export const BUDGETS = Object.freeze({ actionP95Ms: 1000, sqlP95Ms: 500, lcpMs: 2500, inpMs: 200, cls: 0.1 })

/** Acciones de lectura de navegación ordinaria a las que se aplica el presupuesto de acción de listado. */
const NAVIGATION = new Set(["dashboard", "listado-inicial", "listado-100-filas", "listado-ultima-pagina", "filtrado-estado-estanteria", "ordenado-autor", "ordenado-fecha", "busqueda-local-texto", "busqueda-local-isbn", "detalle", "estanterias", "estanteria-3d-pagina-48"])
/** Acciones que consultan la base con LIMIT y a las que se aplica el presupuesto de SQL. */
const SQL_BUDGETED = new Set(["dashboard", "listado-inicial", "listado-100-filas", "listado-ultima-pagina", "filtrado-estado-estanteria", "ordenado-autor", "ordenado-fecha", "busqueda-local-texto", "busqueda-local-isbn", "estanteria-3d-pagina-48"])

const status = (p95, budget) => budget === null ? "no-budget" : p95 <= budget ? "ok" : "over-budget"
const entry = (scenario, p50, p95, budget, unit = "ms", extra = {}) => ({ scenario, p50, p95, budget, status: status(p95, budget), unit, ...extra })

/** Entradas del contrato de un tamaño medido. */
export function contractResults(result) {
  const out = []
  for (const pass of result.acciones ?? []) {
    if (!pass.accionMs.n) continue
    const name = pass.concurrencia === 1 ? pass.escenario : `${pass.escenario}@${pass.concurrencia}`
    out.push(entry(name, pass.accionMs.p50, pass.accionMs.p95, NAVIGATION.has(pass.escenario) ? BUDGETS.actionP95Ms : null, "ms", { concurrency: pass.concurrencia }))
    if (pass.sqlMs?.n) out.push(entry(`sql:${pass.escenario}`, pass.sqlMs.p50, pass.sqlMs.p95, SQL_BUDGETED.has(pass.escenario) ? BUDGETS.sqlP95Ms : null, "ms", { concurrency: 1 }))
  }
  for (const [profileKey, web] of Object.entries(result.web ?? {})) {
    for (const [screen, m] of Object.entries(web.pantallas)) {
      const lcp = Math.max(m.frio.lcpMs ?? 0, m.caliente.lcpMs ?? 0)
      const cls = Math.max(m.frio.cls ?? 0, m.caliente.cls ?? 0, m.interaccion.clsConGestos ?? 0)
      const inp = m.interaccion.inpPeorMs ?? 0
      out.push(entry(`web:${profileKey}:${screen}:lcp`, m.caliente.lcpMs, lcp, BUDGETS.lcpMs))
      out.push(entry(`web:${profileKey}:${screen}:inp`, m.interaccion.inpMs, inp, BUDGETS.inpMs))
      out.push(entry(`web:${profileKey}:${screen}:cls`, Math.round(Math.min(m.frio.cls ?? 0, m.caliente.cls ?? 0) * 1000) / 1000, Math.round(cls * 1000) / 1000, BUDGETS.cls, "score"))
    }
  }
  return out
}
