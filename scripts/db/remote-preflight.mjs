import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { manifestHash, MANIFEST_FILE, resolveBackupsRoot } from "../lib/backup-files.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { loadTarget } from "./environment.mjs"
import { canonical } from "./plan.mjs"

// Preflight de promoción a preproducción/producción (U-INF-07): identidad remota, TLS
// verificado, rol/permisos/versión, revisión de datos previa a 0001/0002 y recibo de respaldo.
// Nada de este módulo escribe en el destino: todas sus consultas son de catálogo o de lectura.

export const REMOTE_TARGETS = Object.freeze(["preprod", "prod"])
export const TLS_KEYS = Object.freeze({ mode: "SUPABASE_DB_SSLMODE", rootCert: "SUPABASE_DB_SSLROOTCERT" })
export const RECEIPT_KIND = "biblib-backup-receipt"
// Un respaldo más antiguo deja demasiadas escrituras fuera; se repite antes de promover.
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const RECEIPT_SCOPE = Object.freeze(["schema", "data", "history", "auth", "storage"])
export const RECEIPT_COVERAGE = Object.freeze(["rls", "policies", "grants", "constraints", "indexes", "functions", "triggers"])
// Rol administrativo de Supabase para DDL; nunca el rol limitado de la aplicación.
export const ADMIN_ROLE = "postgres"
export const LOCAL_POSTGRES_MAJOR = 17
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/
const TLS_ERRORS = /^(ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_|ERR_OSSL_)/
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function isRemoteTarget(target) {
  return REMOTE_TARGETS.includes(target)
}

/** Huella del destino remoto: identidad lógica y descriptor de conexión, sin credenciales ni checkout. */
export function remoteFingerprint({ target, project, host, port, database, user }) {
  return sha256(canonical({ target, project, host, port, database, user }))
}

/**
 * Valida la identidad remota sin abrir conexiones: objetivo, `--expect-project`, URL pública de
 * Auth y conexión administrativa del mismo proyecto (`db.<ref>.supabase.co` o `postgres.<ref>` en el
 * pooler de sesión), base `postgres`, rol administrativo y TLS `verify-full`.
 */
