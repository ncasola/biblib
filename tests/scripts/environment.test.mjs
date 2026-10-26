import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { assertNoForeignEnvFiles, childEnv, loadTarget, writeLocalEnvFile } from "../../scripts/db/environment.mjs"
import { BiblibError, EXIT } from "../../scripts/lib/exit-codes.mjs"
import { getProfile, profileWorkdir, REPO_ROOT, rootFingerprint } from "../../scripts/lib/profiles.mjs"
import { assertBuildTarget, distDir, runNextTarget } from "../../scripts/next-target.mjs"
import { checkClientBundle, parseBundleArgs } from "../../scripts/check-client-bundle.mjs"
import { parseCredentialArgs, showCredentials } from "../../scripts/db/local-credentials.mjs"
import { spawnSync } from "node:child_process"

const temporaryRoots = []
const secret = "private-password-placeholder"
const admin = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"role":"service_role"}').toString("base64url")}.private-signature`
function checkout() {
  const cwd = mkdtempSync(path.join(tmpdir(), "biblib entorno con espacios "))
  temporaryRoots.push(cwd)
  mkdirSync(path.join(cwd, "supabase"))
  copyFileSync(path.join(REPO_ROOT, "supabase/profiles.json"), path.join(cwd, "supabase/profiles.json"))
  return cwd
}
after(() => {
  const temp = realpathSync.native(tmpdir())
  for (const dir of temporaryRoots) {
    const real = realpathSync.native(dir)
    assert.equal(path.dirname(real), temp)
    assert.ok(path.basename(real).startsWith("biblib entorno con espacios "))
    rmSync(real, { recursive: true, force: true })
  }
})
function localValues(profile = "scratch") {
  const { ports } = getProfile(profile)
  return {
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${ports.api}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-local-fixture-key",
    SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`,
  }
}
function localFile(cwd, { profile = "scratch", values = localValues(profile), name = ".env.local" } = {}) {
  writeFileSync(path.join(cwd, name), [
    `# biblib:generated target=local profile=${profile} root=${rootFingerprint({ root: cwd }).hash}`,
    ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`), "",
  ].join("\n"))
}
function context(cwd = checkout(), target = "test", env = {}) {
  return loadTarget(target, { cwd, profile: "scratch", env: { ...localValues(), ...env } })
}
function rejectsCode(operation, code = EXIT.IDENTITY_MISMATCH) {
  assert.throws(operation, (error) => error instanceof BiblibError && error.code === code)
}

test("target ausente o inválido falla con código 2 antes de acceder al checkout", () => {
  for (const target of [undefined, null, "", "production", "LOCAL", "../prod"]) {
    rejectsCode(() => loadTarget(target, { cwd: "no-existe" }), EXIT.INVALID_ARGS)
    rejectsCode(() => distDir(target), EXIT.INVALID_ARGS)
  }
})

test("local ignora URLs remotas heredadas y usa el perfil exacto con rutas con espacios", () => {
  const cwd = checkout()
  localFile(cwd)
  const previous = process.env.SUPABASE_URL
  process.env.SUPABASE_URL = "https://remoto.example"
  try {
    const ctx = loadTarget("local", { profile: "scratch", cwd })
    assert.equal(ctx.env().SUPABASE_URL, localValues().NEXT_PUBLIC_SUPABASE_URL)
    assert.equal(ctx.env().SUPABASE_DB_URL, localValues().SUPABASE_DB_URL)
    assert.equal(ctx.env().BIBLIB_CATALOGUE_MODE, "fixture")
    assertNoForeignEnvFiles(ctx, { mode: "build" })
    writeFileSync(path.join(cwd, ".env"), "SUPABASE_URL=https://remoto.example\n")
    rejectsCode(() => assertNoForeignEnvFiles(ctx, { mode: "dev" }))
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = previous
  }
})

test("local no usa un env explícito remoto como sustituto del estado del perfil", () => {
  const cwd = checkout()
  rejectsCode(() => loadTarget("local", { cwd, env: { ...localValues(), SUPABASE_URL: "https://remoto.example" } }), EXIT.MISSING_REQUIREMENT)
})

test("localhost, puerto ajeno, usuario distinto y raíz o perfil diferentes no acreditan local", () => {
  const cases = [
    { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:55341" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
    { SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost:55342/postgres" },
    { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" },
    { SUPABASE_DB_URL: "postgresql://otro:postgres@127.0.0.1:55342/postgres" },
    { SUPABASE_DB_URL: "postgresql://postgres:otra@127.0.0.1:55342/postgres" },
  ]
  for (const override of cases) {
    const cwd = checkout()
    localFile(cwd, { values: { ...localValues(), ...override } })
    rejectsCode(() => loadTarget("local", { cwd, profile: "scratch" }))
  }
  const first = checkout(), second = checkout()
  localFile(first)
  copyFileSync(path.join(first, ".env.local"), path.join(second, ".env.local"))
  rejectsCode(() => loadTarget("local", { cwd: second, profile: "scratch" }))
  rejectsCode(() => loadTarget("local", { cwd: first, profile: "main" }))
})

test("test exige env explícito e ignora los archivos privados de la máquina", () => {
  const cwd = checkout()
  writeFileSync(path.join(cwd, ".env.local"), "SUPABASE_DB_URL=privado-no-leer\n")
  rejectsCode(() => loadTarget("test", { cwd }), EXIT.INVALID_ARGS)
  rejectsCode(() => loadTarget("test", { cwd, env: {} }), EXIT.INVALID_ARGS)
  const ctx = context(cwd)
  assert.equal(ctx.env().SUPABASE_DB_URL, localValues().SUPABASE_DB_URL)
  rejectsCode(() => assertNoForeignEnvFiles(ctx, { mode: "build" }))
})

test("preprod/prod exigen identidad inyectada y no recurren a .env.local", () => {
  for (const target of ["preprod", "prod"]) {
    const cwd = checkout()
    localFile(cwd)
    rejectsCode(() => loadTarget(target, { cwd, env: {} }), EXIT.INVALID_ARGS)
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://proyecto-prueba.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-placeholder",
      SUPABASE_DB_URL: `postgresql://postgres:${secret}@db.proyecto-prueba.supabase.co/postgres`,
    }
    rejectsCode(() => loadTarget(target, { cwd, env }), EXIT.INVALID_ARGS)
    rejectsCode(() => loadTarget(target, { cwd, env: { ...env, BIBLIB_EXPECT_PROJECT_REF: "otro-proyecto" } }))
    const ctx = loadTarget(target, { cwd, env: { ...env, BIBLIB_EXPECT_PROJECT_REF: "proyecto-prueba" } })
    assert.equal(ctx.target, target)
    rejectsCode(() => assertNoForeignEnvFiles(ctx, { mode: "build" }))
    const pooled = { ...env, BIBLIB_EXPECT_PROJECT_REF: "proyecto-prueba", SUPABASE_DB_URL: `postgresql://postgres.proyecto-prueba:${secret}@aws-0-region.pooler.supabase.com:6543/postgres` }
    assert.equal(loadTarget(target, { cwd, env: pooled }).target, target)
    rejectsCode(() => loadTarget(target, { cwd, env: { ...pooled, SUPABASE_DB_URL: pooled.SUPABASE_DB_URL.replace("postgres.proyecto-prueba:", "postgres.otro:") } }))
  }
})

