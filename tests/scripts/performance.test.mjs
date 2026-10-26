import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { parseSeedArgs } from "../../scripts/db/seed-local.mjs"
import { fixtureId } from "../../scripts/db/fixture-store.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { bookAt, datasetHash, DATASET_ID, isScale, scaleDataset, scaleIsbn, SCALES, shelvesFor, summarize as summarizeDataset } from "../../scripts/performance/lib/dataset.mjs"
import { percentile, summarize } from "../../scripts/performance/lib/stats.mjs"
import { redactPlan } from "../../scripts/performance/lib/explain.mjs"
import { budgetRows, writeTables } from "../../scripts/performance/lib/report.mjs"
import { parseArgs } from "../../scripts/performance/run.mjs"
import { contractResults } from "../../scripts/performance/lib/contract.mjs"
import { parseScale, runScaleSeed, scaleCensus, seedScaleDomain } from "../../scripts/performance/scale-seed.mjs"

// U-QA-03 · Seed de escala, dataset determinista y utilidades de la medición. Sin Docker ni red.

const isbn13Valid = (value) => /^97[89]\d{10}$/.test(value) && [...value].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0) % 10 === 0

test("el dataset es determinista: dos generaciones producen exactamente el mismo contenido", () => {
  for (const scale of SCALES) assert.equal(datasetHash(scaleDataset(scale)), datasetHash(scaleDataset(scale)))
  assert.notEqual(datasetHash(scaleDataset(100)), datasetHash(scaleDataset(1000)))
})

test("el libro i no depende del tamaño: los 100 primeros de 1000 coinciden con el dataset de 100 salvo la estantería", () => {
  const small = scaleDataset(100).books
  const large = scaleDataset(1000).books
  for (let i = 0; i < 100; i++) {
    const { shelfKey: a, ...rest } = small[i]
    const { shelfKey: b, ...other } = large[i]
    assert.deepEqual(rest, other)
    assert.ok(typeof a === "string" && typeof b === "string")
  }
})

test("los tres tamaños respetan las restricciones del esquema: ISBN, títulos, páginas, estados y estanterías", () => {
  const statuses = new Set(["read", "reading", "unread", "to-read"])
  for (const scale of SCALES) {
    const dataset = scaleDataset(scale)
    assert.equal(dataset.books.length, scale)
    const isbns = new Set(dataset.books.map((b) => b.isbn))
    assert.equal(isbns.size, scale, "ISBN únicos por cuenta (índice books_user_id_isbn_unique)")
    const titles = dataset.shelves.map((s) => s.title)
    assert.equal(new Set(titles).size, titles.length, "títulos de estantería únicos")
    assert.equal(dataset.shelves.filter((s) => s.isDefault).length, 1)
    const shelfKeys = new Set(dataset.shelves.map((s) => s.fixtureKey))
    for (const shelf of dataset.shelves) assert.ok(shelf.title.trim().length >= 1 && shelf.title.length <= 120)
    for (const book of dataset.books) {
      assert.ok(statuses.has(book.status))
      assert.ok(shelfKeys.has(book.shelfKey))
      assert.ok(book.title.trim().length >= 1 && book.title.length <= 500)
      assert.ok(Number.isInteger(book.number_of_pages) && book.number_of_pages >= 0 && book.number_of_pages <= 100000)
      assert.ok(book.authors.length >= 1 && book.authors.every((a) => a.name.length > 0))
      if (!book.isbn.startsWith("manual-")) assert.ok(isbn13Valid(book.isbn), `ISBN-13 con dígito de control correcto: ${book.isbn}`)
      assert.ok(!/^978/.test(book.isbn), "ningún ISBN pertenece al rango de libros reales 978")
    }
  }
})

test("el reparto es realista: estados con la proporción esperada, estantería mayor dominante y ISBN manuales ~15 %", () => {
  const summary = summarizeDataset(scaleDataset(10000))
  assert.equal(summary.shelves, 41)
  assert.ok(Math.abs(summary.byStatus.read / 10000 - 0.4) < 0.03)
  assert.ok(Math.abs(summary.byStatus.reading / 10000 - 0.08) < 0.02)
  assert.ok(summary.largestShelf > 1000 && summary.largestShelf < 3000)
  assert.ok(Math.abs(summary.manualIsbn / 10000 - 0.15) < 0.02)
})

test("el dataset incluye tildes y eñes para ejercitar la búsqueda normalizada", () => {
  const text = scaleDataset(1000).books.map((b) => `${b.title} ${b.authors.map((a) => a.name).join(" ")}`).join(" ")
  assert.match(text, /[áéíóúñ]/i)
  assert.ok(isScale(100) && !isScale(500))
})

