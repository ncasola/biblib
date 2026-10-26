import { test } from "../lib/fixtures"

// O16-FIX: correspondencia de los antiguos fixme con cobertura real de las unidades integradas.
// U-DAT-06 (dos copias, sin ISBN): integration/model/ejemplares.test.mjs, casos 1 y 3.
// U-DAT-04 (fallo atómico): integration/restore/conjuntos.test.mjs, «un error en la última sentencia…».
// U-DAT-02 (deshacer con conflicto): integration/snapshots/versiones.test.mjs, «una segunda pestaña…».
// U-DAT-03 (reabrir): integration/jobs/acciones.test.mjs, «crear, recargar y continuar…», nueva sesión GoTrue.
// U-DAT-03 (worker/lease): integration/jobs/trabajadores.test.mjs, «matar el trabajador…» y «lease vencido…».
// U-DAT-03 (pausa/cancelación/reintento): jobs/acciones.test.mjs + jobs/importacion.test.mjs.
// U-DAT-04 (v1/v2): restore/conjuntos.test.mjs, «partes v1 y v2 mezcladas…»: se rechazan según contrato.
// U-DAT-04 (orden/repetida/ausente/alterada): restore/conjuntos.test.mjs, primeros dos casos + «repetir una parte…».
// U-DAT-04 (IDs): snapshots/versiones.test.mjs, «deshacer devuelve datos y referencias con IDs propios…»;
//   model/ejemplares.test.mjs, «un libro sin ISBN…» e «importar un v2 con dos copias…».
// U-DAT-10 (privacidad): integration/assets/acceso.test.mjs, «A sube y adjunta… B no puede obtenerla ni firmarla…».
// U-OPS-03 (borrado): integration/account/worker.test.mjs + restore.test.mjs, supresión y no resurrección.
// U-PRO-01: flujos/personal.spec.ts (4 recorridos).
// U-PRO-03: flujos/ubicaciones.spec.ts (árbol, asignación, foto privada).
// U-PRO-05: flujos/series.spec.ts (4 recorridos).
// Ejecuciones y límites: docs/validacion/2026-10-26/O16/fix/informe.md.

test.describe("Proveedores · escenarios de configuración pendientes", () => {
  test.fixme("edición discrepante entre proveedores · dueño U-BIB-04", async () => {
    // No hay un fixture del servidor con dos proveedores que entreguen ediciones discrepantes para el
    // mismo ISBN. Requiere ampliar ese contrato de fixtures; interceptar la API no acredita al orquestador.
    // La lógica está cubierta por tests/bibliography-review.test.ts, pero eso no es un E2E.
  })
  test.fixme("clave de Google Books ausente · dueño U-BIB-03", async () => {
    // El E2E arranca con catálogo fixture y Google apagado: no permite alterar la configuración del
    // servidor por caso. Hace falta un arranque dedicado live con red simulada y Google habilitado sin
    // clave; bibliographic-catalog-google.test.ts cubre la lógica unitaria, sin sustituir ese arranque.
  })
})
