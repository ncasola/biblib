// Ensayo de U-INF-07 sin destino remoto: un Postgres 17 efímero propio hace de «remoto» con un
// certificado TLS autofirmado para db.<ref>.supabase.co. El runner verifica el certificado contra
// ese nombre (verify-full) y solo la resolución del host se redirige a 127.0.0.1 mediante la
// dependencia `resolveHost`, que la CLI no expone. Nunca usa .env ni credenciales reales.
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { objectFacts } from "../../scripts/lib/backup-db.mjs"
import { checkBackupFiles } from "../../scripts/lib/backup-files.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { canonical } from "../../scripts/db/plan.mjs"
import { ledgerHash, RECEIPT_COVERAGE, RECEIPT_KIND, receiptHash } from "../../scripts/db/remote-preflight.mjs"
import { inspectDatabase } from "../../scripts/db/target.mjs"

export const repo = fileURLToPath(new URL("../../", import.meta.url))
export const IMAGE = "postgres:17-alpine"
export const LABEL = "biblib.unit=u-inf-07-ensayo"
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

// --- Certificado X.509 autofirmado (DER mínimo) para no depender de openssl. ---
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  const length = body.length < 0x80 ? Buffer.from([body.length]) : (() => { const bytes = []; for (let n = body.length; n; n >>= 8) bytes.unshift(n & 0xff); return Buffer.from([0x80 | bytes.length, ...bytes]) })()
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const seq = (...p) => der(0x30, ...p)
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split(".").map(Number)
  const out = [40 * a + b]
  for (const n of rest) { const bytes = [n & 0x7f]; for (let v = n >> 7; v; v >>= 7) bytes.unshift(0x80 | (v & 0x7f)); out.push(...bytes) }
  return der(0x06, Buffer.from(out))
}
const integer = (buf) => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf)
const utcTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`))
const name = (cn) => seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))))
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"))

/** Certificado autofirmado (CA:TRUE, SAN = hostname) y su clave PKCS#8 en PEM. */
export function selfSignedCertificate(hostname, now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const serial = randomBytes(8); serial[0] = (serial[0] & 0x7f) | 0x01
  const san = seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, Buffer.from(hostname)))))
  const basic = seq(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff])))))
  const tbs = seq(der(0xa0, integer(Buffer.from([2]))), integer(serial), ECDSA_SHA256, name(hostname), seq(utcTime(new Date(now - 3600e3)), utcTime(new Date(now + 2 * 86400e3))), name(hostname), publicKey.export({ type: "spki", format: "der" }), der(0xa3, seq(san, basic)))
  const certificate = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" })))
  const pem = (label, data) => `-----BEGIN ${label}-----\n${data.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`
  return { cert: pem("CERTIFICATE", certificate), key: privateKey.export({ type: "pkcs8", format: "pem" }) }
}

// --- Docker: solo contenedores propios, etiquetados y eliminados por ID. ---
function docker(args, input) {
  return execFileSync("docker", args, { cwd: repo, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).trim()
}

export function dockerAvailable() {
  const result = spawnSync("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], { encoding: "utf8", windowsHide: true, timeout: 20000 })
  return result.status === 0
}

// Sustituto mínimo de Supabase (el mismo de test:db) más el rol anon y los esquemas de plataforma.
const PLATFORM_SQL = `${readFileSync(path.join(repo, "tests/db/bootstrap.sql"), "utf8")}
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;
-- bootstrap.sql ya crea un Storage mínimo desde U-DAT-10 (0009 instala su bucket y sus políticas).
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY);
`

/**
 * Arranca un Postgres efímero. `tls`: certificado para el nombre indicado (o null: servidor sin
 * TLS). Devuelve el entorno inyectado del objetivo remoto, `resolveHost` y utilidades psql.
 */
export async function startRemote({ ref, certificateFor = `db.${ref}.supabase.co`, tls = true, platform = true } = {}) {
  const password = randomUUID()
  const workdir = mkdtempSync(path.join(tmpdir(), "biblib-inf07-"))
  const material = tls ? selfSignedCertificate(certificateFor) : null
  const caFile = path.join(workdir, "ca.pem")
  if (material) writeFileSync(caFile, material.cert)
  const containerName = `biblib-inf07-${process.pid}-${randomUUID().slice(0, 8)}`
  const tlsArgs = material ? ["-c", "ssl=on", "-c", "ssl_cert_file=/tls/server.crt", "-c", "ssl_key_file=/tls/server.key"] : []
  const script = material
    ? 'set -e; mkdir -p /tls; printf %s "$BIBLIB_TLS_CERT" | base64 -d > /tls/server.crt; printf %s "$BIBLIB_TLS_KEY" | base64 -d > /tls/server.key; chown postgres:postgres /tls/server.crt /tls/server.key; chmod 600 /tls/server.key; unset BIBLIB_TLS_CERT BIBLIB_TLS_KEY; exec docker-entrypoint.sh "$@"'
    : 'exec docker-entrypoint.sh "$@"'
  const id = docker(["run", "--rm", "--detach", "--name", containerName, "--label", LABEL, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`,
    ...(material ? ["--env", `BIBLIB_TLS_CERT=${Buffer.from(material.cert).toString("base64")}`, "--env", `BIBLIB_TLS_KEY=${Buffer.from(material.key).toString("base64")}`] : []),
    "--entrypoint", "sh", IMAGE, "-c", script, "postgres", "postgres", ...tlsArgs])
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker no devolvió un ID de contenedor válido.")
  const remote = { id, name: containerName, ref, password, workdir, caFile: material ? caFile : null }
  remote.psql = (sql, options) => psql(remote, sql, options)
  try {
    let ready = false
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      ready = spawnSync("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres"], { stdio: "ignore", windowsHide: true }).status === 0
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error("El Postgres de ensayo no respondió.")
    const port = Number(/:(\d+)$/.exec(docker(["port", id, "5432/tcp"]).split(/\r?\n/)[0])[1])
    Object.assign(remote, { port, host: `db.${ref}.supabase.co` })
    if (platform) remote.psql(PLATFORM_SQL)
  } catch (error) { stopRemote(remote); throw error }
  return remote
}

