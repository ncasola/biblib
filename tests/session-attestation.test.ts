import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { test } from "node:test"
import {
  ATTESTATION_MAX_AGE_MS, createRequestMemo, createSessionAttestation, unverifiedSubject, verifySessionAttestation,
} from "../lib/supabase/session-attestation"

// U-FIX-02 · Atestación de sesión del proxy y memo por petición. Sin red ni Next.

const USER_A = "4f0b6a52-0c55-4b8e-9b51-6d1f1a8c0a01"
const USER_B = "9a3e1c77-2d44-4f6a-8b0e-3c5d7e9f1b02"
const TOKEN_A = `header.${Buffer.from(JSON.stringify({ sub: USER_A })).toString("base64url")}.firma-a`
const TOKEN_B = "header.payload-b.firma-b"
const NONCE = "bm9uY2UtZGUtbGEtcGV0aWNpb24="
const NOW = 1_800_000_000_000

const attest = (overrides: Partial<Parameters<typeof createSessionAttestation>[0]> = {}) =>
  createSessionAttestation({ userId: USER_A, accessToken: TOKEN_A, nonce: NONCE, now: NOW, ...overrides })
const check = (value: string | null, overrides: Partial<Parameters<typeof verifySessionAttestation>[1]> = {}) =>
  verifySessionAttestation(value, { accessToken: TOKEN_A, nonce: NONCE, now: NOW + 5, ...overrides })

test("una atestación del proxy para este token, usuario y petición se acepta y devuelve el usuario", () => {
  assert.deepEqual(check(attest()), { ok: true, userId: USER_A })
  assert.deepEqual(check(attest(), { now: NOW + ATTESTATION_MAX_AGE_MS }), { ok: true, userId: USER_A })
})

test("sin cabecera o con una cabecera falsificada por el cliente no hay atestación", () => {
  assert.deepEqual(check(null), { ok: false, reason: "missing" })
  assert.deepEqual(check(""), { ok: false, reason: "missing" })
  for (const forged of ["v1", USER_A, `v1.${NOW}.${Buffer.from(NONCE).toString("base64url")}.${USER_A}`, "v2.1.2.3.4", `v1.${NOW}.x.no-es-un-uuid.abc`]) {
    assert.equal(check(forged).ok, false, `Rechazada: ${forged}`)
  }
  const [version, issuedAt, nonce, user] = attest().split(".")
  const randomMac = [version, issuedAt, nonce, user, randomBytes(32).toString("base64url")].join(".")
  assert.deepEqual(check(randomMac), { ok: false, reason: "signature" })
})

test("una atestación firmada por otro proceso (otra clave) se rechaza", () => {
  assert.deepEqual(check(attest({ key: randomBytes(32) })), { ok: false, reason: "signature" })
  assert.deepEqual(check(attest(), { key: randomBytes(32) }), { ok: false, reason: "signature" })
})

test("la atestación de otro token o de otro usuario no sirve: no se puede cambiar el sujeto", () => {
  assert.deepEqual(check(attest(), { accessToken: TOKEN_B }), { ok: false, reason: "signature" })
  assert.deepEqual(check(attest({ accessToken: TOKEN_B })), { ok: false, reason: "signature" })
  const parts = attest().split(".")
  parts[3] = USER_B
  assert.deepEqual(check(parts.join(".")), { ok: false, reason: "signature" }, "Cambiar el usuario invalida la firma.")
  assert.equal(check(attest(), { accessToken: "" }).ok, false, "Sin token en la petición no hay atestación.")
})

test("caducada (más de 30 s) o fechada en el futuro se rechaza", () => {
  assert.deepEqual(check(attest(), { now: NOW + ATTESTATION_MAX_AGE_MS + 1 }), { ok: false, reason: "expired" })
  assert.deepEqual(check(attest({ now: NOW + 60_000 })), { ok: false, reason: "expired" })
})

test("reutilizada en otra petición (otro nonce) o sin nonce de petición se rechaza", () => {
  assert.deepEqual(check(attest(), { nonce: "b3RyYS1wZXRpY2lvbg==" }), { ok: false, reason: "nonce" })
  assert.deepEqual(check(attest(), { nonce: null }), { ok: false, reason: "nonce" })
  assert.deepEqual(check(attest(), { nonce: undefined }), { ok: false, reason: "nonce" })
})

test("dos atestaciones del mismo proceso para peticiones distintas no son intercambiables", () => {
  const first = attest({ nonce: "cGV0aWNpb24tMQ==" })
  const second = attest({ nonce: "cGV0aWNpb24tMg==" })
  assert.notEqual(first, second)
  assert.equal(check(first, { nonce: "cGV0aWNpb24tMg==" }).ok, false)
  assert.equal(check(second, { nonce: "cGV0aWNpb24tMg==" }).ok, true)
})

test("el sujeto sin verificar del JWT solo se usa para comprobar coherencia y tolera tokens corruptos", () => {
  assert.equal(unverifiedSubject(TOKEN_A), USER_A)
  assert.equal(unverifiedSubject("a.b.c"), null)
  assert.equal(unverifiedSubject(""), null)
  assert.equal(unverifiedSubject(`h.${Buffer.from(JSON.stringify({ sub: 7 })).toString("base64url")}.s`), null)
})

test("memo por petición: dentro de la misma petición y token se verifica una sola vez", async () => {
  const memo = createRequestMemo<string>()
  const request = {}
  let calls = 0
  const verify = async () => { calls++; return USER_A }
  const results = await Promise.all([memo(request, TOKEN_A, verify), memo(request, TOKEN_A, verify), memo(request, TOKEN_A, verify)])
  assert.deepEqual(results, [USER_A, USER_A, USER_A])
  assert.equal(calls, 1)
})

test("memo por petición: no se comparte entre peticiones", async () => {
  const memo = createRequestMemo<string>()
  let calls = 0
  const verify = async () => { calls++; return USER_A }
  await memo({}, TOKEN_A, verify)
  await memo({}, TOKEN_A, verify)
  assert.equal(calls, 2, "Cada petición verifica la suya aunque el token sea el mismo.")
})

test("memo por petición: no se comparte entre usuarios ni tokens, ni siquiera en la misma petición", async () => {
  const memo = createRequestMemo<string>()
  const request = {}
  assert.equal(await memo(request, TOKEN_A, async () => USER_A), USER_A)
  assert.equal(await memo(request, TOKEN_B, async () => USER_B), USER_B)
  assert.equal(await memo(request, TOKEN_A, async () => USER_B), USER_A, "El resultado sigue ligado a su token.")
  assert.equal(await memo({}, TOKEN_B, async () => USER_A), USER_A, "Otra petición no hereda el usuario de B.")
})

test("memo por petición: un rechazo se mantiene en su petición y no contamina las siguientes", async () => {
  const memo = createRequestMemo<string>()
  const request = {}
  let calls = 0
  const failing = async () => { calls++; throw new Error("sesión caducada") }
  await assert.rejects(memo(request, TOKEN_A, failing))
  await assert.rejects(memo(request, TOKEN_A, async () => USER_A), /sesión caducada/)
  assert.equal(calls, 1)
  assert.equal(await memo({}, TOKEN_A, async () => USER_A), USER_A)
})
