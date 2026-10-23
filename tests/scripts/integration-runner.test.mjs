import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { parseArgs, redactor, suiteBatches } from "../integration/run.mjs"
import { decodeActionResponse } from "../integration/lib/app.mjs"
import { applySetCookies, readSession, withExpiredAccess } from "../integration/lib/sessions.mjs"
import { cleanupManifest } from "../integration/lib/run-manifest.mjs"

// Piezas del runner de test:integration:local (U-QA-01) que no necesitan Docker ni stack.

test("integración: solo admite el perfil test y --reuse-build", () => {
  assert.deepEqual(parseArgs([]), { profile: "test", reuseBuild: false })
  assert.deepEqual(parseArgs(["--profile", "test", "--reuse-build"]), { profile: "test", reuseBuild: true })
  for (const argv of [["--profile", "main"], ["--profile", "scratch"], ["--url", "postgres://x"], ["--reuse-build", "--reuse-build"]]) {
    assert.throws(() => parseArgs(argv), { code: EXIT.INVALID_ARGS })
  }
})

test("integración: la salida enmascara JWT, cookies SSR y secretos conocidos", () => {
  const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(30)}.${"c".repeat(40)}`
  const redact = redactor(["contraseña-fixture-muy-larga-123"])
  const line = redact(`actual: '${jwt}' cookie base64-${"Z".repeat(40)} clave contraseña-fixture-muy-larga-123 "refresh_token":"abc123def"`)
  assert.ok(!line.includes(jwt) && !line.includes("Z".repeat(40)) && !line.includes("contraseña-fixture") && !line.includes("abc123def"))
  assert.match(line, /\[jwt oculto\]/)
})

test("integración: la caída de servicios se ejecuta sola y al final", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "biblib-int-"))
  try {
    for (const [dir, file] of [["auth", "caida-servicios.test.mjs"], ["auth", "sesion.test.mjs"], ["rls", "acciones-ab.test.mjs"], ["storage", "fixtures.test.mjs"], ["storage", "notas.md"]]) {
      mkdirSync(path.join(root, "tests/integration", dir), { recursive: true })
      writeFileSync(path.join(root, "tests/integration", dir, file), "")
    }
    const batches = suiteBatches(root)
    assert.equal(batches.length, 2)
    assert.deepEqual(batches[1], [path.join("tests", "integration", "auth", "caida-servicios.test.mjs")])
    assert.equal(batches[0].length, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("integración: decodifica respuestas RSC de acciones, referencias, texto largo y errores", () => {
  const ok = Buffer.from('0:{"a":"$@1","q":"","i":false,"b":"x"}\n1:{"ok":true,"value":{"id":"1","title":"$$precio","sub":"$undefined","nota":"$2"}}\n2:T6,héroe')
  assert.deepEqual(decodeActionResponse(ok), { value: { ok: true, value: { id: "1", title: "$precio", sub: undefined, nota: "héroe" } }, thrown: false })
  const thrown = Buffer.from('0:{"a":"$@1","q":"","i":false,"b":"x"}\n1:E{"digest":"123"}\n')
  assert.deepEqual(decodeActionResponse(thrown), { value: undefined, thrown: true })
  assert.throws(() => decodeActionResponse(Buffer.from('0:{"a":"$Q1"}\n')), { code: EXIT.VERIFICATION_FAILED })
})

test("integración: la sesión SSR se envejece sin tocar los tokens y se aplican Set-Cookie", () => {
  const session = { access_token: "acceso", refresh_token: "renovar", expires_at: 4102444800, user: { id: "u" } }
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
  const chunks = [{ name: "sb-127-auth-token.0", value: encoded.slice(0, 20) }, { name: "sb-127-auth-token.1", value: encoded.slice(20) }, { name: "otra", value: "1" }]
  assert.deepEqual(readSession(chunks), session)
  const expired = withExpiredAccess(chunks)
  assert.deepEqual(expired.map((c) => c.name).sort(), ["otra", "sb-127-auth-token"])
  const aged = readSession(expired)
  assert.ok(aged.expires_at < Date.now() / 1000)
  assert.equal(aged.refresh_token, "renovar")
  const applied = applySetCookies(expired, ["sb-127-auth-token=base64-nuevo; Path=/; SameSite=lax", "otra=; Path=/; Max-Age=0"])
  assert.deepEqual(applied, [{ name: "sb-127-auth-token", value: "base64-nuevo" }])
})

test("integración: la limpieza solo borra lo registrado por el run y conserva lo que no puede", async () => {
  const statements = []
  const sql = (strings, ...values) => {
    statements.push({ text: strings.join("?"), values })
    if (strings.join("?").includes("count(*)")) return Promise.resolve([{ books: values[0] === "estanteria-con-libros" ? 1 : 0 }])
    if (strings.join("?").includes("raw_user_meta_data")) return Promise.resolve([{ present: false }])
    return Promise.resolve([])
  }
  const removed = []
  const admin = {
    storage: { from: () => ({ remove: async (paths) => { removed.push(...paths); return { error: null } } }) },
    auth: { admin: { updateUserById: async () => ({ error: null }) } },
  }
  const manifest = { runId: "0123456789ab", created: {
    books: [{ id: "libro", userId: "u" }],
    shelves: [{ id: "estanteria", userId: "u" }, { id: "estanteria-con-libros", userId: "u" }],
    objects: [{ bucket: "biblib-test-assets", path: "qa-01/0123456789ab/sonda.webp" }, { bucket: "biblib-test-assets", path: "fixtures/portada.webp" }],
    metadata: [{ userId: "u", key: "qa01_relleno" }, { userId: "u", key: "full_name" }],
  } }
  const pending = await cleanupManifest({ sql, admin, manifest })
  assert.deepEqual(removed, ["qa-01/0123456789ab/sonda.webp"])
  assert.deepEqual(pending, {
    books: [], objects: [{ bucket: "biblib-test-assets", path: "fixtures/portada.webp" }],
    shelves: [{ id: "estanteria-con-libros", userId: "u" }], metadata: [{ userId: "u", key: "full_name" }],
  })
  const deletes = statements.filter((s) => s.text.startsWith("delete"))
  assert.ok(deletes.every((s) => s.text.includes("user_id = ?") && s.text.includes("title like ?")), "Cada borrado exige propietario y marca del run.")
  assert.ok(deletes.every((s) => s.values.includes("[QA-01 0123456789ab]%")))
})