test("redacted no contiene contraseñas, userinfo, JWT ni claves", () => {
  const ctx = context(checkout(), "test", {
    SUPABASE_DB_URL: `postgresql://usuario:${secret}@127.0.0.1:55342/postgres`,
    SUPABASE_SERVICE_ROLE_KEY: admin, NEXT_PUBLIC_SUPABASE_ANON_KEY: "private-public-key-placeholder",
    GOOGLE_BOOKS_API_KEY: "google-private-key", OPEN_LIBRARY_CONTACT: "private-contact",
  })
  const redacted = JSON.stringify(ctx.redacted())
  for (const value of [secret, admin, "private-public-key-placeholder", "google-private-key", "private-contact", "usuario", "postgresql://"]) assert.ok(!redacted.includes(value))
  assert.equal(ctx.redacted().fingerprint, ctx.fingerprint)
  const copy = ctx.env()
  copy.SUPABASE_DB_URL = "alterado"
  assert.notEqual(ctx.env().SUPABASE_DB_URL, "alterado")
})

test("childEnv elimina variables heredadas y fija opciones públicas y catálogos", () => {
  const injected = {
    SUPABASE_URL: "https://remoto.example", NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: admin,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "foreign-key", SUPABASE_WORKDIR: "foreign-workdir",
    SUPABASE_EXPERIMENTAL: "true", SUPABASE_CLI_EXPERIMENTAL: "true", SUPABASE_ACCESS_TOKEN: "private-token",
    DATABASE_URL: "postgres://private", PGHOST: "remoto.example", PGPASSWORD: secret,
    POSTGRES_PASSWORD: secret, GOOGLE_BOOKS_API_KEY: "google-private", OPEN_LIBRARY_CONTACT: "private-contact",
    BIBLIB_TARGET: "prod", BIBLIB_CATALOGUE_MODE: "live", NEXT_PUBLIC_ENABLE_ANALYTICS: "true",
  }
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]))
  Object.assign(process.env, injected)
  try {
    const env = childEnv(context())
    for (const key of Object.keys(injected)) assert.notEqual(env[key], injected[key], key)
    assert.equal(env.NEXT_PUBLIC_ENABLE_ANALYTICS, "false")
    assert.equal(env.BIBLIB_TARGET, "test")
    assert.equal(env.BIBLIB_PROFILE, "scratch")
    assert.equal(env.BIBLIB_CATALOGUE_MODE, "fixture")
    assert.equal(env.GOOGLE_BOOKS_API_KEY, "")
    assert.equal(env.OPEN_LIBRARY_CONTACT, "")
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")
    assert.equal(env[pathKey], process.env[pathKey])
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test(".env.local sin marcador se conserva intacto y no se sobrescribe", () => {
  const cwd = checkout()
  localFile(cwd)
  const ctx = loadTarget("local", { cwd, profile: "scratch" })
  const file = path.join(cwd, ".env.local")
  const original = "SUPABASE_URL=https://remoto.example\n"
  writeFileSync(file, original)
  rejectsCode(() => loadTarget("local", { cwd, profile: "scratch" }))
  rejectsCode(() => writeLocalEnvFile(ctx))
  assert.equal(readFileSync(file, "utf8"), original)
})

test("generar local es idempotente y no acepta otros objetivos", () => {
  const cwd = checkout()
  localFile(cwd)
  const ctx = loadTarget("local", { cwd, profile: "scratch" })
  const file = writeLocalEnvFile(ctx)
  const first = readFileSync(file, "utf8")
  writeLocalEnvFile(ctx)
  assert.equal(readFileSync(file, "utf8"), first)
  // Un `pnpm build` sin objetivo también carga .env.local: el catálogo ficticio deducido no se escribe.
  assert.doesNotMatch(first, /BIBLIB_CATALOGUE_MODE/)
  assert.equal(loadTarget("local", { cwd, profile: "scratch" }).env().BIBLIB_CATALOGUE_MODE, "fixture")
  assert.equal(loadTarget("local", { cwd, profile: "scratch" }).fingerprint, ctx.fingerprint)
  assertNoForeignEnvFiles(ctx, { mode: "build" })
  rejectsCode(() => writeLocalEnvFile(context(cwd)))
})

test("detecta todos los archivos que Next y el CLI cargarían en cada modo", () => {
  for (const [mode, name] of [
    ["dev", ".env.development.local"], ["dev", ".env.development"], ["dev", ".env.local"],
    ["build", ".env.production.local"], ["start", ".env.production"], ["build", ".env"],
    ["test", ".env.test.local"], ["test", ".env.test"], ["cli", "supabase/.env"],
  ]) {
    const cwd = checkout(), ctx = context(cwd)
    writeFileSync(path.join(cwd, name), "GOOGLE_BOOKS_API_KEY=private-placeholder\n")
    rejectsCode(() => assertNoForeignEnvFiles(ctx, { mode }))
  }
  for (const name of [".env", "supabase/.env"]) {
    const cwd = checkout(), ctx = context(cwd)
    const workdir = profileWorkdir("scratch", { root: cwd })
    mkdirSync(path.join(workdir, "supabase"), { recursive: true })
    writeFileSync(path.join(workdir, name), "SUPABASE_URL=https://remoto.example\n")
    rejectsCode(() => assertNoForeignEnvFiles(ctx, { mode: "cli" }))
  }
})

test("un marcador válido no autoriza variables extra ni valores distintos al contexto", () => {
  const cwd = checkout()
  localFile(cwd)
  const ctx = loadTarget("local", { cwd, profile: "scratch" })
  for (const values of [
    { ...localValues(), DATABASE_URL: "postgresql://private" },
    { ...localValues(), NEXT_PUBLIC_SUPABASE_URL: "https://remoto.example" },
  ]) {
    localFile(cwd, { values })
    rejectsCode(() => assertNoForeignEnvFiles(ctx))
  }
})

test("huellas estables sin contraseña y distintas por objetivo, proyecto, raíz o clave pública", () => {
  const cwd = checkout()
  localFile(cwd)
  const local = loadTarget("local", { cwd, profile: "scratch" }), fixture = context(cwd)
  assert.notEqual(local.fingerprint, fixture.fingerprint)
  assert.notEqual(local.publicFingerprint, fixture.publicFingerprint)
  assert.equal(fixture.fingerprint, context(cwd).fingerprint)
  assert.equal(fixture.fingerprint, context(cwd, "test", { SUPABASE_DB_URL: localValues().SUPABASE_DB_URL.replace(":postgres@", ":otra@") }).fingerprint)
  assert.notEqual(fixture.fingerprint, context(cwd, "test", { BIBLIB_PROJECT_ID: "otro-proyecto" }).fingerprint)
  assert.notEqual(fixture.fingerprint, context().fingerprint)
  const newKey = context(cwd, "test", { NEXT_PUBLIC_SUPABASE_ANON_KEY: "otra-clave-publica" })
  assert.equal(fixture.fingerprint, newKey.fingerprint)
  assert.notEqual(fixture.publicFingerprint, newKey.publicFingerprint)
})

test("start rechaza un biblib-target.json de otro objetivo/proyecto antes de ejecutar Next", async () => {
  const cwd = checkout(), ctx = context(cwd)
  mkdirSync(path.join(cwd, ".next-test"))
  const file = path.join(cwd, ".next-test/biblib-target.json")
  writeFileSync(path.join(cwd, ".next-test/BUILD_ID"), "fixture-build-id\n")
  for (const artifact of [
    { schemaVersion: 1, target: "prod", publicFingerprint: ctx.publicFingerprint },
    { schemaVersion: 1, target: "test", publicFingerprint: "otra-huella" },
    { schemaVersion: 1, target: "test", publicFingerprint: context(cwd, "test", { BIBLIB_PROJECT_ID: "otro-proyecto" }).publicFingerprint },
    {},
  ]) {
    writeFileSync(file, JSON.stringify({ buildId: "fixture-build-id", ...artifact }))
    rejectsCode(() => assertBuildTarget(ctx))
    await assert.rejects(runNextTarget(["start", "test", "--profile", "scratch"], { cwd, env: localValues() }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
  }
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, target: "test", publicFingerprint: ctx.publicFingerprint, buildId: "fixture-build-id" }))
  assertBuildTarget(ctx)
  // Un build directo de Next posterior tampoco puede reutilizar el recibo anterior.
  writeFileSync(path.join(cwd, ".next-test/BUILD_ID"), "otro-build-id\n")
  rejectsCode(() => assertBuildTarget(ctx))
  writeFileSync(file, "null\n")
  rejectsCode(() => assertBuildTarget(ctx))
  localFile(cwd)
  mkdirSync(path.join(cwd, ".next-local"))
  writeFileSync(path.join(cwd, ".next-local/BUILD_ID"), "fixture-build-id\n")
  writeFileSync(path.join(cwd, ".next-local/biblib-target.json"), JSON.stringify({ schemaVersion: 1, target: "prod", publicFingerprint: ctx.publicFingerprint, buildId: "fixture-build-id" }))
  await assert.rejects(runNextTarget(["start", "local", "--profile", "scratch"], { cwd, env: { SUPABASE_URL: "https://remoto.example" } }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
})

test("wrapper rechaza argumentos y reenvíos arbitrarios con código 2", async () => {
  for (const args of [["build"], ["start", "incorrecto"], ["dev", "local", "--port", "9999"], ["build", "test", "--profile"]]) {
    await assert.rejects(runNextTarget(args), (error) => error.code === EXIT.INVALID_ARGS)
  }
})

test("el inspector de bundle detecta referencias privadas y JWT administrativos sin mostrarlos", () => {
  const cwd = checkout()
  mkdirSync(path.join(cwd, "static/chunks"), { recursive: true })
  const file = path.join(cwd, "static/chunks/app.js")
  for (const content of ["postgresql://usuario:private@host/db", "service_role", "GOOGLE_BOOKS_API_KEY", "SUPABASE_DB_URL", admin]) {
    writeFileSync(file, content)
    assert.throws(() => checkClientBundle(cwd), (error) => error.code === EXIT.VERIFICATION_FAILED && !error.message.includes(content))
  }
  writeFileSync(file, "const publicKey = 'public-placeholder';")
  assert.deepEqual(checkClientBundle(cwd), { files: 1, clean: true })
})

// --- U-LOC-01: acceso local con contraseña (primera puerta, de build) ---

test("childEnv fija NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1 solo en local/test y la vacía en preprod/prod", () => {
  const previous = process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN
  const ref = "abcdefghijklmnop"
  const remote = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-remote-placeholder",
    SUPABASE_DB_URL: `postgresql://postgres:${secret}@db.${ref}.supabase.co:5432/postgres`, BIBLIB_EXPECT_PROJECT_REF: ref,
  }
  try {
    for (const inherited of [undefined, "1", "0", "true"]) {
      if (inherited === undefined) delete process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN
      else process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN = inherited
      assert.equal(childEnv(context(checkout(), "test")).NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN, "1", `test heredada=${inherited}`)
      const cwd = checkout()
      localFile(cwd)
      assert.equal(childEnv(loadTarget("local", { cwd, profile: "scratch" })).NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN, "1", `local heredada=${inherited}`)
      for (const target of ["preprod", "prod"]) {
        const env = childEnv(loadTarget(target, { cwd: checkout(), env: remote }))
        assert.equal(env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN, "", `${target} heredada=${inherited}`)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN
    else process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN = previous
  }
})

test("next.config define la variable pública siempre: 1 en local/test y vacía sin objetivo, preprod y prod", () => {
  const config = (target) => {
    const env = { ...process.env, NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN: "1" }
    delete env.BIBLIB_TARGET
    if (target) env.BIBLIB_TARGET = target
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import c from "./next.config.mjs"; console.log(JSON.stringify(c.env))'], { cwd: REPO_ROOT, env, encoding: "utf8", windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN
  }
  assert.equal(config("local"), "1")
  assert.equal(config("test"), "1")
  for (const target of [undefined, "preprod", "prod"]) assert.equal(config(target), "", String(target))
})

test("check-client-bundle --forbid-local-login detecta los literales del formulario y es opcional", () => {
  const cwd = checkout()
  mkdirSync(path.join(cwd, "static/chunks"), { recursive: true })
  const file = path.join(cwd, "static/chunks/login.js")
  for (const literal of ["biblib-local-password-form", "Acceso local de desarrollo", "signInWithLocalPasswordAction"]) {
    writeFileSync(file, `x("${literal}")`)
    assert.deepEqual(checkClientBundle(cwd), { files: 1, clean: true })
    assert.throws(() => checkClientBundle(cwd, { forbidLocalLogin: true }), (error) => error.code === EXIT.VERIFICATION_FAILED)
  }
  writeFileSync(file, "const login = 'Continuar con Google'")
  assert.deepEqual(checkClientBundle(cwd, { forbidLocalLogin: true }), { files: 1, clean: true })
  assert.deepEqual(parseBundleArgs([]), { distDir: undefined, forbidLocalLogin: false })
  assert.deepEqual(parseBundleArgs(["--forbid-local-login", "--dist-dir", ".next-prod"]), { distDir: ".next-prod", forbidLocalLogin: true })
  for (const args of [["--dist-dir"], ["--forbid-local-login", "--forbid-local-login"], ["--otra"], ["--dist-dir", "--forbid-local-login"]]) {
    assert.throws(() => parseBundleArgs(args), (error) => error.code === EXIT.INVALID_ARGS)
  }
})

// [build] Compila de verdad con placeholders: .next-test debe contener el formulario y .next-prod no.
// Con BIBLIB_SKIP_BUILD_TESTS=1 se omite. No toca `.next`, que usa `pnpm test`.
// Un checkout con `.env`/`.env.local` sin acreditar (p. ej. la configuración privada de Néstor) hace que el
// wrapper rechace el build con exit 3, como debe: esas pruebas se ejecutan en worktrees limpios y en CI.
const foreignEnvFiles = [".env", ".env.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"]
  .filter((name) => { try { return !readFileSync(path.join(REPO_ROOT, name), "utf8").startsWith("# biblib:generated") } catch { return false } })
const skipBuild = process.env.BIBLIB_SKIP_BUILD_TESTS === "1"
  ? "BIBLIB_SKIP_BUILD_TESTS=1"
  : foreignEnvFiles.length > 0 ? `checkout con archivos de entorno sin acreditar (${foreignEnvFiles.join(", ")})` : false
function buildTarget(target, injected) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BIBLIB_|NEXT_PUBLIC_|SUPABASE_)/i.test(key)))
  // Una variable heredada en el shell no debe poder activar el formulario en el build remoto.
  Object.assign(env, { NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN: "1", ...injected })
  const result = spawnSync(process.execPath, ["scripts/next-target.mjs", "build", target], { cwd: REPO_ROOT, env, encoding: "utf8", windowsHide: true, timeout: 540000 })
  assert.equal(result.status, 0, `${target}: ${(result.stderr || result.stdout).slice(-400)}`)
  return path.join(REPO_ROOT, distDir(target))
}

