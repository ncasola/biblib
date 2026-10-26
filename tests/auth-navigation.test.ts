import assert from "node:assert/strict"
import { test } from "node:test"
import { getSafeRedirectPath, isProtectedPath } from "../lib/auth-navigation"

test("rechaza destinos externos, protocolos, controles y variantes de barra inversa", () => {
  for (const value of [
    undefined, null, "", "https://example.com", "//example.com", "///example.com/path",
    "javascript:alert(1)", "\\example.com", "/\\example.com", "/\n/example.com", "/\t/example.com", "/\u0000example.com",
  ]) {
    assert.equal(getSafeRedirectPath(value), "/", String(value))
  }
})

test("conserva ruta, consulta y fragmento internos para recuperar el contexto", () => {
  assert.equal(getSafeRedirectPath("/books?search=Quijote&status=unread#resultados"), "/books?search=Quijote&status=unread#resultados")
  assert.equal(getSafeRedirectPath("/book/123"), "/book/123")
  assert.equal(getSafeRedirectPath("/books?next=https://example.com"), "/books?next=https://example.com")
})

test("evita volver al acceso o callback y normaliza segmentos de la ruta", () => {
  for (const value of ["/login", "/signup?next=/books", "/auth/callback", "/forgot-password", "/books/../login"]) {
    assert.equal(getSafeRedirectPath(value), "/")
  }
})

test("protege inicio y detalles sin confundir prefijos de rutas ajenas", () => {
  for (const path of ["/", "/books", "/books/add", "/book/123", "/shelves/3d", "/series", "/series/123", "/loans", "/profile", "/settings"]) {
    assert.equal(isProtectedPath(path), true, path)
  }
  for (const path of ["/login", "/auth/callback", "/api/books/search", "/bookshelf", "/loans-extra", "/settings-extra", "/logo.png"]) {
    assert.equal(isProtectedPath(path), false, path)
  }
})
