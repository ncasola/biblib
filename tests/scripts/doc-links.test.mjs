import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { checkDocLinks, extractLinks, relativeTarget, stripCode } from "../../scripts/check-doc-links.mjs"

// U-QA-05 · Enlaces relativos de la documentación hacia la evidencia, sin red.
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "biblib-doc-links-"))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  return root
}

test("extrae enlaces, imágenes y definiciones con su línea e ignora el código", () => {
  const markdown = [
    "Ver [informe](validacion/informe.md#resumen) y ![captura](img/a.png \"título\").",
    "`[no](es-enlace.md)` y texto.",
    "```",
    "[tampoco](bloque.md)",
    "```",
    "[ref]: otra/carpeta",
    "[con espacios](<ruta con espacios.md>)",
  ].join("\n")
  assert.deepEqual(extractLinks(markdown), [
    { target: "validacion/informe.md#resumen", line: 1 },
    { target: "img/a.png", line: 1 },
    { target: "otra/carpeta", line: 6 },
    { target: "ruta con espacios.md", line: 7 },
  ])
  assert.equal(stripCode("a `b` c").trim(), "a  c")
})

test("solo comprueba destinos relativos y sin anclaje", () => {
  assert.equal(relativeTarget("https://supabase.com/docs"), null)
  assert.equal(relativeTarget("mailto:alguien@biblib.test"), null)
  assert.equal(relativeTarget("#seccion"), null)
  assert.equal(relativeTarget("../operacion.md#migraciones"), "../operacion.md")
  assert.equal(relativeTarget("ruta%20codificada.md"), "ruta codificada.md")
})

test("detecta enlaces rotos y los que salen del repositorio, y acepta archivos y carpetas existentes", () => {
  const root = fixture({
    "docs/operacion.md": "[ok](validacion/O16/informe.md) [carpeta](validacion/O16) [externo](https://example.test) [roto](validacion/falta.md#x)",
    "docs/validacion/O16/informe.md": "[subir](../../operacion.md#ciclo) [fuera](../../../../fuera.md) [mal](operacion.md)",
    "README.md": "[docs](docs/operacion.md)",
    "notas.txt": "[ignorado](nada.md)",
  })
  try {
    const result = checkDocLinks({ root, targets: ["docs", "README.md"] })
    assert.equal(result.files, 3)
    assert.equal(result.links, 7)
    assert.deepEqual(result.broken, [
      { file: "docs/operacion.md", line: 1, target: "validacion/falta.md#x", reason: "no existe" },
      { file: "docs/validacion/O16/informe.md", line: 1, target: "../../../../fuera.md", reason: "fuera del repositorio" },
      { file: "docs/validacion/O16/informe.md", line: 1, target: "operacion.md", reason: "no existe" },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