test("cada ISBN de escala es único y válido para todo el rango de 10000", () => {
  const all = new Set()
  for (let i = 1; i <= 10000; i++) all.add(scaleIsbn(i))
  assert.equal(all.size, 10000)
  assert.ok([...all].every(isbn13Valid))
  assert.equal(shelvesFor(100).length, 6)
  assert.throws(() => shelvesFor(500), RangeError)
})

test("db:seed:local acepta --scale solo con 100, 1000 o 10000 y conserva el resto del contrato", () => {
  assert.deepEqual(parseSeedArgs(["--profile", "test", "--scale", "1000", "--json"]), { profile: "test", json: true, scale: 1000 })
  assert.deepEqual(parseSeedArgs(["--profile", "scratch", "--json"]), { profile: "scratch", json: true })
  for (const args of [["--scale", "50"], ["--scale"], ["--scale", "10000", "--scale", "100"], ["--scale", "1e3"]]) assert.throws(() => parseSeedArgs(args), { code: EXIT.INVALID_ARGS })
  assert.equal(parseScale("10000"), 10000)
})

test("el seed de escala rechaza el perfil main y objetivos no locales antes de resolver nada", async () => {
  let resolved = false
  const deps = { resolveSeedTarget: async () => { resolved = true }, seedAccounts: async () => {}, loadCensus: () => ({}) }
  await assert.rejects(() => runScaleSeed({ profile: "main", scale: 100 }, deps), { code: EXIT.IDENTITY_MISMATCH })
  await assert.rejects(() => runScaleSeed({ profile: "test", scale: 7 }, deps), { code: EXIT.INVALID_ARGS })
  assert.equal(resolved, false)
})

test("el censo de la cuenta de escala es independiente del A/B y comparte solo el metadato del censo", () => {
  const census = scaleCensus({ censusVersion: 1, censusId: "biblib-local-v1" })
  assert.equal(census.accounts.length, 1)
  assert.equal(census.accounts[0].email, "escala@biblib.test")
  assert.equal(census.accounts[0].user_metadata.biblib_fixture, "biblib-local-v1")
  assert.equal(census.accounts[0].user_metadata.biblib_scale, DATASET_ID)
})

test("el seed de dominio actúa en una transacción, solo sobre su propietario, en lotes y sin tocar auth", async () => {
  const user = "11111111-1111-4111-8111-111111111111"
  const statements = []
  let inserted = 0, transactions = 0
  const tx = (strings, ...values) => {
    if (!strings.raw) { // forma tx(filas, ...columnas)
      inserted += strings.length
      return { bulk: strings.length }
    }
    const text = strings.join("?").replace(/\s+/g, " ").trim()
    statements.push({ text, values })
    if (/returning id/.test(text)) return Promise.resolve([{ id: "22222222-2222-4222-8222-222222222222" }])
    if (/select count\(\*\)/.test(text)) return Promise.resolve([{ n: inserted }])
    return Promise.resolve([])
  }
  tx.json = (value) => value
  const sql = Object.assign((strings) => { statements.push({ text: strings.join("?").trim(), values: [] }); return Promise.resolve([]) }, { begin: async (fn) => { transactions++; return fn(tx) } })
  const dataset = scaleDataset(1000)
  await seedScaleDomain(sql, user, dataset, { censusId: "biblib-local-v1" })
  assert.equal(transactions, 1, "todo el reemplazo va en una sola transacción")
  assert.equal(inserted, 1000)
  const deletes = statements.filter((s) => /^delete from/.test(s.text))
  assert.equal(deletes.length, 2)
  assert.ok(deletes.every((s) => /where user_id = \?/.test(s.text) && s.values[0] === user), "los borrados están acotados por propietario")
  assert.ok(statements.every((s) => !/\bauth\./.test(s.text)), "ninguna sentencia toca el esquema auth")
  assert.ok(statements.some((s) => /^analyze biblib\.books/.test(s.text)), "estadísticas frescas tras el seed")
  // Los IDs derivan del propietario: otro usuario no colisiona con los de este.
  assert.notEqual(fixtureId(DATASET_ID, user, "book", "escala-00001"), fixtureId(DATASET_ID, "33333333-3333-4333-8333-333333333333", "book", "escala-00001"))
})

test("el seed de dominio falla y revierte si el recuento no coincide con el dataset", async () => {
  const tx = Object.assign((strings) => {
    if (!strings.raw) return { bulk: 1 }
    const text = strings.join("?")
    if (/returning id/.test(text)) return Promise.resolve([{ id: "22222222-2222-4222-8222-222222222222" }])
    if (/select count\(\*\)/.test(text)) return Promise.resolve([{ n: 3 }])
    return Promise.resolve([])
  }, { json: (value) => value })
  const sql = Object.assign(() => Promise.resolve([]), { begin: async (fn) => fn(tx) })
  await assert.rejects(() => seedScaleDomain(sql, "11111111-1111-4111-8111-111111111111", scaleDataset(100), { censusId: "x" }), { code: EXIT.SEED_FAILED })
})