test("[build] build:test con placeholders contiene el formulario local", { skip: skipBuild, timeout: 600000 }, () => {
  const dir = buildTarget("test", {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55331", NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-build-placeholder",
    SUPABASE_DB_URL: "postgresql://postgres:placeholder@127.0.0.1:55332/postgres",
  })
  assert.equal(checkClientBundle(dir).clean, true)
  assert.throws(() => checkClientBundle(dir, { forbidLocalLogin: true }), (error) => error.code === EXIT.VERIFICATION_FAILED && /presente/.test(error.message))
})

test("[build] un build prod simulado no contiene ninguna cadena del formulario local", { skip: skipBuild, timeout: 600000 }, () => {
  const ref = "abcdefghijklmnop"
  const dir = buildTarget("prod", {
    NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-build-placeholder",
    SUPABASE_DB_URL: `postgresql://postgres:placeholder@db.${ref}.supabase.co:5432/postgres`, BIBLIB_EXPECT_PROJECT_REF: ref,
  })
  assert.equal(checkClientBundle(dir, { forbidLocalLogin: true }).clean, true)
})

// --- U-LOC-01: credenciales A/B solo en terminal ---

function credentialDeps({ tty = true, account = { email: "lector-a@biblib.test", password: "p".repeat(32) } } = {}) {
  const chunks = { out: "", err: "" }
  return {
    chunks,
    deps: {
      out: { isTTY: tty, write: (text) => { chunks.out += text } },
      err: { write: (text) => { chunks.err += text } },
      resolve: async () => ({ profile: "scratch" }),
      read: () => ({ accounts: { a: account } }),
      census: () => ({}),
    },
  }
}