export function describeRemote(target, { env = process.env, expectProject, cwd = REPO_ROOT } = {}) {
  if (!isRemoteTarget(target)) fail(EXIT.INVALID_ARGS, "objetivo", "El objetivo remoto debe ser preprod o prod.")
  if (typeof expectProject !== "string" || !expectProject) fail(EXIT.INVALID_ARGS, "argumentos", "--expect-project <ref> es obligatorio para preprod/prod: la referencia esperada del proyecto Supabase.")
  if (!/^[a-z0-9]{6,40}$/.test(expectProject)) fail(EXIT.INVALID_ARGS, "argumentos", "--expect-project debe ser la referencia del proyecto (minúsculas y dígitos), no una URL ni una contraseña.")
  const ctx = loadTarget(target, { env, cwd })
  const values = ctx.env()
  const ref = values.BIBLIB_EXPECT_PROJECT_REF
  if (ref !== expectProject) fail(EXIT.IDENTITY_MISMATCH, "identidad", "--expect-project no coincide con la referencia del proyecto inyectada para este objetivo; no se ha conectado con nada.")
  const db = new URL(values.SUPABASE_DB_URL)
  const host = db.hostname.toLowerCase()
  const port = Number(db.port || 5432)
  const database = decodeURIComponent(db.pathname.slice(1))
  const user = decodeURIComponent(db.username)
  const pooler = POOLER_HOST.test(host)
  if (new URL(values.SUPABASE_URL).origin !== `https://${ref}.supabase.co`) fail(EXIT.IDENTITY_MISMATCH, "identidad", "La URL pública de Auth no corresponde al proyecto esperado.")
  if (pooler) {
    if (user !== `postgres.${ref}`) fail(EXIT.IDENTITY_MISMATCH, "identidad", "Un pooler regional por sí solo no identifica el proyecto: el usuario debe ser postgres.<ref> del proyecto esperado.")
    if (port !== 5432) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El pooler en modo transacción no conserva el bloqueo consultivo de sesión ni admite DDL transaccional fiable: usa el modo sesión (5432) o la conexión directa db.<ref>.supabase.co.")
  } else {
    if (host !== `db.${ref}.supabase.co`) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El host de Postgres no corresponde al proyecto esperado.")
    if (user !== ADMIN_ROLE) fail(EXIT.IDENTITY_MISMATCH, "identidad", "La promoción usa el rol administrativo postgres, no el rol de una sesión de aplicación.")
  }
  if (database !== "postgres") fail(EXIT.IDENTITY_MISMATCH, "identidad", "La base de Supabase debe ser postgres.")
  if (!db.password) fail(EXIT.INVALID_ARGS, "argumentos", "Falta la credencial de la conexión administrativa; debe inyectarla el gestor de secretos o CI.")
  const mode = env[TLS_KEYS.mode]
  if (mode !== "verify-full") {
    fail(EXIT.IDENTITY_MISMATCH, "tls", mode
      ? `${TLS_KEYS.mode}=${String(mode).replace(/[^a-z-]/gi, "")} no verifica a la vez el certificado y el nombre del host: se exige verify-full.`
      : `Sin TLS verificado (${TLS_KEYS.mode}=verify-full) no se acredita la identidad del destino.`)
  }
  const rootCert = env[TLS_KEYS.rootCert] || null
  if (rootCert !== null) {
    let stat
    try { stat = lstatSync(rootCert) } catch { fail(EXIT.INVALID_ARGS, "tls", `${TLS_KEYS.rootCert} no apunta a un certificado legible.`) }
    if (!path.isAbsolute(rootCert) || stat.isSymbolicLink() || !stat.isFile()) fail(EXIT.INVALID_ARGS, "tls", `${TLS_KEYS.rootCert} debe ser la ruta absoluta de un archivo regular (CA del proveedor), sin enlaces.`)
  }
  const descriptor = { host, port, database, user, connection: pooler ? "pooler-session" : "direct", tls: { mode, rootCert: rootCert ? "ca-explicita" : "ca-del-sistema" } }
  const fingerprint = remoteFingerprint({ target, project: ref, host, port, database, user })
  return Object.freeze({
    target, project: ref, profile: null, fingerprint, descriptor, ctx, rootCert,
    redacted: () => ({ target, project: ref, fingerprint, host, port, database, user, connection: descriptor.connection, tls: mode }),
  })
}

/**
 * Conexión administrativa dedicada con TLS verificado contra el nombre del host remoto.
 * `resolveHost` solo existe para ensayos con un Postgres local que simula el destino: el
 * certificado se sigue verificando contra `db.<ref>.supabase.co`. La CLI no lo expone.
 */
export function connectRemote(remote, { applicationName = "biblib-remote", resolveHost } = {}) {
  const url = new URL(remote.ctx.env().SUPABASE_DB_URL)
  const endpoint = resolveHost ? resolveHost(remote.descriptor.host, remote.descriptor.port) : { host: remote.descriptor.host, port: remote.descriptor.port }
  return postgres({
    host: endpoint.host, port: endpoint.port, database: remote.descriptor.database,
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, servername: remote.descriptor.host, minVersion: "TLSv1.2", ...(remote.rootCert ? { ca: readFileSync(remote.rootCert) } : {}) },
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, max_lifetime: null, onnotice: () => {},
    connection: { application_name: applicationName, statement_timeout: 120000, lock_timeout: 15000, idle_in_transaction_session_timeout: 120000 },
  })
}

/** Traduce fallos de conexión: TLS no verificable o credenciales/rol rechazados → 3; el resto → 8. */
export function remoteConnectionError(error, phase = "conexión") {
  if (error instanceof BiblibError) return error
  const code = String(error?.code ?? "")
  if (TLS_ERRORS.test(code) || /secure TLS connection|certificate|self[- ]signed|SSL/i.test(String(error?.message ?? ""))) {
    return new BiblibError(EXIT.IDENTITY_MISMATCH, "tls", "El servidor no presentó TLS verificable para el host esperado (certificado, nombre o soporte SSL); no se ha enviado ninguna consulta.")
  }
  if (code === "28P01" || code === "28000") return new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", "El destino rechazó el rol o la credencial administrativa; no se ha consultado nada.")
  return new BiblibError(EXIT.SERVICE_UNAVAILABLE, phase, `No se pudo consultar el destino remoto${/^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}.`)
}

