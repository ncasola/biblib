import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { setupSuite } from "../lib/suite.mjs"

// Solo existen cuentas ficticias del censo: la suite no crea usuarios ni usa proveedores externos.
// El runner compara además la lista completa de cuentas antes y después de la ejecución.

let s

before(async () => { s = await setupSuite() })
after(() => s?.close())

test("Auth del perfil test solo contiene las cuentas ficticias A/B del censo, sin identidades externas", async () => {
  const { data, error } = await s.admin().auth.admin.listUsers({ page: 1, perPage: 1000 })
  assert.equal(error, null)
  const users = data.users
  assert.ok(users.length >= 2)
  for (const user of users) {
    assert.ok(user.email.endsWith("@biblib.test"), "Toda cuenta local usa el dominio reservado de pruebas.")
    assert.equal(user.user_metadata.biblib_fixture, s.ctx.census.censusId)
    assert.ok((user.identities ?? []).every((identity) => identity.provider === "email"), "Sin identidades de Google ni otros proveedores.")
  }
  for (const account of s.ctx.census.accounts) {
    assert.equal(users.find((u) => u.email === account.email)?.id, s.ctx.users[account.key], "Los IDs coinciden con el registro privado del seed.")
  }
})

test("el correo local solo se entrega a Mailpit y a destinatarios @biblib.test", async () => {
  const response = await fetch(`http://127.0.0.1:${s.ctx.ports.mailpit}/api/v1/messages`, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  const messages = (await response.json()).messages ?? []
  assert.ok(messages.every((message) => (message.To ?? []).every((to) => to.Address.endsWith("@biblib.test"))))
})