test("db:local:credentials valida argumentos y solo admite A/B", () => {
  assert.deepEqual(parseCredentialArgs(["--as", "b", "--profile", "scratch"]), { as: "b", profile: "scratch" })
  for (const args of [[], ["--as", "c"], ["--as", "a", "--as", "b"], ["--as", "a", "--profile", "prod"], ["--as", "a", "--json"], ["--as", "a", "--email", "x@y.z"]]) {
    assert.throws(() => parseCredentialArgs(args), (error) => error instanceof BiblibError && error.code === EXIT.INVALID_ARGS)
  }
})

test("db:local:credentials muestra correo y contraseña solo en una terminal, con aviso y sin escribir archivos", async () => {
  const { chunks, deps } = credentialDeps()
  await showCredentials(["--as", "a", "--profile", "scratch"], deps)
  assert.match(chunks.out, /lector-a@biblib\.test/)
  assert.ok(chunks.out.includes("p".repeat(32)))
  assert.match(chunks.err, /Aviso/)
  assert.ok(!chunks.err.includes("p".repeat(32)), "el aviso no contiene la contraseña")
})

test("db:local:credentials rechaza salida redirigida, otro objetivo y registros ausentes sin mostrar la contraseña", async () => {
  const piped = credentialDeps({ tty: false })
  await assert.rejects(showCredentials(["--as", "a"], piped.deps), (error) => error.code === EXIT.INVALID_ARGS && !error.message.includes("p".repeat(32)))
  assert.equal(piped.chunks.out, "")
  const missing = credentialDeps({ account: null })
  await assert.rejects(showCredentials(["--as", "a"], missing.deps), (error) => error.code === EXIT.SEED_FAILED)
  assert.equal(missing.chunks.out, "")
  const previous = process.env.BIBLIB_TARGET
  process.env.BIBLIB_TARGET = "prod"
  try {
    const remote = credentialDeps()
    await assert.rejects(showCredentials(["--as", "a"], remote.deps), (error) => error.code === EXIT.IDENTITY_MISMATCH)
    assert.equal(remote.chunks.out, "")
  } finally {
    if (previous === undefined) delete process.env.BIBLIB_TARGET
    else process.env.BIBLIB_TARGET = previous
  }
})