/**
 * Comprueba, solo con consultas de catálogo, conexión TLS, rol administrativo, primario,
 * permisos necesarios para DDL y bloqueo, propiedad de los esquemas y versión de Postgres.
 */
export async function probeRemote(sql) {
  const [facts] = await sql`select current_setting('server_version_num')::integer as version_num, current_setting('server_version') as version,
      current_user::text as role, pg_is_in_recovery() as replica,
      coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as ssl,
      (select version from pg_stat_ssl where pid = pg_backend_pid()) as tls_version,
      has_database_privilege(current_database(), 'CREATE') as create_schema,
      to_regnamespace('auth') is not null as auth_schema, to_regnamespace('storage') is not null as storage_schema,
      case when to_regclass('auth.users') is null then null else has_table_privilege('auth.users', 'REFERENCES') end as auth_references`
  const owners = await sql`select distinct owner from (
      select nspowner::regrole::text as owner from pg_namespace where nspname in ('biblib', 'drizzle')
      union all select c.relowner::regrole::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('biblib', 'drizzle')
      union all select p.proowner::regrole::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'biblib') o`
  const membership = await Promise.all(owners.map(async ({ owner }) => ({ owner, member: (await sql`select pg_has_role(current_user, ${owner}, 'MEMBER') as member`)[0].member })))
  const major = Math.floor(facts.version_num / 10000)
  const checks = []
  const check = (id, ok, code, message, failure, status = "fail") => checks.push({ id, status: ok ? "ok" : status, ...(ok || status !== "fail" ? {} : { code }), message: ok ? message : failure })
  check("remote.tls", facts.ssl === true, EXIT.IDENTITY_MISMATCH, `Sesión TLS verificada (${facts.tls_version ?? "TLS"}).`, "La sesión no usa TLS según el propio servidor.")
  check("remote.role", facts.role === ADMIN_ROLE, EXIT.IDENTITY_MISMATCH, "Conectado con el rol administrativo postgres.", "La conexión no usa el rol administrativo postgres: no es apta para DDL ni para el bloqueo de migraciones.")
  check("remote.primary", facts.replica === false, EXIT.IDENTITY_MISMATCH, "El destino es el primario (no una réplica de lectura).", "El destino es una réplica de lectura: no es el primario del proyecto.")
  check("remote.privilege.create", facts.create_schema === true, EXIT.IDENTITY_MISMATCH, "El rol puede crear esquemas (ledger drizzle).", "El rol no puede crear esquemas en la base: permisos insuficientes para el runner.")
  check("remote.privilege.owner", membership.every((m) => m.member), EXIT.IDENTITY_MISMATCH, `El rol pertenece a los propietarios de biblib/drizzle (${owners.length || "sin objetos todavía"}).`, "Hay objetos de biblib/drizzle cuyo propietario no es el rol administrativo: el DDL fallaría.")
  check("remote.privilege.auth", facts.auth_references !== false, EXIT.IDENTITY_MISMATCH, facts.auth_references === null ? "auth.users no existe todavía (lo informa el manifest)." : "El rol puede referenciar auth.users desde las FK de propietario.", "El rol no puede referenciar auth.users: las FK de propietario fallarían.")
  check("remote.platform", facts.auth_schema && facts.storage_schema, null, "Esquemas de plataforma auth y storage presentes.", "Faltan esquemas de plataforma (auth/storage): no parece un proyecto Supabase completo.", "warn")
  if (major < 15) check("remote.version", false, EXIT.MISSING_REQUIREMENT, "", `Postgres ${facts.version} no está soportado (mínimo 15).`)
  else check("remote.version", major === LOCAL_POSTGRES_MAJOR, null, `Postgres ${major}, el mismo major que el stack local.`, `Postgres ${major} difiere del major local (${LOCAL_POSTGRES_MAJOR}): ensaya la actualización en una copia de ese major antes de aplicar.`, "warn")
  const failed = checks.find((c) => c.status === "fail")
  return { code: failed?.code ?? EXIT.OK, checks, facts: { version: facts.version, major, role: facts.role, tls: facts.tls_version, owners: owners.map((o) => o.owner) } }
}

