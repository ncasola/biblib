import { invoke } from "./load.mjs"

// Aislamiento bajo carga (U-QA-03): mientras 10 sesiones de la cuenta de escala saturan la app, A y B
// consultan sus propias colecciones y las de la cuenta de escala por IDs. Ninguna respuesta puede contener
// filas, estanterías ni fichas de otro propietario, y las lecturas cruzadas devuelven «no encontrado».

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ownership(sql, userId) {
  const books = new Set((await sql`select id from biblib.books where user_id = ${userId}`).map((row) => row.id))
  const shelves = new Set((await sql`select id from biblib.shelves where user_id = ${userId}`).map((row) => row.id))
  return { books, shelves }
}

export async function isolationUnderLoad({ app, sessions, sql, ctx, facts, durationMs = 10_000 }) {
  const owners = {
    escala: { ...(await ownership(sql, sessions.scaleUserId)), session: sessions.escala },
    a: { ...(await ownership(sql, ctx.users.a)), session: [sessions.a] },
    b: { ...(await ownership(sql, ctx.users.b)), session: [sessions.b] },
  }
  const foreign = (own) => Object.entries(owners).filter(([key]) => key !== own).map(([, value]) => value)
  const violations = []
  const counts = { peticiones: { escala: 0, a: 0, b: 0 }, comprobaciones: 0 }
  const deadline = Date.now() + durationMs
  const bad = (who, what) => { if (violations.length < 20) violations.push(`${who}: ${what}`) }

  const check = (who, own, name, result, expectation) => {
    counts.comprobaciones++
    if (!result.ok) return bad(who, `${name} falló (${result.status})`)
    const value = result.value
    const books = Array.isArray(value?.books) ? value.books : Array.isArray(value) ? value.filter((x) => x && "shelf_id" in x) : value?.recent ? [...value.recent, ...value.currentlyReading] : value && "shelf_id" in value ? [value] : []
    for (const book of books) {
      if (!owners[own].books.has(book.id)) bad(who, `${name} devolvió una ficha ajena`)
      if (foreign(own).some((other) => other.books.has(book.id))) bad(who, `${name} devolvió una ficha de otro propietario`)
    }
    const shelves = Array.isArray(value?.shelves) ? value.shelves : name === "getShelvesAction" && Array.isArray(value) ? value : []
    for (const shelf of shelves) if (!owners[own].shelves.has(shelf.id)) bad(who, `${name} devolvió una estantería ajena`)
    expectation?.(value)
  }

  // Carga de fondo: 10 sesiones de escala.
  const background = Promise.all(owners.escala.session.map(async (session, s) => {
    let i = s
    while (Date.now() < deadline) {
      i++
      const pick = i % 4
      const result = pick === 0 ? await invoke(app, session, "listBooksAction", [{ page: 1 + (i % 200), pageSize: 10, sort: "title" }])
        : pick === 1 ? await invoke(app, session, "getBookDetailAction", [facts.bookIds[i % facts.bookIds.length]])
        : pick === 2 ? await invoke(app, session, "getLibrarySummaryAction", [])
        : await invoke(app, session, "getShelvesAction", [])
      counts.peticiones.escala++
      check("escala", "escala", ["listBooksAction", "getBookDetailAction", "getLibrarySummaryAction", "getShelvesAction"][pick], result)
      // Una ficha de A o B pedida por ID desde la cuenta de escala no existe para ella.
      if (i % 25 === 0) {
        const target = [...owners.a.books][0]
        const cross = await invoke(app, session, "getBookDetailAction", [target])
        counts.peticiones.escala++
        counts.comprobaciones++
        if (!cross.ok || cross.value !== null) bad("escala", "una ficha de A fue visible para la cuenta de escala")
      }
    }
  }))

  // A y B consultan sus colecciones y la ajena mientras dura la carga.
  const personal = (key, label) => (async () => {
    const own = owners[key]
    const session = own.session[0]
    const escalaBook = facts.bookIds[0]
    const escalaShelf = facts.bigShelf
    while (Date.now() < deadline) {
      let result = await invoke(app, session, "listBooksAction", [{ pageSize: 100 }])
      counts.peticiones[key]++
      check(label, key, "listBooksAction", result, (value) => { if (value.total !== own.books.size) bad(label, `el total (${value.total}) no coincide con sus ${own.books.size} fichas`) })
      result = await invoke(app, session, "getLibraryCountsAction", [])
      counts.peticiones[key]++
      check(label, key, "getLibraryCountsAction", result, (value) => { if (value?.ok !== true || value.value.books !== own.books.size) bad(label, "los recuentos no coinciden con sus fichas") })
      result = await invoke(app, session, "getShelvesAction", [])
      counts.peticiones[key]++
      check(label, key, "getShelvesAction", result)
      result = await invoke(app, session, "getBookDetailAction", [escalaBook])
      counts.peticiones[key]++
      counts.comprobaciones++
      if (!result.ok || result.value !== null) bad(label, "una ficha de la cuenta de escala fue visible")
      result = await invoke(app, session, "listBooksAction", [{ shelf: escalaShelf }])
      counts.peticiones[key]++
      counts.comprobaciones++
      if (!result.ok || result.value?.total !== 0) bad(label, "el filtro por una estantería ajena devolvió fichas")
      await sleep(50)
    }
  })()

  await Promise.all([background, personal("a", "A"), personal("b", "B")])
  return { duracionMs: durationMs, sesionesDeCarga: owners.escala.session.length, ...counts, violaciones: violations.length, detalleViolaciones: violations, aislado: violations.length === 0 }
}
