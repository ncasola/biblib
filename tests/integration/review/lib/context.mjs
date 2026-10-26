import { productContext, value } from "../../product/lib/context.mjs"

// Contexto del grupo review (U-DAT-07): el del grupo product (cuentas desechables `o13d-<run>-…`, sesiones GoTrue reales,
// Server Actions de la app compilada y limpieza al terminar) más fichas con ISBN, evidencias e incidencias de la bandeja.
// Las fichas se crean por la vista `books` con el rol de servicio, como los scripts SQL; las decisiones pasan siempre por
// las acciones reales con la sesión del dueño.
export const PROFILES = ["scratch", "test"]
export { value }

/** ISBN-13 sintético válido (prefijo 979-0-0013, fuera del censo A/B y de los fixtures del catálogo). */
export function isbn13(sequence) {
  const body = `9790001${String(sequence).padStart(5, "0")}`
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}

export function failed(result, code) {
  return result.status === 200 && result.value?.ok === false && result.value.error.code === code
}

export async function reviewContext() {
  const ctx = await productContext()
  let sequence = 0
  const review = {
    /** Estantería predeterminada de una cuenta nueva. */
    async shelf(owner) {
      const [row] = await ctx.sql`insert into biblib.shelves (user_id, title, is_default) values (${owner}, 'Principal', true) returning id`
      return row.id
    },
    /** Ejemplar con su edición; con `editionId`, otro ejemplar de esa edición. Sin `isbn`, un identificador manual (sin ISBN). */
    async book(owner, shelf, fields = {}) {
      const n = ++sequence
      const row = {
        isbn: `manual-o13r-${ctx.run}-${n}`, title: ctx.label(`ficha ${n}`), authors: [{ name: `Autoría ${n}` }], publishers: [], publishDate: "", pages: 0,
        catalogue: { source: "import" }, cover: "https://covers.biblib.invalid/o13r.jpg", editionId: null, ...fields,
      }
      const [inserted] = await ctx.sql`insert into biblib.books (user_id, isbn, title, authors, publishers, publish_date, number_of_pages, shelf_id, catalogue, cover_small, cover_medium, cover_large, edition_id)
        values (${owner}, ${row.isbn}, ${row.title}, ${ctx.sql.json(row.authors)}, ${ctx.sql.json(row.publishers)}, ${row.publishDate}, ${row.pages}, ${shelf},
          ${ctx.sql.json(row.catalogue)}, ${row.cover}, ${row.cover}, ${row.cover}, ${row.editionId}) returning id, edition_id`
      return { id: inserted.id, editionId: inserted.edition_id }
    },
    /** Primera página (sincroniza) o la del cursor, con la sesión del dueño. */
    async list(session, input = {}) {
      return value(await ctx.call("listReviewIssuesAction", [{ limit: 50, ...input }], session))
    },
    /** Todas las páginas de unos filtros recorriendo el cursor. */
    async walk(session, filters = {}, limit = 20) {
      const items = []
      let cursor = null
      let pages = 0
      do {
        const page = await review.list(session, { filters, cursor, limit })
        items.push(...page.items)
        cursor = page.nextCursor
        if (++pages > 100) throw new Error("La paginación no termina.")
      } while (cursor)
      return { items, pages }
    },
    async compare(session, issueId) {
      return value(await ctx.call("compareBibliographicCandidatesAction", [{ issueId }], session))
    },
    /** Incidencias de la cuenta leídas con el rol de servicio (para comprobar el estado real). */
    async stored(owner) {
      return [...await ctx.sql`select id, reason, state, dedupe_key, entity_refs, version from biblib.review_issues where user_id = ${owner} order by created_at, id`]
    },
    async issueFor(owner, reason, editionId) {
      const rows = await review.stored(owner)
      return rows.find((row) => row.reason === reason && row.state === "open" && row.entity_refs.some((ref) => ref.id === editionId))
    },
    async evidence(owner) {
      return [...await ctx.sql`select id, edition_id, copy_id, source_kind, source_ref, confidence, origin, photo_asset_id, field_claims from biblib.bibliographic_evidence where user_id = ${owner} order by created_at, id`]
    },
    async decisions(owner) {
      return [...await ctx.sql`select id, issue_id, kind, selected_fields, evidence_refs, operation_id from biblib.review_decisions where user_id = ${owner} order by decided_at, id`]
    },
    async edition(owner, id) {
      return (await ctx.sql`select id, version, title, subtitle, authors, publishers, publish_date, number_of_pages, catalogue, isbn13 from biblib.editions where user_id = ${owner} and id = ${id}`)[0]
    },
    async copy(owner, id) {
      return (await ctx.sql`select id, version, edition_id, edition_verification from biblib.copies where user_id = ${owner} and id = ${id}`)[0]
    },
  }
  return Object.assign(ctx, review)
}