/**
 * Huella de los esquemas de plataforma: el runner nunca debe alterar auth/storage. Excepción declarada:
 * las políticas biblib_* de storage.objects del bucket privado de portadas (0009, U-DAT-10) son del
 * dominio; las comprueba el manifest de objetos (sección storage), no esta huella.
 */
export async function platformFingerprint(sql) {
  const rows = await sql`select n.nspname as schema, c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
      coalesce((select array_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod) order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '{}') as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('auth', 'storage') and c.relkind in ('r', 'v', 'm', 'p')
    union all select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', 'f', p.prosecdef, array[md5(p.prosrc)]
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('auth', 'storage')
    union all select n.nspname, pol.polname || '@' || c.relname, 'P', pol.polpermissive, array[coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''), coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')]
    from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('auth', 'storage') and not starts_with(pol.polname, 'biblib_')
    order by 1, 2, 3`
  return sha256(canonical(rows.map((r) => ({ ...r }))))
}

const DATA_TAGS = ["0001_library_integrity", "0002_book_versions"]
const LISTING_LIMIT = 50
const pseudonym = (id) => sha256(`biblib-owner:${id}`).slice(0, 12)

/**
 * Revisión de datos previa a 0001/0002, de solo lectura. Devuelve recuentos y una lista
 * restringida (IDs de fila y propietario seudonimizado, sin títulos ni ISBN) con la corrección
 * propuesta. Nunca reasigna ni elimina: las correcciones son una operación revisada aparte.
 */
export async function dataPreflight(sql, pending) {
  if (!pending.some((tag) => DATA_TAGS.includes(tag))) return { required: false, code: EXIT.OK, checks: [], items: [] }
  const [present] = await sql`select to_regclass('biblib.books') is not null as books, to_regclass('biblib.shelves') is not null as shelves`
  if (!present.books || !present.shelves) return { required: true, code: EXIT.OK, checks: [{ id: "data.empty", status: "ok", message: "Sin tablas de dominio todavía: no hay datos que revisar." }], items: [] }
  const rules = [
    { id: "data.owner-shelf", status: "fail", correction: "Asignar la ficha a una estantería del mismo propietario (por ejemplo, su predeterminada) con una corrección revisada; books_owner_shelf_fk de 0001 la rechazaría.",
      message: "Fichas cuya estantería no existe o pertenece a otro propietario.",
      query: () => sql`select b.id::text as id, b.user_id::text as owner from biblib.books b left join biblib.shelves s on s.id = b.shelf_id where s.id is null or s.user_id <> b.user_id order by b.id` },
    { id: "data.pages", status: "fail", correction: "Revisar el número de páginas (0–100000); books_pages_check de 0001 lo rechazaría.",
      message: "Fichas con páginas fuera de 0–100000.",
      query: () => sql`select id::text as id, user_id::text as owner from biblib.books where number_of_pages < 0 or number_of_pages > 100000 order by id` },
    { id: "data.book-title", status: "fail", correction: "Completar o acortar el título (1–500 caracteres sin espacios extremos); books_title_check de 0001 lo rechazaría.",
      message: "Fichas con título vacío o de más de 500 caracteres.",
      query: () => sql`select id::text as id, user_id::text as owner from biblib.books where length(btrim(title)) not between 1 and 500 order by id` },
    { id: "data.shelf-title", status: "fail", correction: "Completar o acortar el nombre de la estantería (1–120 caracteres); shelves_title_check de 0001 lo rechazaría.",
      message: "Estanterías con nombre vacío o de más de 120 caracteres.",
      query: () => sql`select id::text as id, user_id::text as owner from biblib.shelves where length(btrim(title)) not between 1 and 120 order by id` },
    { id: "data.isbn-duplicate", status: "warn", correction: "Revisar con su propietario si son ejemplares distintos o un duplicado que fusionar; la migración no lo bloquea.",
      message: "Fichas del mismo propietario con el mismo ISBN normalizado (sin guiones ni espacios).",
      query: () => sql`select b.id::text as id, b.user_id::text as owner from biblib.books b join (
          select user_id, upper(regexp_replace(isbn, '[^0-9Xx]', '', 'g')) as normalized from biblib.books
          where regexp_replace(isbn, '[^0-9Xx]', '', 'g') <> '' group by 1, 2 having count(*) > 1) d
        on d.user_id = b.user_id and d.normalized = upper(regexp_replace(b.isbn, '[^0-9Xx]', '', 'g')) order by b.user_id, b.id` },
    { id: "data.shelf-duplicate", status: "warn", correction: "Renombrar o fusionar estanterías que solo difieren en mayúsculas o espacios; la migración no lo bloquea.",
      message: "Estanterías del mismo propietario con el mismo nombre normalizado.",
      query: () => sql`select s.id::text as id, s.user_id::text as owner from biblib.shelves s join (
          select user_id, lower(btrim(title)) as normalized from biblib.shelves group by 1, 2 having count(*) > 1) d
        on d.user_id = s.user_id and d.normalized = lower(btrim(s.title)) order by s.user_id, s.id` },
  ]
  const checks = [], items = []
  for (const rule of rules) {
    const rows = await rule.query()
    checks.push({ id: rule.id, status: rows.length ? rule.status : "ok", count: rows.length, message: rows.length ? `${rule.message} (${rows.length}).` : `${rule.message.replace(/\.$/, "")}: ninguna.`, ...(rows.length ? { correction: rule.correction } : {}) })
    items.push(...rows.slice(0, LISTING_LIMIT).map((r) => ({ check: rule.id, id: r.id, owner: pseudonym(r.owner) })))
  }
  return { required: true, code: checks.some((c) => c.status === "fail") ? EXIT.HISTORY_DIVERGED : EXIT.OK, checks, items, truncatedAt: LISTING_LIMIT }
}

