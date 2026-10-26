import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { contractResults } from "./contract.mjs"

// Tablas del informe de U-QA-03 generadas a partir de los resultados medidos. Solo cifras y nombres de
// escenario: ningún dato de fichas, sesión ni identificador. El análisis y las tareas van en informe.md.

const ms = (value) => value === null || value === undefined ? "—" : String(value)
const pair = (summary) => summary && summary.n ? `${ms(summary.p50)} / ${ms(summary.p95)}` : "—"
const row = (cells) => `| ${cells.join(" | ")} |`
const table = (header, rows) => [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n")
const BUDGET = { sqlP95: 500, actionP95: 1000, pageRows: 100, sceneRows: 48, lcp: 2500, inp: 200, cls: 0.1 }

function actionRows(result, filter = () => true) {
  return (result.acciones ?? []).filter(filter).map((pass) => [
    pass.escenario, String(pass.concurrencia), String(pass.accionMs.n), ms(pass.accionMs.p50), ms(pass.accionMs.p95), ms(pass.accionMs.max),
    pass.sqlMs ? pair(pass.sqlMs) : "—", pair(pass.authServidorMs), String(pass.llamadasAuthPorPeticion), pass.filas.n ? ms(pass.filas.max) : "—",
    pass.bytes.n ? String(Math.round(pass.bytes.p50 / 1024)) : "—", String(pass.pool?.maxTotal ?? "—"), String(pass.errores), String(pass.peticionesPorSegundo),
  ])
}

function pick(result, name, concurrency = 1) {
  return result.acciones?.find((pass) => pass.escenario === name && pass.concurrencia === concurrency)
}

function verdict(ok) { return ok ? "Cumple" : "**No cumple**" }

/** Comparación automática con los presupuestos propuestos de 04 (10000 ejemplares si existe; si no, el mayor medido). */
export function budgetRows(all) {
  const scale = Math.max(...Object.keys(all.tamanos).map(Number))
  const result = all.tamanos[scale]
  const rows = []
  const list = pick(result, "listado-inicial")
  const dash = pick(result, "dashboard")
  if (list && dash) {
    const sqlP95 = Math.round((list.sqlMs.p95 + dash.sqlMs.p95) * 10) / 10
    rows.push([`Consulta paginada y resumen, ${scale} ejemplares, caliente, 1 sesión`, `p95 SQL ≤ ${BUDGET.sqlP95} ms`, `${list.sqlMs.p95} ms (listado) + ${dash.sqlMs.p95} ms (resumen) = ${sqlP95} ms`, verdict(sqlP95 <= BUDGET.sqlP95)])
  }
  const rowsMax = Math.max(0, ...["listado-inicial", "listado-100-filas", "listado-ultima-pagina", "filtrado-estado-estanteria", "ordenado-autor", "busqueda-local-texto"].map((n) => pick(result, n)?.filas.max ?? 0))
  rows.push(["Filas por página de colección", `≤ ${BUDGET.pageRows}`, `${rowsMax} (máximo observado; la página máxima admitida es 100)`, verdict(rowsMax <= BUDGET.pageRows)])
  if (list) rows.push([`Acción de listado, p95 con Auth + DB (1 sesión)`, `p95 ≤ ${BUDGET.actionP95} ms`, `${list.accionMs.p95} ms (Auth GoTrue ${list.authServidorMs.p95} ms × ${list.llamadasAuthPorPeticion} llamadas; SQL ${list.sqlMs.p95} ms)`, verdict(list.accionMs.p95 <= BUDGET.actionP95)])
  for (const c of [5, 10]) {
    const pass = pick(result, "listado-inicial", c)
    if (pass) rows.push([`Acción de listado con ${c} sesiones concurrentes`, `p95 ≤ ${BUDGET.actionP95} ms`, `${pass.accionMs.p95} ms (${pass.peticionesPorSegundo} peticiones/s; pool máx. ${pass.pool?.maxTotal})`, verdict(pass.accionMs.p95 <= BUDGET.actionP95)])
  }
  // Resto de acciones de navegación con varias sesiones: se listan solo las que superan el presupuesto de acción.
  for (const item of contractResults(result)) {
    if (item.status !== "over-budget" || item.unit !== "ms" || item.scenario.startsWith("sql:") || item.scenario.startsWith("web:") || !item.concurrency || item.concurrency === 1) continue
    if (item.scenario.startsWith("listado-inicial@")) continue
    rows.push([`${item.scenario.replace("@", " con ")} sesiones concurrentes`, `p95 ≤ ${BUDGET.actionP95} ms`, `p95 ${item.p95} ms (p50 ${item.p50} ms)`, verdict(false)])
  }
  const scene = pick(result, "estanteria-3d-pagina-48")
  if (scene) rows.push(["Vista 3D: libros por página", `≤ ${BUDGET.sceneRows}`, `${scene.filas.max}`, verdict(scene.filas.max <= BUDGET.sceneRows)])
  // Tarea T1: abrir Ajustes ya no lee la colección; solo recuentos (respuesta de tamaño constante).
  const counts = pick(result, "ajustes-recuentos")
  if (counts) rows.push(["Navegación ordinaria sin consultas sin límite (Ajustes al abrirse)", "ninguna consulta sin LIMIT que crezca con la colección", `getLibraryCountsAction responde ${counts.bytes.p50} B al abrir /settings`, verdict(counts.bytes.p50 <= 1024)])
  const quota = all.cuota?.distintos
  if (quota) rows.push(["Paso de worker: no retener conexión mientras se espera la cuota", "sin transacción abierta durante la espera", `transacción más larga ${quota.conexiones.transaccionMasLargaMs} ms; «idle in transaction» máx. ${quota.conexiones.enTransaccionInactivaMaximas}; conexiones máx. ${quota.conexiones.conexionesMaximas} (2 procesos)`, verdict(quota.conexiones.enTransaccionInactivaMaximas === 0)])
  for (const [profileKey, web] of Object.entries(result.web ?? {})) {
    for (const [screen, m] of Object.entries(web.pantallas)) {
      const worstLcp = Math.max(m.frio.lcpMs ?? 0, m.caliente.lcpMs ?? 0)
      const inp = m.interaccion.inpPeorMs ?? 0
      const cls = Math.max(m.frio.cls ?? 0, m.caliente.cls ?? 0, m.interaccion.clsConGestos ?? 0)
      rows.push([`${screen} (${profileKey})`, `LCP ≤ ${BUDGET.lcp} ms · INP ≤ ${BUDGET.inp} ms · CLS ≤ ${BUDGET.cls}`, `LCP ${worstLcp} ms · INP ${inp} ms · CLS ${cls}`, verdict(worstLcp <= BUDGET.lcp && inp <= BUDGET.inp && cls <= BUDGET.cls)])
    }
  }
  return { scale, rows }
}

function reportLink(dir) {
  // Un ensayo puede guardar sus tablas en subcarpetas del informe común (100/1000/10000).
  let ancestor = path.resolve(dir)
  while (true) {
    const report = path.join(ancestor, "informe.md")
    if (existsSync(report)) return path.relative(dir, report).split(path.sep).join("/")
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return "informe.md" // El análisis se redactará junto a las tablas.
    ancestor = parent
  }
}

export function writeTables(dir, { manifest, all }) {
  const lines = ["# Tablas de la medición (generadas por `pnpm perf:local`)", "", `Generadas el ${manifest.generadoEn}. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](${reportLink(dir)}) para el análisis.`, ""]
  for (const [scale, result] of Object.entries(all.tamanos)) {
    lines.push(`## ${scale} ejemplares`, "", `Dataset \`${result.dataset.id}\` (huella \`${result.dataset.hash.slice(0, 16)}\`): ${result.dataset.libros} libros, ${result.dataset.estanterias} estanterías, estanteria mayor ${result.dataset.estanteriaMayor} libros, ISBN manuales ${result.dataset.isbnManuales}.`, "")
    if (result.acciones) {
      lines.push("### Acciones (Server Actions reales, caliente)", "", "`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.", "",
        table(["escenario", "sesiones", "n", "acción p50", "acción p95", "máx.", "SQL p50 / p95", "Auth p50 / p95", "Auth/petición", "filas máx.", "KiB p50", "pool máx.", "errores", "peticiones/s"], actionRows(result)), "")
      lines.push("### Frío (primera llamada tras arrancar la app)", "", table(["escenario", "acción", "SQL", "Auth (GoTrue)"], (result.frio ?? []).map((c) => [c.escenario, ms(c.accionMs), ms(c.sqlMs), c.authServidorMs.join(" + ")])), "")
      if (result.exportacion) lines.push("### Exportación por partes (generada en el servidor)", "", `Respuesta de la acción (manifiesto y enlaces): ${Math.round(result.exportacion.accionBytes / 1024)} KiB. Formato ${result.exportacion.formato}, ${result.exportacion.partes} partes (${result.exportacion.fichasPorParte.join(" + ")} fichas; ${result.exportacion.bytesPorParte.map((b) => Math.round(b / 1024)).join(" + ")} KiB). Descarga de las partes desde la app: p50 ${result.exportacion.descargaMs.p50} ms por parte.`, "")
    }
    if (result.consultas) lines.push("### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)", "", table(["consulta", "acción", "ejecución p50 / p95", "planificación p50", "nodos", "LIMIT"], result.consultas.map((q) => [q.id, q.accion, pair(q.ejecucionMs), ms(q.planificacionMs.p50), q.nodos.slice(0, 4).join(" › "), q.limite ? "sí" : "**no**"])), "")
    if (result.indices) {
      lines.push("### Índices candidatos (medidos en transacción revertida)", "")
      for (const idx of result.indices) {
        if (!idx.aplicable) { lines.push(`- \`${idx.propone}\` — **no aplicable**: ${idx.error}`); continue }
        lines.push(`- \`${idx.propone}\` (${Math.round(idx.tamanoIndiceBytes / 1024)} KiB; tabla ${Math.round(idx.tamanoTablaBytes / 1024)} KiB; insertar 2000 fichas: ${result.escrituraSinIndiceMs} ms sin índice → ${idx.escrituraConIndiceMs} ms con él): ${idx.antes.map((b, i) => `${b.id} ${pair(b.ejecucionMs)} → ${pair(idx.despues[i].ejecucionMs)}`).join("; ")}`)
      }
      lines.push("")
    }
    if (result.aislamiento) lines.push("### Aislamiento bajo carga", "", `${result.aislamiento.sesionesDeCarga} sesiones de escala + A + B durante ${result.aislamiento.duracionMs / 1000} s: ${result.aislamiento.peticiones.escala} peticiones de escala, ${result.aislamiento.peticiones.a} de A y ${result.aislamiento.peticiones.b} de B; ${result.aislamiento.comprobaciones} comprobaciones; **${result.aislamiento.violaciones} violaciones**.`, "")
    if (result.conexiones) lines.push("### Conexiones", "", `max_connections = ${result.conexiones.maxConnections}; conexiones abiertas al terminar la carga: ${result.conexiones.total}.`, "", table(["aplicación", "rol", "estado", "conexiones"], result.conexiones.porAplicacion.map((c) => [c.aplicacion, c.rol, c.estado ?? "—", String(c.conexiones)])), "")
    for (const web of Object.values(result.web ?? {})) {
      lines.push(`### Web vitals · perfil «${web.perfil.id}»`, "", `${web.perfil.descripcion} Navegador ${web.navegador}. Mediana de ${Object.values(web.pantallas)[0]?.frio.muestras} contexto(s) por pantalla.`, "",
        table(["pantalla", "LCP frío", "LCP caliente", "FCP frío", "datos listos frío", "datos listos caliente", "CLS", "INP", "interacciones", "tareas largas"],
          Object.entries(web.pantallas).map(([screen, m]) => [screen, ms(m.frio.lcpMs), ms(m.caliente.lcpMs), ms(m.frio.fcpMs), ms(m.frio.datosListosMs), ms(m.caliente.datosListosMs), ms(Math.max(m.frio.cls ?? 0, m.caliente.cls ?? 0, m.interaccion.clsConGestos ?? 0)), ms(m.interaccion.inpPeorMs), ms(m.interaccion.interacciones), `${ms(m.interaccion.tareasLargas)} (${ms(m.interaccion.tareasLargasMs)} ms)`])), "")
      const exp = web.pantallas.ajustes?.interaccion.exportMs
      if (exp) lines.push(`Exportación en el navegador (clic → copia lista): ${exp} ms.`, "")
      if (web.erroresDeConsola.length) lines.push(`Errores de consola o de página observados: ${web.erroresDeConsola.join(" · ")}`, "")
    }
    lines.push(`Salidas de red externas del servidor o del navegador: ${result.redExterna.hostsBloqueadosDelServidor.length + result.redExterna.hostsAbortadosDelNavegador.length} (guard de red ${result.redExterna.guardCargado ? "activo" : "NO activo"}).`, "")
  }
  if (all.authIdaYVuelta) lines.push("## Auth: ida y vuelta de `GET /auth/v1/user` (cliente → Kong → GoTrue)", "", table(["sesiones", "n", "p50", "p95", "máx."], Object.entries(all.authIdaYVuelta).map(([c, s]) => [c, String(s.n), ms(s.p50), ms(s.p95), ms(s.max)])), "")
  if (all.cuota) {
    const q = all.cuota
    lines.push("## Cuota distribuida con dos procesos (catálogo en fixture)", "",
      `- Dos procesos × ${q.distintos.consultasPorProceso} ISBN distintos: ${q.distintos.peticionesAlProveedor} peticiones al proveedor simulado, separación mínima entre las plazas reservadas por la base ${q.distintos.separacionPlazasMinimaMs} ms (intervalo exigido ${q.distintos.intervaloOLms} ms) → ${q.distintos.cumpleIntervalo ? "cumple" : "**no cumple**"}. Entre las peticiones observadas la separación mínima fue ${q.distintos.separacionMinimaMs} ms (media ${q.distintos.separacionMediaMs} ms): hasta ${q.distintos.jitterObservadoMs} ms de jitter de planificación del proceso, no una reserva adelantada. Duración total ${q.distintos.duracionTotalMs} ms; latencia por consulta (incluye la espera de su plaza) p50 ${q.distintos.latenciaConsultaMs.p50} ms / p95 ${q.distintos.latenciaConsultaMs.p95} ms.`,
      `- Conexiones de los procesos (muestreo cada 25 ms, ${q.distintos.conexiones.muestras} muestras): máx. ${q.distintos.conexiones.conexionesMaximas} simultáneas (pool de 2 por proceso), ${q.distintos.conexiones.activasMaximas} activa(s), «idle in transaction» máx. ${q.distintos.conexiones.enTransaccionInactivaMaximas}, transacción más larga ${q.distintos.conexiones.transaccionMasLargaMs} ms.`,
      `- Caché compartida: ${q.aciertosDeCache.consultas} consultas repetidas desde el otro proceso, ${q.aciertosDeCache.peticionesAlProveedor} peticiones al proveedor, latencia p50 ${q.aciertosDeCache.latenciaMs.p50} ms / p95 ${q.aciertosDeCache.latenciaMs.p95} ms.`,
      `- Consulta en vuelo: el mismo ISBN pedido a la vez por los dos procesos → ${q.consultaEnVueloCompartida.peticionesAlProveedor} petición al proveedor.`, "")
  }
  const { scale, rows } = budgetRows(all)
  lines.push(`## Comparación automática con los presupuestos propuestos (${scale} ejemplares)`, "", table(["medida", "presupuesto propuesto", "medido", "resultado"], rows), "")
  writeFileSync(path.join(dir, "tablas.md"), `${lines.join("\n")}\n`)
}