test("los estadísticos usan interpolación lineal y toleran muestras pequeñas o vacías", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([10, 20], 95), 19.5)
  assert.equal(percentile([], 50), null)
  assert.deepEqual(summarize([]), { n: 0 })
  const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1))
  assert.deepEqual([s.n, s.min, s.p50, s.p95, s.max], [100, 1, 50.5, 95.1, 100])
  assert.equal(summarize([5, Number.NaN, 7]).n, 2)
})

test("los EXPLAIN guardados no contienen identificadores", () => {
  const plan = "Filter: (user_id = '3f1b7c52-9d0e-4c53-8f7a-0a1b2c3d4e5f'::uuid) AND (id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')"
  const redacted = redactPlan(plan)
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(redacted))
  assert.equal(redacted.match(/<uuid>/g).length, 2)
})

test("los argumentos de perf:local siguen el contrato: perfil test o scratch, tamaño 1000 por defecto y escenarios por nombre", () => {
  const defaults = parseArgs([])
  assert.deepEqual([defaults.profile, defaults.scales, defaults.only, defaults.json], ["test", [1000], null, false])
  assert.deepEqual(parseArgs(["--scale", "10000", "--scale", "100"]).scales, [100, 10000])
  const parsed = parseArgs(["--profile", "scratch", "--scenarios", "dashboard,listado-inicial,web", "--out", "salida", "--json", "--skip", "quota", "--reuse-build", "--cleanup", "--web-runs", "2"])
  assert.equal(parsed.profile, "scratch")
  assert.deepEqual([...parsed.only], ["dashboard", "listado-inicial", "web"])
  assert.deepEqual([parsed.out, parsed.json, parsed.reuseBuild, parsed.cleanup, parsed.webRuns], ["salida", true, true, true, 2])
  for (const args of [["--scale", "500"], ["--scale", "1e3"], ["--skip", "nada"], ["--profile", "main"], ["--profile", "prod"], ["--web-runs", "9"], ["--db-url", "x"], ["--scenarios", "nada"], ["--scenarios"], ["--scenarios", "dashboard,;rm"], ["--out"]]) assert.throws(() => parseArgs(args), { code: EXIT.INVALID_ARGS })
})

test("el contrato JSON lista cada escenario con p50, p95, presupuesto y estado (ok, over-budget o no-budget)", () => {
  const result = sample(10000, { list: { accionMs: { n: 10, p50: 700, p95: 1500, max: 1600, mean: 800 }, sqlMs: { n: 10, p50: 5, p95: 9, max: 10 } } })
  const results = contractResults(result)
  for (const entry of results) assert.deepEqual(Object.keys(entry).filter((key) => ["scenario", "p50", "p95", "budget", "status"].includes(key)).sort(), ["budget", "p50", "p95", "scenario", "status"])
  const byName = (name) => results.find((entry) => entry.scenario === name)
  assert.deepEqual([byName("listado-inicial").budget, byName("listado-inicial").status], [1000, "over-budget"])
  assert.deepEqual([byName("dashboard").budget, byName("dashboard").status], [1000, "ok"])
  assert.equal(byName("sql:listado-inicial").budget, 500)
  assert.equal(byName("sql:listado-inicial").status, "ok")
  assert.deepEqual([byName("exportacion-servidor").budget, byName("exportacion-servidor").status], [null, "no-budget"])
  assert.equal(byName("listado-inicial@10").concurrency, 10)
  assert.equal(byName("web:escritorio:inicio:lcp").budget, 2500)
  assert.equal(byName("web:escritorio:inicio:inp").status, "ok")
  assert.equal(byName("web:escritorio:inicio:cls").unit, "score")
})

