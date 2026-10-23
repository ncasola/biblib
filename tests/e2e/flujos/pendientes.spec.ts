import { test } from "../lib/fixtures"

// Grupos de U-QA-02 que dependen de unidades futuras. Son esqueletos `test.fixme`: aparecen como
// pendientes en el informe, nunca como superados, y cada uno nombra la unidad que lo activará.
// Al cerrar esa unidad se sustituye el fixme por el recorrido real (criterio de «terminada»).

const pending = (unit: string, title: string) => test.fixme(`${title} · se activa con ${unit}`, async () => {})

test.describe("Catálogo · modelo nuevo", () => {
  pending("U-DAT-06", "dos copias de la misma edición y libro sin ISBN como ejemplares")
})

test.describe("Importación · pendientes", () => {
  pending("U-DAT-04", "fallo durante la publicación sin datos parciales")
  pending("U-DAT-02", "deshacer una importación con conflictos posteriores")
})

test.describe("Trabajos", () => {
  pending("U-DAT-03", "cerrar y reabrir el navegador con un trabajo en curso")
  pending("U-DAT-03", "worker interrumpido y lease vencido")
  pending("U-DAT-03", "pausa, cancelación y reintento idempotente")
})

test.describe("Copias multipart", () => {
  pending("U-DAT-04", "archivo v1 y formato nuevo en la misma restauración")
  pending("U-DAT-04", "partes fuera de orden, repetida, ausente o alterada")
  pending("U-DAT-04", "restauración sin pérdida de IDs definidos")
})

test.describe("Proveedores · BNE y Google Books", () => {
  pending("U-BIB-02", "un proveedor vacío y otro disponible (Open Library + BNE)")
  pending("U-BIB-02", "429, timeout y 5xx distinguidos de «no encontrado»")
  pending("U-BIB-04", "edición discrepante entre proveedores")
  pending("U-BIB-03", "clave de Google Books ausente")
  pending("U-DAT-05", "presupuesto global agotado")
})

test.describe("Privacidad · pendientes", () => {
  pending("U-DAT-10", "objetos privados por propietario")
  pending("U-OPS-03", "borrado de cuenta")
  pending("U-EXP-08", "copia offline bloqueada para otra cuenta")
})

test.describe("Producto", () => {
  pending("U-PRO-01", "notas, etiquetas y valoración")
  pending("U-PRO-02", "ciclos y progreso de lectura")
  pending("U-PRO-04", "préstamos")
  pending("U-PRO-03", "ubicación física")
  pending("U-PRO-05", "series y volúmenes")
})