/** Ejecuta SQL de administración dentro del contenedor (socket local, sin credenciales en argv). */
function psql(remote, sql, { database = "postgres" } = {}) {
  return docker(["exec", "-i", remote.id, "psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], sql)
}

export function stopRemote(remote) {
  if (remote?.id) spawnSync("docker", ["rm", "--force", "--volumes", remote.id], { stdio: "ignore", windowsHide: true })
  if (remote?.workdir) rmSync(remote.workdir, { recursive: true, force: true })
}

export function remoteEnv(remote, overrides = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: `https://${remote.ref}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "clave-publica-de-ensayo",
    SUPABASE_DB_URL: `postgresql://postgres:${remote.password}@db.${remote.ref}.supabase.co:5432/postgres`,
    BIBLIB_EXPECT_PROJECT_REF: remote.ref,
    SUPABASE_DB_SSLMODE: "verify-full",
    ...(remote.caFile ? { SUPABASE_DB_SSLROOTCERT: remote.caFile } : {}),
    ...overrides,
  }
}

/** Solo redirige el host esperado del proyecto al puerto publicado; cualquier otro host falla. */
export function resolverFor(remote) {
  return (host) => {
    if (host !== remote.host) throw new Error(`Host no previsto en el ensayo: ${host}`)
    return { host: "127.0.0.1", port: remote.port }
  }
}

// Conexión administrativa directa (sin TLS) para preparar escenarios; nunca la usa el runner.
export function adminClient(remote) {
  return postgres({ host: "127.0.0.1", port: remote.port, database: "postgres", username: "postgres", password: remote.password, ssl: remote.caFile ? { rejectUnauthorized: true, ca: readFileSync(remote.caFile), servername: remote.host } : false, max: 1, onnotice: () => {} })
}

/** Aplica los SQL del journal hasta `tag` incluido, a mano (sin ledger): simula un esquema manual. */
export function applyManually(remote, tag) {
  for (const entry of loadJournal(path.join(repo, "drizzle")).entries) {
    remote.psql(readFileSync(entry.file, "utf8").replaceAll("--> statement-breakpoint", ""))
    if (entry.tag === tag) return
  }
}

/** Datos sintéticos de dos cuentas A/B, con IDs fijos para comprobar que se conservan. */
export const SYNTHETIC = Object.freeze({
  users: ["0a000000-0000-4000-8000-00000000000a", "0b000000-0000-4000-8000-00000000000b"],
  shelves: [["5a000000-0000-4000-8000-000000000001", 0, "Estantería principal", true], ["5a000000-0000-4000-8000-000000000002", 0, "Novela", false], ["5b000000-0000-4000-8000-000000000001", 1, "Estantería principal", true]],
  books: [["ba000000-0000-4000-8000-000000000001", 0, "978-84-376-0494-7", "Ficción de prueba A1", 320, 0], ["ba000000-0000-4000-8000-000000000002", 0, "978 84 376 0494 7", "Ficción de prueba A2", 120, 1], ["bb000000-0000-4000-8000-000000000001", 1, "978-0-306-40615-7", "Ensayo de prueba B1", 210, 2]],
})

export function seedSynthetic(remote, { extra = "" } = {}) {
  const { users, shelves, books } = SYNTHETIC
  remote.psql(`insert into auth.users (id) values ${users.map((u) => `('${u}')`).join(", ")};
insert into biblib.shelves (id, user_id, title, is_default) values ${shelves.map(([id, u, title, d]) => `('${id}', '${users[u]}', '${title}', ${d})`).join(", ")};
insert into biblib.books (id, user_id, isbn, title, number_of_pages, shelf_id) values ${books.map(([id, u, isbn, title, pages, shelf]) => `('${id}', '${users[u]}', '${isbn}', '${title}', ${pages}, '${shelves[shelf][0]}')`).join(", ")};
${extra}`)
}

// --- Respaldo y ensayo de restauración del «remoto» simulado. ---

/**
 * Productor de recibos SOLO de ensayo: el respaldo remoto real depende del plan del proveedor y
 * está pendiente. Vuelca biblib/biblib_migrations y auth.users dentro del contenedor, mide ledger y hechos
 * de catálogo por la conexión del runner y escribe un recibo con el mismo contrato.
 */
export async function rehearsalBackup(remote, { root = repo, target, project, fingerprint, sql, now = new Date() }) {
  const backupId = `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-ensayo-${randomBytes(3).toString("hex")}`
  const dir = path.join(root, ".biblib", "backups", backupId)
  mkdirSync(path.join(dir, "db"), { recursive: true })
  const dump = (args) => docker(["exec", remote.id, "pg_dump", "-U", "postgres", "-d", "postgres", "--quote-all-identifiers", ...args])
  const files = []
  const add = (role, relative, content) => {
    writeFileSync(path.join(dir, ...relative.split("/")), content, { flag: "wx" })
    files.push({ path: path.relative(root, path.join(dir, ...relative.split("/"))).split(path.sep).join("/"), role, bytes: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) })
  }
  const facts = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const inspection = await inspectDatabase(tx, loadJournal(path.join(repo, "drizzle")))
    return { inspection, objects: await objectFacts(tx) }
  })
  add("auth-data", "db/auth-users.sql", `${dump(["--data-only", "--table", "auth.users"])}\n`)
  add("domain-dump", "db/biblib-drizzle.sql", `${dump(["--schema", "biblib", "--schema", "biblib_migrations"])}\n`)
  const receipt = {
    schemaVersion: 1, kind: RECEIPT_KIND, backupId, createdAt: now.toISOString(), completedAt: new Date().toISOString(),
    target: { target, profile: null, project }, fingerprint, commit: null,
    migrations: { head: facts.inspection.appliedHead?.tag ?? null, applied: facts.inspection.migrations.filter((m) => m.status === "applied").map((m) => m.tag), ledgerHash: ledgerHash(facts.inspection.ledger.rows) },
    scope: ["schema", "data", "history", "domain", "ledger", "auth", "storage"],
    strategy: { auth: "Ensayo: datos de auth.users del sustituto mínimo; en Supabase real, procedimiento administrativo del proveedor.", storage: "Ensayo sin objetos Storage; en Supabase real, copia de objetos aparte (U-OPS-02).", configuration: "Configuración de Auth/OAuth/SMTP/JWT fuera del respaldo; se reconfigura desde el gestor de credenciales." },
    objects: { hash: facts.objects.hash, coverage: [...RECEIPT_COVERAGE] },
    files, restoreVerification: null, rehearsalOnly: true,
  }
  return { dir, backupId, receipt, write: () => writeReceipt(dir, receipt) }
}

