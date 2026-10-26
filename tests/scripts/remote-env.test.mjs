import assert from "node:assert/strict"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { parseRemoteEnv, remoteCaFile, remoteEnvFile, remoteEnvFromVercel, withRemoteEnvFile, writeRemoteEnv } from "../../scripts/db/remote-env.mjs"
import { describeRemote, probeRemote } from "../../scripts/db/remote-preflight.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib remote env "))
  roots.push(dir)
  return dir
}

const ref = "abcdefghijklmnopqrst"
const pulled = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-simulation-only",
  SUPABASE_DB_URL: `postgresql://postgres.${ref}:credencial-ficticia@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
}

test("sin archivo se usa el entorno de la sesión tal cual", () => {
  const env = { PATH: "x", SUPABASE_DB_URL: "inyectada" }
  assert.equal(withRemoteEnvFile("prod", { env, root: root() }), env)
})

test("desde Vercel: referencia derivada, pooler en modo sesión, verify-full y CA junto al archivo", () => {
  const dir = root()
  const first = remoteEnvFromVercel("prod", pulled, { root: dir })
  assert.equal(first.ref, ref)
  assert.equal(new URL(first.values.SUPABASE_DB_URL).port, "5432")
  assert.equal(new URL(first.values.SUPABASE_DB_URL).search, "")
  assert.equal(first.values.SUPABASE_DB_SSLMODE, "verify-full")
  assert.equal(first.values.SUPABASE_DB_SSLROOTCERT, undefined)
  assert.ok(first.notes.some((note) => note.includes("prod-ca.crt")))
  assert.ok(first.notes.every((note) => !note.includes("credencial-ficticia")))
  mkdirSync(path.dirname(remoteCaFile("prod", dir)), { recursive: true })
  writeFileSync(remoteCaFile("prod", dir), "-----BEGIN CERTIFICATE-----\n")
  assert.equal(remoteEnvFromVercel("prod", pulled, { root: dir }).values.SUPABASE_DB_SSLROOTCERT, "prod-ca.crt")
  assert.throws(() => remoteEnvFromVercel("prod", { ...pulled, SUPABASE_DB_URL: "" }, { root: dir }), (error) => error.code === EXIT.INVALID_ARGS && error.message.includes("SUPABASE_DB_URL"))
})

test("el archivo generado pasa la identidad remota sin variables en la sesión", () => {
  const dir = root()
  mkdirSync(path.join(dir, "supabase"))
  for (const file of ["config.toml", "profiles.json"]) copyFileSync(path.join(repo, "supabase", file), path.join(dir, "supabase", file))
  mkdirSync(path.join(dir, ".biblib/remote"), { recursive: true })
  writeFileSync(remoteCaFile("prod", dir), "-----BEGIN CERTIFICATE-----\n")
  const { values } = remoteEnvFromVercel("prod", pulled, { root: dir })
  const file = writeRemoteEnv("prod", values, { root: dir })
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
  const env = withRemoteEnvFile("prod", { env: { PATH: "x" }, root: dir })
  assert.equal(env.PATH, "x")
  assert.equal(env.SUPABASE_DB_SSLROOTCERT, remoteCaFile("prod", dir))
  const remote = describeRemote("prod", { env, expectProject: ref, cwd: dir })
  assert.equal(remote.project, ref)
  assert.equal(remote.descriptor.port, 5432)
  assert.equal(remote.descriptor.connection, "pooler-session")
  assert.equal(remote.descriptor.tls.rootCert, "ca-explicita")
  assert.throws(() => describeRemote("prod", { env, expectProject: "otroproyecto", cwd: dir }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
})

test("TLS: con el pooler cuenta la verificación del cliente; en conexión directa, pg_stat_ssl", async () => {
  const facts = { version_num: 150008, version: "15.8", role: "postgres", replica: false, ssl: false, tls_version: null, create_schema: true, auth_schema: true, storage_schema: true, auth_references: true }
  const fake = () => { let calls = 0; return async () => (calls++ === 0 ? [facts] : []) }
  const tls = (probe) => probe.checks.find((c) => c.id === "remote.tls")
  assert.equal(tls(await probeRemote(fake(), { connection: "pooler-session", host: "aws-0-eu-west-1.pooler.supabase.com" })).status, "ok")
  const direct = await probeRemote(fake(), { connection: "direct" })
  assert.equal(tls(direct).status, "fail")
  assert.equal(direct.code, EXIT.IDENTITY_MISMATCH)
})

test("rechaza mezclar fuentes, claves ajenas, duplicados y enlaces", () => {
  const dir = root()
  const file = remoteEnvFile("prod", dir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `BIBLIB_EXPECT_PROJECT_REF="${ref}"\n`, { mode: 0o600 })
  assert.throws(() => withRemoteEnvFile("prod", { env: { SUPABASE_DB_URL: "inyectada" }, root: dir }), (error) => error.code === EXIT.INVALID_ARGS && !error.message.includes("inyectada"))
  assert.throws(() => parseRemoteEnv("SUPABASE_SERVICE_ROLE_KEY=x\n", "f"), (error) => error.code === EXIT.INVALID_ARGS)
  assert.throws(() => parseRemoteEnv("SUPABASE_DB_SSLMODE=a\nSUPABASE_DB_SSLMODE=b\n", "f"), (error) => error.code === EXIT.INVALID_ARGS)
  assert.throws(() => parseRemoteEnv("SUPABASE_DB_URL=$(whoami)\n", "f"), (error) => error.code === EXIT.INVALID_ARGS)
  if (process.platform !== "win32") {
    chmodSync(file, 0o644)
    assert.throws(() => withRemoteEnvFile("prod", { env: {}, root: dir }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
    rmSync(file)
    const real = path.join(dir, "real.env")
    writeFileSync(real, "", { mode: 0o600 })
    symlinkSync(real, file)
    assert.throws(() => withRemoteEnvFile("prod", { env: {}, root: dir }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
  }
})