function sample(scale, overrides = {}) {
  const pass = (escenario, concurrencia, over = {}) => ({
    escenario, accion: "listBooksAction", concurrencia, iteraciones: 10, accionMs: { n: 10, p50: 100, p95: 200, p99: 210, max: 220, mean: 110 }, sqlMs: concurrencia === 1 ? { n: 10, p50: 5, p95: 9, max: 10 } : null,
    authServidorMs: { n: 20, p50: 45, p95: 60 }, llamadasAuthPorPeticion: 2, filas: { n: 10, max: 10 }, bytes: { n: 10, p50: 7000 }, errores: 0, peticionesPorSegundo: 8, pool: { maxTotal: 1 }, ...over,
  })
  return {
    escala: scale, dataset: { id: DATASET_ID, hash: "a".repeat(64), libros: scale, estanterias: 6, porEstado: {}, estanteriaMayor: 30, isbnManuales: 10 },
    acciones: [pass("dashboard", 1), pass("listado-inicial", 1, overrides.list), pass("listado-inicial", 5), pass("listado-inicial", 10), pass("estanteria-3d-pagina-48", 1, { filas: { n: 10, max: 48 } }), pass("ajustes-recuentos", 1, { filas: { n: 10, max: null }, bytes: { n: 10, p50: overrides.countsBytes ?? 180 } }), pass("exportacion-servidor", 1, { filas: { n: 3, max: null } }), pass("listado-100-filas", 1, { filas: { n: 10, max: 100 } })],
    frio: [{ escenario: "dashboard", accionMs: 300, sqlMs: 8, authServidorMs: [50, 49] }],
    redExterna: { guardCargado: true, hostsBloqueadosDelServidor: [], hostsAbortadosDelNavegador: [] },
    web: { escritorio: { perfil: { id: "x", descripcion: "d" }, navegador: "1", erroresDeConsola: [], pantallas: { inicio: { frio: { lcpMs: 900, cls: 0.01, muestras: 1 }, caliente: { lcpMs: 600, cls: 0.01 }, interaccion: { inpPeorMs: 120, clsConGestos: 0.02 } } } } },
  }
}

test("la comparación con presupuestos marca cumplimiento y fallo de cada medida", () => {
  const ok = budgetRows({ tamanos: { 10000: sample(10000) } })
  assert.equal(ok.scale, 10000)
  const byName = (rows, text) => rows.find((r) => r[0].includes(text))
  assert.match(byName(ok.rows, "Consulta paginada")[3], /Cumple/)
  // Tarea T1 (U-DAT-04): abrir Ajustes solo lee recuentos; una respuesta que crece con la colección incumple.
  assert.match(byName(ok.rows, "Navegación ordinaria")[3], /Cumple/, "Ajustes al abrirse solo carga recuentos")
  assert.match(byName(budgetRows({ tamanos: { 10000: sample(10000, { countsBytes: 6_700_000 }) } }).rows, "Navegación ordinaria")[3], /No cumple/)
  assert.match(byName(ok.rows, "Vista 3D")[3], /Cumple/)
  assert.match(byName(ok.rows, "inicio (escritorio)")[3], /Cumple/)
  const slow = budgetRows({ tamanos: { 10000: sample(10000, { list: { sqlMs: { n: 10, p50: 300, p95: 600, max: 700 }, accionMs: { n: 10, p50: 900, p95: 1500, max: 1600, mean: 1000 } } }) } })
  assert.match(byName(slow.rows, "Consulta paginada")[3], /No cumple/)
  assert.match(byName(slow.rows, "Acción de listado, p95")[3], /No cumple/)
})

test("las tablas generadas solo contienen cifras: sin sesiones, contraseñas ni identificadores", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib-perf-"))
  try {
    writeTables(dir, { manifest: { generadoEn: "2026-10-23T00:00:00.000Z" }, all: { tamanos: { 10000: sample(10000) } } })
    const text = readFileSync(path.join(dir, "tablas.md"), "utf8")
    assert.match(text, /## 10000 ejemplares/)
    assert.match(text, /Comparación automática con los presupuestos propuestos/)
    assert.ok(!/eyJ|password|access_token|refresh_token|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("un libro suelto se genera igual que dentro del dataset completo", () => {
  const dataset = scaleDataset(1000)
  assert.deepEqual(bookAt(500, dataset.shelves), dataset.books[499])
})

test("tablas enlaza el informe más cercano también desde subcarpetas", () => {
  const root = mkdtempSync(path.join(tmpdir(), "biblib-perf-links-"))
  try {
    const nested = path.join(root, "mediciones", "10000")
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(root, "informe.md"), "# Análisis común\n")
    const payload = { manifest: { generadoEn: "2026-10-26" }, all: { tamanos: { 100: sample(100) } } }
    writeTables(root, payload)
    assert.match(readFileSync(path.join(root, "tablas.md"), "utf8"), /\[informe\]\(informe\.md\)/)
    writeTables(nested, payload)
    assert.match(readFileSync(path.join(nested, "tablas.md"), "utf8"), /\[informe\]\(\.\.\/\.\.\/informe\.md\)/)
    writeFileSync(path.join(nested, "informe.md"), "# Análisis específico\n")
    writeTables(nested, payload)
    assert.match(readFileSync(path.join(nested, "tablas.md"), "utf8"), /\[informe\]\(informe\.md\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
