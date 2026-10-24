# Formatos de copia y procedencia

**Unidad:** U-BIB-04 (ola O09). **Contratos:** [02 · Contratos transversales y U-DAT-06](spec-pendientes/02-datos-importacion-y-catalogacion.md), [06 · U-BIB-04](spec-pendientes/06-proveedores-bibliograficos.md) y [A06](spec-pendientes/README.md#a06--formatos-y-compatibilidad).

BibLib separa cuatro versiones que no se deducen unas de otras:

| Versión | Dónde | Qué versiona | Estado |
| --- | --- | --- | --- |
| Sin versión (`{ books, shelves }`) | Copia JSON antigua | Formato legacy anterior a v1 | Se lee. No se escribe. |
| `formatVersion: 1` | Copia JSON | Libros planos + estanterías | Se lee. Se escribe solo si no pierde datos. |
| `formatVersion: 2` | Copia JSON | Obras/ediciones/copias/estanterías (payload portable) | Se lee y se escribe. |
| `bundleVersion: 1` | Manifest de un conjunto de partes | Integridad, orden y cantidades de las partes | Se lee y se escribe (U-DAT-04). Ver [conjunto de partes](#conjunto-de-partes-bundleversion-1). |
| Sin `schemaVersion` | `catalogue` de cada ficha | Procedencia legacy (una fuente por ficha) | Se lee y se escribe. |
| `catalogue.schemaVersion: 2` | `catalogue` de cada ficha | Procedencia por campo y fuentes ampliadas (BNE) | Se lee siempre; se escribe según la bandera de revisión. |

`Book.version` (UUID) es un token de concurrencia: nunca se exporta en v2 y, si aparece en un v1, se ignora. Restaurar una copia genera tokens nuevos.

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
- Libro sin `catalogue`: se lee como `{ "source": "import", "isbnVerified": false }`. Nunca como `manual`.
- `isbnVerified` ausente se lee como `false`. Solo se conserva `true` si el ISBN es válido.
- Los writers solo han escrito `source`, `isbnVerified` y `sourceUrl` en `catalogue`. Cualquier otra clave se rechaza en lugar de descartarse.
- Los lectores actuales aceptan también `catalogue.schemaVersion: 2` dentro de un v1 o legacy. La vista previa de importación de U-DAT-01 guarda la colección en forma legacy y debe conservar la procedencia. Los writers v1 no lo emiten.

## Payload portable `formatVersion: 2`

Es el esquema canónico que U-DAT-06 reutilizará al separar tablas. No existe otro contenido llamado v2: un v2 con un array `books` se rechaza.

```json
{
  "formatVersion": 2,
  "exportedAt": "2026-10-23T10:00:00.000Z",
  "requiredCapabilities": ["catalogue.provenance-v2"],
  "works": [],
  "editions": [{
    "id": "<book.id>", "work_id": null, "isbn13": "9788401337208",
    "title": "…", "subtitle": "…", "authors": [{ "name": "…" }], "publishers": [{ "name": "…" }],
    "publish_date": "2009", "number_of_pages": 872, "cover": { "small": "…", "medium": "…", "large": "…" },
    "catalogue": { "schemaVersion": 2, "source": "bne", "sourceUrl": "https://…",
                   "fields": { "title": { "provider": "bne", "recordId": "…", "retrievedAt": "…", "selection": "user-selected" } } }
  }],
  "copies": [{
    "id": "<book.id>", "edition_id": "<book.id>", "status": "read", "shelf_id": "…",
    "edition_verification": { "isbnVerified": true }, "legacy_identifier": null
  }],
  "shelves": [{ "id": "…", "title": "…", "isDefault": true }]
}
```

**Adaptador legacy (antes de separar tablas).** Cada fila `books` produce una edición y una copia:

- `edition.id = copy.id = copy.edition_id = book.id`: mismo valor en namespaces de entidad distintos. El backfill de U-DAT-06 reutiliza esos IDs.
- `work_id = null` y `works = []`: sin evidencia, no se deduce ninguna obra.
- `isbn13` es el ISBN-13 canónico o `null`. Un `manual-…` u otro identificador que no es un ISBN válido va a `copy.legacy_identifier`; nunca ocupa `isbn13`.
- **Verificación física en la copia** (`edition_verification.isbnVerified`). **Fuentes por campo en la edición** (`edition.catalogue`, que nunca lleva `isbnVerified`).
- `publishers` y `subtitle` solo aparecen si la ficha los tenía, para que la ida y vuelta sea exacta.
- Las estanterías no llevan `book_count`: el lector lo recalcula.

**Capacidades.** Cada payload declara en `requiredCapabilities` lo que necesita su lector. Este lector conserva:

| Capacidad | Significado |
| --- | --- |
| `catalogue.provenance-v2` | Alguna edición usa `catalogue.schemaVersion: 2`. Si se usa sin declararla, el archivo se rechaza. |

Conoce y **rechaza** hasta U-DAT-06 `works.entities`, `copies.multiple-per-edition`, `copies.verification-evidence` y `editions.identifiers`. Una capacidad desconocida también se rechaza.

### Qué rechaza el lector v2 y por qué

Todos los rechazos ocurren antes de escribir. Nada se importa parcialmente y ningún campo se descarta en silencio.

| Entrada | Motivo |
| --- | --- |
| Varias copias con el mismo `edition_id` | La tabla `books` tiene una fila por edición y por ISBN. Representarlas exigiría fusionar u omitir copias. |
| `works` no vacío o `work_id` no nulo | No existe todavía la entidad obra. |
| Edición sin copia | Una fila legacy siempre es un ejemplar. |
| `edition.id` distinto de `copy.id` | El ID de edición no se podría conservar. |
| `isbn13` y `legacy_identifier` a la vez | `books.isbn` solo guarda uno de los dos. |
| `isbn13` con dígito de control incorrecto | No es un ISBN. No se inventa uno. |
| Claves o secciones desconocidas (`identifiers`, `checkedAt`, `loans`…) | No se pueden conservar. El mensaje nombra las claves. |
| Capacidad desconocida o no admitida | Requiere un lector posterior. |
| `formatVersion` distinto de 1 o 2 | Versión no compatible. |

Tras el adaptador, un v2 pasa por las mismas validaciones que v1: límites, duplicados de ISBN e ID, estanterías existentes y una sola predeterminada. También alimenta el mismo plan de importación de U-DAT-01.

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
- **v2** si alguna ficha tiene procedencia BNE o `fields`. El formato 1 la perdería, así que no se ofrece (`createLibraryExport` y `fragmentLibraryExport` lanzan un error explicativo).

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
