import island from "@/tests/fixtures/catalogue/9780000000019.json"
import clock from "@/tests/fixtures/catalogue/9780000000026.json"

// Datos ficticios offline; U-BIB conectará el modo fixture al servicio de proveedores.
const responses: Record<string, Record<string, unknown>> = {
  "9780000000019": island,
  "9780000000026": clock,
}

export function readCatalogueFixture(isbn: string): Record<string, unknown> {
  return structuredClone(responses[isbn.replace(/[\s-]/g, "")] ?? {})
}
