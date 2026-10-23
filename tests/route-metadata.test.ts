import assert from "node:assert/strict"
import { test } from "node:test"
import { DomainError } from "../lib/domain-errors"
import { PRIVATE_ROBOTS, bookDocumentTitle, bookMetadata, classifyBookTitleError, privateMetadata, siteTitle } from "../lib/route-metadata"

test("el título de la pestaña incluye el del libro solo cuando se ha leído con sesión", () => {
  assert.equal(bookDocumentTitle({ status: "found", title: "Cien años de soledad" }), "Cien años de soledad · BibLib")
  assert.equal(bookDocumentTitle({ status: "found", title: "   " }), "Libro sin título · BibLib")
  assert.equal(bookDocumentTitle({ status: "not-found" }), "Libro no encontrado · BibLib")
  assert.equal(bookDocumentTitle({ status: "unauthenticated" }), "Ficha del libro · BibLib")
  assert.equal(bookDocumentTitle({ status: "unavailable" }), "Ficha del libro · BibLib")
})

test("los errores de lectura distinguen libro inexistente de sesión ausente y nunca llevan título", () => {
  assert.deepEqual(classifyBookTitleError(new DomainError("UNAUTHORIZED", "La sesión ha caducado.")), { status: "unauthenticated" })
  assert.deepEqual(classifyBookTitleError(new DomainError("NOT_FOUND", "No existe.")), { status: "not-found" })
  assert.deepEqual(classifyBookTitleError(new DomainError("INVALID_INPUT", "El identificador no es válido.")), { status: "not-found" })
  assert.deepEqual(classifyBookTitleError(new DomainError("PROVIDER_UNAVAILABLE", "Fallo.")), { status: "unavailable" })
  assert.deepEqual(classifyBookTitleError(new Error("connection refused")), { status: "unavailable" })
  assert.deepEqual(classifyBookTitleError("texto"), { status: "unavailable" })
})

test("las rutas privadas no son indexables y su título es absoluto para no depender de la plantilla heredada", () => {
  assert.deepEqual(PRIVATE_ROBOTS, { index: false, follow: false })
  assert.deepEqual(privateMetadata("Colección"), { title: { absolute: "Colección · BibLib" }, robots: PRIVATE_ROBOTS })
  assert.equal(siteTitle("Agregar libro"), "Agregar libro · BibLib")
  assert.deepEqual(bookMetadata({ status: "found", title: "Rayuela" }), { title: { absolute: "Rayuela · BibLib" }, robots: PRIVATE_ROBOTS })
})