/** Hash del ledger con la misma forma que el recibo de U-OPS-02. */
export function ledgerHash(rows) {
  return sha256(canonical(rows.map((r) => ({ id: r.id, hash: r.hash, created_at: Number(r.created_at) }))))
}

export function receiptHash(receipt) {
  const body = { ...receipt }
  delete body.receiptHash
  return sha256(canonical(body))
}

/** Rutas del recibo: relativas a la raíz (bajo `.biblib/`) o absolutas fuera del repositorio, sin enlaces. */
export function receiptPath(root, file) {
  if (typeof file !== "string" || !file.trim()) fail(EXIT.PLAN_REJECTED, "respaldo", "Falta --backup-receipt <ruta>: la promoción exige un respaldo previo conforme a U-OPS-02.")
  const absolute = path.resolve(root, file)
  const dir = resolveBackupsRoot(root, path.dirname(absolute))
  const resolved = path.join(dir, path.basename(absolute))
  if (existsSync(resolved) && (lstatSync(resolved).isSymbolicLink() || realpathSync.native(resolved) !== resolved)) fail(EXIT.IDENTITY_MISMATCH, "respaldo", "El recibo no puede ser un enlace.")
  return resolved
}

/**
 * Valida el recibo antes de conectar: tipo y sello, destino y huella, head esperado, alcance,
 * cobertura de objetos, estrategia de Auth/Storage/configuración, inventario de archivos con
 * sha256, ensayo de restauración superado y antigüedad. Ausente/caducado/incompleto → 6;
 * de otro destino → 3.
 */