function writeReceipt(dir, receipt) {
  const final = { ...receipt }
  delete final.receiptHash
  final.receiptHash = receiptHash(final)
  const file = path.join(dir, "receipt.json")
  writeFileSync(file, `${JSON.stringify(final, null, 2)}\n`)
  return file
}

/**
 * Ensayo de restauración del recibo en otro Postgres efímero: plataforma mínima, Auth, dominio y
 * ledger; después ledger, manifest y hechos de catálogo idénticos al recibo. Si pasa, el recibo
 * referencia el informe con su sha256 (como `restoreVerification` de U-OPS-02).
 */
export async function rehearseRestore(backup, { root = repo } = {}) {
  const copy = (await startRemote({ ref: "copiaaislada01", tls: false, platform: false }))
  try {
    copy.psql(PLATFORM_SQL)
    for (const role of ["auth-data", "domain-dump"]) {
      const file = backup.receipt.files.find((f) => f.role === role)
      copy.psql(readFileSync(path.join(root, file.path), "utf8"))
    }
    // Desde 0009 el bucket de portadas y sus políticas de storage.objects se reinstalan tras el volcado
    // de dominio, como hace db:restore:local (el volcado de biblib/biblib_migrations no los contiene).
    copy.psql("DO $$ BEGIN IF to_regprocedure('biblib.cover_storage_install()') IS NOT NULL THEN PERFORM biblib.cover_storage_install(); END IF; END $$;")
    // Desde 0014, igual con el bucket privado de imágenes (`biblib-media`).
    copy.psql("DO $$ BEGIN IF to_regprocedure('biblib.media_storage_install()') IS NOT NULL THEN PERFORM biblib.media_storage_install(); END IF; END $$;")
    const sql = adminClient(copy)
    let report
    try {
      const restored = await sql.begin("read only", async (tx) => ({ inspection: await inspectDatabase(tx, loadJournal(path.join(repo, "drizzle"))), objects: await objectFacts(tx) }))
      const checks = [
        { id: "ledger", status: ledgerHash(restored.inspection.ledger.rows) === backup.receipt.migrations.ledgerHash ? "ok" : "fail" },
        { id: "manifest", status: restored.inspection.state === "adoption-required" || (restored.inspection.code === 0 && restored.inspection.manifest.every((c) => c.status === "ok")) ? "ok" : "fail", state: restored.inspection.state },
        { id: "objects.facts", status: restored.objects.hash === backup.receipt.objects.hash ? "ok" : "fail" },
      ]
      report = { schemaVersion: 1, kind: "biblib-restore-report", reportId: randomUUID(), backupId: backup.backupId, passed: checks.every((c) => c.status === "ok"), checks, target: { target: "copia-aislada", container: copy.name }, finishedAt: new Date().toISOString() }
    } finally { await sql.end({ timeout: 5 }) }
    const reportFile = path.join(backup.dir, "rehearsal.json")
    const body = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(reportFile, body)
    backup.receipt.restoreVerification = { passed: report.passed, reportId: report.reportId, report: path.relative(root, reportFile).split(path.sep).join("/"), reportSha256: sha256(body), at: report.finishedAt, target: report.target }
    return { report, file: backup.write() }
  } finally { stopRemote(copy) }
}

export { checkBackupFiles, canonical }
