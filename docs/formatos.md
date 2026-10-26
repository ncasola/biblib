# Formatos de copia y procedencia

**Unidades:** U-BIB-04 (ola O09) y U-DAT-06 (ola O12: capacidad completa de v2 con el modelo de ejemplares). **Contratos:** [02 · Contratos transversales y U-DAT-06](spec-pendientes/02-datos-importacion-y-catalogacion.md), [06 · U-BIB-04](spec-pendientes/06-proveedores-bibliograficos.md) y [A06](spec-pendientes/README.md#a06--formatos-y-compatibilidad).

BibLib separa cuatro versiones que no se deducen unas de otras:

| Versión | Dónde | Qué versiona | Estado |
| --- | --- | --- | --- |
| Sin versión (`{ books, shelves }`) | Copia JSON antigua | Formato legacy anterior a v1 | Se lee. No se escribe. |
| `formatVersion: 1` | Copia JSON | Libros planos + estanterías | Se lee. Se escribe solo si no pierde datos. |
| `formatVersion: 2` | Copia JSON | Obras/ediciones/copias/estanterías (payload portable) | Se lee y se escribe. |
| `bundleVersion: 1` | Manifest de un conjunto de partes | Integridad, orden y cantidades de las partes | Se lee y se escribe (U-DAT-04). Ver [conjunto de partes](#conjunto-de-partes-bundleversion-1). |
| Sin `schemaVersion` | `catalogue` de cada ficha | Procedencia legacy (una fuente por ficha) | Se lee y se escribe. |
| `catalogue.schemaVersion: 2` | `catalogue` de cada ficha | Procedencia por campo y fuentes ampliadas (BNE) | Se lee siempre; se escribe según la bandera de revisión. |

`Book.version` y los tokens de ejemplar y edición (UUID) son tokens de concurrencia: nunca se exportan en v2 y, si aparecen en un v1, se ignoran. Restaurar una copia genera tokens nuevos.

El código vive en `lib/library-import.ts` (lector común), `lib/library-export.ts` (escritores y elección de formato), `lib/backup-v2.ts` (payload v2 y adaptador legacy) y `lib/catalogue-provenance.ts` (procedencia).

## Formato legacy y v1

```json
{ "formatVersion": 1, "exportedAt": "2026-10-23T10:00:00.000Z",
  "books": [{ "id": "…", "isbn": "9788401337208", "title": "…", "authors": [{ "name": "…" }],
              "number_of_pages": 872, "publish_date": "2009", "cover": { "small": "…", "medium": "…", "large": "…" },
              "status": "read", "shelf_id": "…", "shelf_name": "…",
              "catalogue": { "source": "open-library", "isbnVerified": false, "sourceUrl": "https://…" } }],
  "shelves": [{ "id": "…", "title": "…", "book_count": 1, "isDefault": true }] }
```

- El formato legacy es el mismo objeto sin `formatVersion` ni `exportedAt`. Un v1 exige `exportedAt`.
- **Una fila es un ejemplar con su propia edición** (U-DAT-06): el fixture sintético de 111 fichas produce 111 ejemplares y 111 ediciones. El texto `isbn` pasa a ISBN-13 canónico si es un ISBN-10/13 válido; si no (`manual-…` u otro valor), se conserva como identificador legacy del ejemplar y la edición queda sin ISBN. Dos filas con el mismo ISBN siguen siendo un duplicado: v1 no expresa varias copias de una edición.
- Libro sin `catalogue`: se lee como `{ "source": "import", "isbnVerified": false }`. Nunca como `manual`.
- `isbnVerified` ausente se lee como `false`. Solo se conserva `true` si el ISBN es válido.
- Los writers solo han escrito `source`, `isbnVerified` y `sourceUrl` en `catalogue`. Cualquier otra clave se rechaza en lugar de descartarse.
- Los lectores actuales aceptan también `catalogue.schemaVersion: 2` dentro de un v1 o legacy. La vista previa de importación de U-DAT-01 guarda la colección en forma legacy y debe conservar la procedencia. Los writers v1 no lo emiten.

## Payload portable `formatVersion: 2`

Es el esquema canónico del modelo de obra, edición y ejemplar (U-DAT-06). U-BIB-04 lo creó como adaptador sobre la tabla legacy; desde 0011 se lee y se escribe con su capacidad completa. No existe otro contenido llamado v2: un v2 con un array `books` se rechaza.

```json
{
  "formatVersion": 2,
  "exportedAt": "2026-10-25T10:00:00.000Z",
  "requiredCapabilities": ["works.entities", "copies.multiple-per-edition", "copies.verification-evidence", "editions.identifiers"],
  "works": [{ "id": "…", "title": "Crónica del asesino de reyes" }],
  "editions": [{
    "id": "…", "work_id": "…", "isbn13": "9788401337208",
    "title": "…", "subtitle": "…", "authors": [{ "name": "…" }], "publishers": [{ "name": "…" }],
    "publish_date": "2009", "number_of_pages": 872, "cover": { "small": "…", "medium": "…", "large": "…" },
    "catalogue": { "source": "manual" }, "language": "es", "identifiers": { "openLibrary": ["OL1M"] }
  }, {
    "id": "…", "work_id": null, "isbn13": null, "title": "Libro sin ISBN", "authors": [], "publish_date": "",
    "number_of_pages": 0, "cover": { "small": "…", "medium": "…", "large": "…" }, "catalogue": { "source": "manual" }
  }],
  "copies": [
    { "id": "<ID del ejemplar>", "edition_id": "…", "status": "read", "shelf_id": "…",
      "edition_verification": { "isbnVerified": true, "checkedAt": "2026-10-20T10:00:00.000Z", "evidenceRefs": ["foto:lomo-1"] }, "legacy_identifier": null },
    { "id": "<otro ejemplar>", "edition_id": "<la misma edición>", "status": "to-read", "shelf_id": "…",
      "edition_verification": { "isbnVerified": false }, "legacy_identifier": null },
    { "id": "…", "edition_id": "<la edición sin ISBN>", "status": "unread", "shelf_id": "…",
      "edition_verification": { "isbnVerified": false }, "legacy_identifier": null }
  ],
  "shelves": [{ "id": "…", "title": "…", "isDefault": true }]
}
```

- **Ejemplar** (`copies`): conserva el ID de la ficha legacy (las rutas `/book/[id]` no cambian), su estado, estantería, comprobación física (`edition_verification`) e identificador legacy. Varios ejemplares pueden compartir edición.
- **Edición** (`editions`): descripción bibliográfica, portada, procedencia por campo (`catalogue`, que nunca lleva `isbnVerified`), idioma e identificadores externos. `isbn13` es el ISBN-13 canónico o `null`: un libro sin ISBN se exporta y se restaura con `null`, sin identificador inventado. Un ejemplar de una edición con ISBN no lleva `legacy_identifier`.
- **Obra** (`works`): solo con evidencia explícita (un archivo v2 o una decisión de la persona); la migración no deduce ninguna. Una obra sin ediciones no se conserva.
- Una ficha legacy exportada antes de 0011 tiene `edition.id = copy.id`; el backfill de 0010 conservó esos IDs. Una fusión posterior de ediciones devuelve un mapeo explícito.
- `publishers` y `subtitle` solo aparecen si la ficha los tenía, para que la ida y vuelta sea exacta. Las estanterías no llevan `book_count`: el lector lo recalcula.
- Al partir una colección grande, una edición con ejemplares en varias partes aparece en cada parte que los contiene, con los mismos datos; la restauración por partes lo comprueba.

**Capacidades.** Cada payload declara en `requiredCapabilities` lo que usa. Este lector conserva todas las conocidas; si un archivo usa una sin declararla, o declara una desconocida, se rechaza.

| Capacidad | Significado |
| --- | --- |
| `catalogue.provenance-v2` | Alguna edición usa `catalogue.schemaVersion: 2`. |
| `works.entities` | Hay obras y ediciones que las citan. |
| `copies.multiple-per-edition` | Alguna edición tiene más de un ejemplar. |
| `copies.verification-evidence` | Alguna comprobación física lleva `checkedAt` o `evidenceRefs`. |
| `editions.identifiers` | Alguna edición lleva `identifiers` o `language`. |

Un lector anterior a U-DAT-06 (U-BIB-04) rechaza las cuatro últimas con explicación: no trunca copias ni descarta campos.

### Qué rechaza el lector v2 y por qué

Todos los rechazos ocurren antes de escribir. Nada se importa parcialmente y ningún campo se descarta en silencio.

| Entrada | Motivo |
| --- | --- |
| Capacidad desconocida, o una conocida usada sin declararla | El archivo necesita un lector distinto o está mal construido. |
| Dos ediciones con el mismo `isbn13` | Una cuenta tiene una edición canónica por ISBN-13: se revisan como candidatos o se fusionan, nunca se crean dos. |
| Copias de una misma edición con datos bibliográficos distintos (entre partes) | No es una edición coherente. |
| Edición sin copias u obra sin ediciones | BibLib no conserva entidades huérfanas. |
| Copia que cita una edición inexistente, o edición que cita una obra inexistente | Referencia rota. |
| `isbn13` y `legacy_identifier` a la vez, o comprobación física sin ISBN | Un ejemplar de una edición con ISBN no conserva otro identificador; no se comprueba un ISBN que no existe. |
| `isbn13` con dígito de control incorrecto | No es un ISBN. No se inventa uno. |
| Claves o secciones desconocidas (`loans`…) | No se pueden conservar. El mensaje nombra las claves. |
| `formatVersion` distinto de 1 o 2 | Versión no compatible. |

Después, un v2 pasa por las mismas validaciones que v1 (límites, IDs, estanterías existentes y una sola predeterminada) y alimenta el mismo plan de importación (reglas versión 2): las filas con la misma edición crean una edición y sus ejemplares; al fusionar se omite un ejemplar cuyo ISBN-13 o identificador ya está en la cuenta, o el mismo ejemplar de la cuenta (un libro sin ISBN se reconoce por su ID); al reemplazar se conservan los IDs propios reconocidos de ejemplar, edición y obra.

## Procedencia: `catalogue`

```ts
// Legacy (sin schemaVersion)
{ source: "manual" | "open-library" | "photo" | "import", isbnVerified: boolean, sourceUrl?: string }

// schemaVersion: 2
{ schemaVersion: 2, source: "manual" | "open-library" | "photo" | "import" | "bne",
  isbnVerified: boolean, sourceUrl?: string,
  fields?: Partial<Record<"title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover", FieldProvenance>> }

interface FieldProvenance {
  provider: "manual" | "open-library" | "bne" | "photo" | "import"
  sourceUrl?: string        // HTTPS
  recordId?: string
  retrievedAt?: string      // ISO 8601
  selection: "user-selected" | "manually-verified" | "unverified"
}
```

- **`isbnVerified`** significa que una persona comprobó el ISBN frente a su ejemplar físico. Su ausencia en datos legacy vale `false`. Ni un proveedor, ni un ISBN coincidente, ni un dígito de control válido lo activan. Con un ISBN inválido o manual siempre es `false`.
- **`isbnChecksumValid`** se deriva al leer (`normalizeIsbn`) y no se persiste. Si llega en un archivo se ignora y se recalcula.
- **`source`** conserva la fuente primaria legacy. En v2 es la del título si viene de una fuente. Así se puede escribir un v1 sin pérdida cuando no hay `fields` ni BNE.
- **Fuentes desconocidas.** Un valor que no está en el enum se rechaza con explicación y nunca se convierte en `manual`. Al mostrar una ficha ya guardada aparece como «Fuente no reconocida (…)».
- **Google Books** (`google-books`) no forma parte del enum de procedencia hasta que U-BIB-03 entregue su lector y validador. Se rechaza al importar y al guardar. Sus portadas nunca se persisten: como mucho, una vista previa temporal si su política `previewCover` lo permite (hoy no).
- **BNE** solo existe con `schemaVersion: 2`. Un `source: "bne"` legacy se rechaza.

## Escritura y bandera `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED`

Por defecto vale `false`. Primero se despliegan los lectores (esta unidad) y después se activan los writers v2.

| Operación | Bandera `false` | Bandera `true` |
| --- | --- | --- |
| Alta desde el formulario actual | v1 como hasta ahora. Un `catalogue` v2 se rechaza (`INVALID_INPUT`), no se recorta. Un resultado BNE se avisa y se guarda como entrada manual. | UI de candidatos: v2 con la fuente de cada campo elegido. |
| Edición | Una ficha v1 sigue en v1. Una ficha v2 **sigue en v2**: los campos cambiados pasan a `manual` y el resto conserva su fuente. | Igual. Una ficha v1 pasa a v2 solo si hay algún campo cambiado que registrar. |
| Recuperar portada | Sin cambios en v1. En v2 actualiza `fields.cover`. | Registra `fields.cover` (Open Library). |
| Importar copia | Conserva la procedencia del archivo (v1 o v2). | Igual. |

La procedencia de una edición se calcula en el servidor a partir de la ficha bloqueada y de su `Book.version`. El cliente no puede cambiar la fuente primaria ni los `fields` al editar; solo `isbnVerified`, que es una confirmación humana.

## Elección del formato al exportar

`exportLibraryBackup` en Ajustes:

- **v1** si ninguna ficha necesita v2. Es compatible con versiones anteriores de BibLib.
- **v2** si v1 perdería algo: procedencia BNE o `fields`, varios ejemplares de una edición, obras, evidencias de comprobación, identificadores o idioma de edición, o un libro sin ISBN ni identificador legacy (v1 tendría que inventarle uno). En esos casos v1 no se ofrece (`createLibraryExport` y `fragmentLibraryExport` lanzan un error explicativo). En el manifiesto de un conjunto v2, `totals` cuenta obras, ediciones y copias distintas.

Los límites por archivo son los mismos para ambos formatos: 8 MiB, 2000 libros (copias) y 200 estanterías. Una colección mayor se divide en partes independientes del mismo formato, cada una importable por sí sola, y se acompaña de un manifiesto `bundleVersion: 1` que las agrupa en un conjunto verificable. Desde U-DAT-04 la copia la genera el servidor (`lib/library-export-server.ts`): Ajustes ya no descarga la colección para exportarla.

## Conjunto de partes `bundleVersion: 1`

**Unidad:** U-DAT-04 (ola O11). El manifiesto (`biblib-backup-…-conjunto.json`) acompaña a las partes de una copia y permite restaurarlas todas en una sola operación. Es independiente del payload: cada parte sigue siendo un `formatVersion` 1 o 2 normal, sin cambios.

```json
{
  "kind": "biblib.backup-set",
  "bundleVersion": 1,
  "exportSetId": "…uuid…",
  "exportedAt": "2026-10-24T10:00:00.000Z",
  "payloadFormatVersion": 1,
  "parts": [
    { "partId": "parte-01", "index": 0, "byteLength": 1452311, "sha256": "…64 hex…", "counts": { "books": 2000, "shelves": 3 } },
    { "partId": "parte-02", "index": 1, "byteLength": 1093, "sha256": "…64 hex…", "counts": { "books": 1, "shelves": 4 } }
  ],
  "totals": { "books": 2001, "shelves": 5 }
}
```

- **Hash y tamaño de los bytes exactos.** `sha256` y `byteLength` se calculan sobre los bytes UTF-8 del archivo tal como se descarga, nunca sobre JSON reserializado. Cambiar un solo byte de una parte la hace no coincidir.
- **Orden y claves.** `index` va de 0 a n−1 sin huecos y `partId` es único. Una misma parte dos veces (mismo hash) se rechaza.
- **Cantidades por formato.** En v1, `{ books, shelves }`; en v2, `{ works, editions, copies, shelves }`. `totals` son las cantidades globales únicas: una estantería que aparece en varias partes cuenta una vez, así que `totals.shelves` puede ser menor que la suma.
- **Sin propietario ni firma.** El manifiesto acredita integridad, orden y cantidades, no la autoría. No lleva `user_id`: el dueño siempre sale de la sesión. Las claves desconocidas se rechazan.
- **Límites del conjunto:** 10 000 libros, 1 000 estanterías, 80 MiB y 50 partes. Superarlos da `LIMIT_EXCEEDED` antes de aceptar ningún byte.
- **Partes sueltas.** Las partes v1 o v2 existentes sin manifiesto se pueden restaurar juntas con el asistente de Ajustes. El servidor las inspecciona, comprueba que encajan (formato común, sin libros ni ISBN repetidos, estanterías compatibles, una sola predeterminada) y genera el manifiesto. Que compartan fecha no demuestra que sean de la misma copia: la persona lo confirma expresamente.
- **Rechazos** (`MANIFEST_MISMATCH`, 422, sin modificar la colección): parte ausente, duplicada, corrupta o de otro conjunto; cantidades o totales que no coinciden con el contenido; la misma estantería con otro nombre en otra parte; dos estanterías distintas con el mismo nombre; más de una predeterminada.

El código vive en `lib/import-manifest.ts` (formato y comprobaciones puras), `lib/library-export.ts` (`buildBackupSet`) y `lib/import-staging.ts` (validación del conjunto en staging). El proceso de restauración se describe en [operación](operacion.md#restauración-por-partes-con-staging-y-publicación-atómica--u-dat-04).

Las versiones de BibLib anteriores a U-BIB-04 rechazan `formatVersion: 2` con un mensaje de versión no compatible. Por eso el v1 se sigue ofreciendo siempre que no pierde datos.

## Portadas privadas (U-DAT-10)

- **Copias JSON (v1 y v2).** No contienen imágenes privadas ni su referencia: exportan las URL originales de la ficha (`cover`), que se conservan aunque se muestre una copia privada. La interfaz lo advierte en la ficha. La imagen privada solo se recupera con el respaldo administrativo o desde la cuenta.
- **Respaldo administrativo** (`backup.json`, desde 0009). Lleva un manifiesto `assets` separado de los bytes. Los objetos van en `storage/` con su sha256, como el resto de Storage:

```json
"assets": {
  "bucket": "biblib-covers",
  "providers": [],
  "items": [
    { "id": "…uuid…", "owner": "…uuid…", "key": "<dueño>/<asset>/<intento>.webp", "sha256": "…64 hex…", "bytes": 120022, "state": "ready", "sourceKind": "upload", "provider": "upload", "included": true }
  ],
  "excluded": []
}
```

- **Exclusiones.** `providers` lista los proveedores cuya política publicada permite `rehostCover` y `backupAsset`; hoy, ninguno. Una copia de proveedor fuera de la lista va con `included: false` y su motivo (`policy`, o `google`, que nunca entra). Ni su objeto se copia ni su fila se restaura.
- **Comprobación.** Cada objeto copiado debe coincidir en sha256 y tamaño con su asset. El manifiesto no contiene títulos, ISBN ni URL firmadas.

## Pruebas

- `tests/backup-v2.test.ts`: payload canónico, ida y vuelta v1→v2→v1 y v2→v2 con `tests/fixtures/import/sintetico-111.json`, rechazos explicados, Google y fuentes desconocidas, `isbnVerified`, partes v2 y plan de U-DAT-01.
- `tests/catalogue-provenance.test.ts`: writers con y sin bandera, edición concurrente con `Book.version` y revisión de colección.
- `tests/library-import.test.ts`: lectores legacy y v1 existentes.
- `tests/backup-v2.test.ts` (U-DAT-06): capacidad completa (varias copias por edición, obras, evidencias, identificadores e idioma) en ida y vuelta v2 sin pérdida, libro sin ISBN con `null`, exigencia de v2 cuando v1 perdería datos y rechazo de capacidades no declaradas.
- `tests/import-plan.test.ts` y `tests/library-snapshots.test.ts` (U-DAT-06): reglas de importación versión 2 (ediciones compartidas, libro sin ISBN reconocido por su ID) y versiones anteriores v1/v2.
- `tests/integration/model/` (U-DAT-06): exportación v2 con un libro sin ISBN y su restauración en otra cuenta con `null`, con la app compilada y sesiones reales.

## Versiones anteriores (U-DAT-06)

El formato interno de una versión anterior es independiente de `formatVersion`. Desde 0011 (`schema_version: 2`) cada entrada es un ejemplar con su edición: `isbn` es el ISBN-13 de la edición o `null` y se añaden `edition_id`, `verification` (comprobación física con sus evidencias) y, si existen, `legacy_identifier`, `work_id`/`work_title`, `language` e `identifiers`. Una versión 1 (anterior a 0011) se restaura como el backfill: su texto `isbn` pasa a ISBN-13 o identificador legacy y dos fichas equivalentes con los mismos datos comparten edición. El hash de los trozos y de la versión no cambia de cálculo.