export function validateBackupReceipt(file, { root = REPO_ROOT, target, project, fingerprint, appliedHead, now = new Date(), maxAgeMs = RECEIPT_MAX_AGE_MS }) {
  const reject = (message) => fail(EXIT.PLAN_REJECTED, "respaldo", message)
  const absolute = receiptPath(root, file)
  if (!existsSync(absolute)) reject("No existe el recibo de respaldo indicado.")
  let receipt
  try { receipt = JSON.parse(readFileSync(absolute, "utf8")) } catch { reject("El recibo de respaldo no es JSON válido.") }
  if (receipt?.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND || !/^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]+$/.test(receipt.backupId ?? "")) reject("El documento no es un recibo de respaldo administrativo de BibLib (un JSON de cuenta no sirve).")
  if (receipt.receiptHash !== receiptHash(receipt)) reject("El recibo fue alterado: su sello no coincide.")
  if (receipt.target?.target !== target || receipt.target?.project !== project || receipt.fingerprint !== fingerprint) fail(EXIT.IDENTITY_MISMATCH, "respaldo", "El recibo corresponde a otro destino (objetivo, proyecto o huella distintos).")
  if ((receipt.migrations?.head ?? null) !== (appliedHead?.tag ?? null)) reject(`El respaldo es del head ${receipt.migrations?.head ?? "vacío"}, no del head actual del plan (${appliedHead?.tag ?? "vacío"}); respalda de nuevo.`)
  if (!/^[0-9a-f]{64}$/.test(receipt.migrations?.ledgerHash ?? "") || !/^[0-9a-f]{64}$/.test(receipt.objects?.hash ?? "")) reject("El recibo no incluye las huellas de ledger y de objetos del destino.")
  const missingScope = RECEIPT_SCOPE.filter((s) => !receipt.scope?.includes(s))
  if (missingScope.length) reject(`El recibo no cubre el alcance obligatorio: ${missingScope.join(", ")}.`)
  const missingCoverage = RECEIPT_COVERAGE.filter((c) => !receipt.objects?.coverage?.includes(c))
  if (missingCoverage.length) reject(`El recibo no acredita estos objetos: ${missingCoverage.join(", ")}.`)
  for (const key of ["auth", "storage", "configuration"]) if (typeof receipt.strategy?.[key] !== "string" || !receipt.strategy[key].trim()) reject(`El recibo no declara la estrategia de ${key}.`)
  const created = Date.parse(receipt.createdAt)
  if (!Number.isFinite(created) || created > now.getTime() + 60000) reject("La fecha del respaldo no es válida.")
  if (now.getTime() - created > maxAgeMs) reject(`El respaldo tiene más de ${Math.round(maxAgeMs / 3600000)} h; repite el respaldo y su ensayo antes de promover.`)
  if (!Array.isArray(receipt.files) || !receipt.files.length) reject("El recibo no inventaría ningún archivo.")
  for (const item of receipt.files) {
    const artifact = receiptPath(root, item?.path)
    if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? "") || !existsSync(artifact) || sha256(readFileSync(artifact)) !== item.sha256) reject("Un archivo del respaldo falta o no coincide con su sha256.")
  }
  if (receipt.manifest) {
    const manifestFile = receiptPath(root, receipt.manifest.path)
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")) } catch { reject(`El recibo apunta a un ${MANIFEST_FILE} ilegible.`) }
    if (manifestHash(manifest) !== receipt.manifest.contentHash || manifest.contentHash !== receipt.manifest.contentHash) reject("El manifiesto del respaldo no coincide con el recibo.")
  }
  const rehearsal = receipt.restoreVerification
  if (!rehearsal?.passed) reject("El respaldo no tiene un ensayo de restauración superado; restáuralo en una copia aislada y verifícalo antes de promover.")
  const report = receiptPath(root, rehearsal.report)
  let parsed
  try { parsed = existsSync(report) && sha256(readFileSync(report)) === rehearsal.reportSha256 ? JSON.parse(readFileSync(report, "utf8")) : null } catch { parsed = null }
  if (!parsed?.passed || parsed.backupId !== receipt.backupId) reject("El informe del ensayo de restauración falta, no coincide con su sha256 o no es de este respaldo.")
  return { receipt, backupId: receipt.backupId, receiptHash: receipt.receiptHash, createdAt: receipt.createdAt, ledgerHash: receipt.migrations.ledgerHash, objectsHash: receipt.objects.hash, rehearsal: { reportId: rehearsal.reportId, at: rehearsal.at } }
}

/** Ya bajo bloqueo: el destino no cambió desde el respaldo (ledger y hechos de catálogo). */
export function assertReceiptMatchesDatabase(validated, { ledgerRows, objectsHash }) {
  if (ledgerHash(ledgerRows) !== validated.ledgerHash) fail(EXIT.PLAN_REJECTED, "respaldo", "El ledger del destino cambió desde el respaldo; respalda de nuevo antes de promover.")
  if (objectsHash !== validated.objectsHash) fail(EXIT.PLAN_REJECTED, "respaldo", "El esquema del destino cambió desde el respaldo (hechos de catálogo distintos); respalda de nuevo.")
}
