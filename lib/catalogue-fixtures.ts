import island from "../tests/fixtures/catalogue/9780000000019.json"
import clock from "../tests/fixtures/catalogue/9780000000026.json"
import lighthouse from "../tests/fixtures/catalogue/9780000000033.json"

// Datos ficticios offline consumidos exclusivamente por el adaptador fixture. 9780000000033 no está en el
// censo A/B: permite al E2E (U-QA-02) recorrer «encontrado → revisar → guardar» sin duplicados.
const responses: Record<string, Record<string, unknown>> = {
  "9780000000019": island,
  "9780000000026": clock,
  "9780000000033": lighthouse,
}

export function readCatalogueFixture(isbn: string): Record<string, unknown> {
  return structuredClone(responses[isbn.replace(/[\s-]/g, "")] ?? {})
}
