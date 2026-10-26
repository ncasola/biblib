// U-QA-05 (O16) · Datos legados para la migración desde el esquema previo a la spec (0002) en el perfil scratch.
//   cargar  inserta en la cuenta ficticia A las 111 fichas sintéticas de tests/fixtures/import/sintetico-111.json con
//           sus estanterías (la predeterminada del fixture se asigna a la predeterminada de A). Solo con head 0002.
//   huella  imprime, por cuenta del censo, cantidades y hashes de las fichas (`biblib.books`, tabla en 0002 y vista
//           plana desde 0011) y de las estanterías. No imprime títulos ni ISBN.
// Uso: node docs/validacion/2026-10-26/O16/qa-05/legado.mjs cargar|huella
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CONTAINER = "supabase_db_biblib-scratch"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")

function psql(sql) {
  const result = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`psql falló (${result.status}): ${result.stderr.trim().slice(0, 400)}`)
  return result.stdout.trim()
}
const literal = (value) => (value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`)

function load() {
  const head = psql("select count(*) from drizzle.__drizzle_migrations;")
  if (head !== "3") throw new Error(`Se esperaba el head 0002 (3 migraciones) y hay ${head}.`)
  // Con el código de la versión previa extraído, el fixture (posterior) se lee de una copia indicada en QA05_FIXTURE.
  const data = JSON.parse(readFileSync(process.env.QA05_FIXTURE ?? path.join(ROOT, "tests/fixtures/import/sintetico-111.json"), "utf8"))
  const defaultId = data.shelves.find((shelf) => shelf.isDefault).id
  const statements = ["begin;", "create temp table owner_a as select id from auth.users where email = 'lector-a@biblib.test';"]
  for (const shelf of data.shelves.filter((item) => !item.isDefault)) {
    statements.push(`insert into biblib.shelves (id, user_id, title) select ${literal(shelf.id)}, id, ${literal(shelf.title)} from owner_a;`)
  }
  for (const book of data.books) {
    const shelf = book.shelf_id === defaultId ? "(select s.id from biblib.shelves s join owner_a a on a.id = s.user_id where s.is_default)" : literal(book.shelf_id)
    statements.push(`insert into biblib.books (id, user_id, isbn, title, subtitle, authors, publishers, number_of_pages, publish_date, cover_small, cover_medium, cover_large, status, shelf_id)
      select ${literal(book.id)}, id, ${literal(book.isbn)}, ${literal(book.title)}, ${literal(book.subtitle)}, ${literal(JSON.stringify(book.authors ?? []))}::jsonb, ${literal(JSON.stringify(book.publishers ?? []))}::jsonb,
      ${Number(book.number_of_pages) || 0}, ${literal(book.publish_date ?? "")}, ${literal(book.cover.small)}, ${literal(book.cover.medium)}, ${literal(book.cover.large)}, ${literal(book.status)}, ${shelf} from owner_a;`)
  }
  statements.push("commit;")
  psql(statements.join("\n"))
  console.log(JSON.stringify({ cargadas: data.books.length, estanterias: data.shelves.length - 1 }))
}

function fingerprint() {
  const sql = `select coalesce(json_agg(row_to_json(t) order by t.email), '[]'::json) from (
    select u.email,
      (select count(*) from biblib.books b where b.user_id = u.id) as fichas,
      (select count(*) from biblib.shelves s where s.user_id = u.id) as estanterias,
      (select md5(coalesce(string_agg(concat_ws('|', b.id, b.title, b.status, b.shelf_id, b.number_of_pages, b.publish_date, b.authors::text, b.publishers::text, b.cover_small), E'\\n' order by b.id), '')) from biblib.books b where b.user_id = u.id) as huella_fichas,
      (select md5(coalesce(string_agg(b.id || '|' || coalesce(b.isbn, ''), E'\\n' order by b.id), '')) from biblib.books b where b.user_id = u.id) as huella_isbn,
      (select md5(coalesce(string_agg(concat_ws('|', s.id, s.title, s.is_default), E'\\n' order by s.id), '')) from biblib.shelves s where s.user_id = u.id) as huella_estanterias,
      (select count(*) from biblib.books b where b.user_id = u.id and b.isbn like 'manual-%') as manuales
    from auth.users u where u.email in ('lector-a@biblib.test', 'lector-b@biblib.test')) t;`
  console.log(JSON.stringify({ migraciones: Number(psql("select count(*) from drizzle.__drizzle_migrations;")), cuentas: JSON.parse(psql(sql)) }, null, 2))
}

const command = process.argv[2]
if (command === "cargar") load()
else if (command === "huella") fingerprint()
else {
  console.error("Uso: legado.mjs cargar|huella")
  process.exitCode = 2
}
