# Especificación: proveedores bibliográficos free-first

**Estado:** propuesta implementable de prioridad **P1**, dentro de F1–F2. No es una idea de producto futuro: sustituye consultas dispersas por un flujo bibliográfico verificable en el alta, la importación y la recuperación de portadas. Google Books queda opcional y apagado hasta cumplir las condiciones de habilitación de U-BIB-03.

**Fecha de revisión de fuentes:** 2026-10-22. Se separan hechos documentados, política del proveedor y decisiones propuestas. La entrega individual inicial conserva límites acotados por proceso; la aceptación conjunta O08/BIB05 exige la coordinación global de DAT05. No atribuir esa coordinación a un adaptador que todavía no la integra.

## Resultado y límites

1. Open Library y BNE son los proveedores base, gratuitos según la documentación confirmada para el proyecto y sin depender de una clave de pago. La falta de datos en una fuente no implica que el libro no exista.
2. Google Books es un adaptador opcional, deshabilitado por defecto. No se habilitan servicios facturables ni facturación automática como parte de esta especificación. No se afirma que exista una tarifa o cuota fija garantizada.
3. ISBN, título y autor son señales de búsqueda; el proveedor no verifica que el ejemplar físico de la persona sea esa edición. Solo se propone fusionar metadatos con ISBN exacto y señales compatibles de idioma/formato. El año por sí solo no demuestra una edición física concreta.
4. No scraping, no scraping HTML de BNE u Open Library, no ISBNdb/Amazon obligatorios y no usar un proveedor como backend de harvesting. No paralelismo ilimitado.
5. Todas las consultas pasan por el mismo orquestador. Una falla de proveedor se puede reintentar o resolver manualmente; no bloquea la entrada manual ni convierte el estado en «no encontrado».

### Configuración canónica propuesta

| Variable | Valor inicial y precedencia |
| --- | --- |
| `BIBLIB_CATALOGUE_MODE` | `fixture` en local/test, `live` en prod; prod con fixture es error. Fixture prevalece sobre las banderas: nunca llama Internet. |
| `BIBLIB_OPEN_LIBRARY_ENABLED` | `true`; apagarla produce outcome `disabled`, sin consultas directas alternativas. |
| `BIBLIB_BNE_ENABLED` | `true` en el perfil live aceptado de O08; durante el canary previo puede fijarse explícitamente a `false`. |
| `BIBLIB_GOOGLE_BOOKS_ENABLED` | `false`; activación explícita solo después de las condiciones de U-BIB-03. |
| `GOOGLE_BOOKS_API_KEY` | Vacía por defecto, solo servidor. Google habilitado sin clave devuelve `misconfigured` en live. |
| `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED` | `false` hasta readers/writers/export compatibles de U-BIB-04; activar explícitamente en el perfil aceptado al cerrar O09. |

Los fixtures de Google para tests se seleccionan en el harness de `test`, con configuración sintética; no necesitan una clave real y no cambian el comportamiento de live. Los catálogos que no ofrecen `getCover` o `resolveEditions` declaran esa capacidad en falso. Resolver ediciones recibe una referencia tipada de proveedor/registro, nunca una URL arbitraria: utiliza los mismos hosts, cuota, derechos y deadline, y no genera fetch auxiliares fuera del orquestador.

**Configuración canónica.** `BIBLIB_CATALOGUE_MODE=fixture|live` selecciona respuestas deterministas o proveedores reales en el servidor; `fixture` es el valor seguro para pruebas y desarrollo sin red. Las banderas separadas son `BIBLIB_BNE_ENABLED`, `BIBLIB_GOOGLE_BOOKS_ENABLED` y `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED`. `GOOGLE_BOOKS_API_KEY` existe solo en runtime de servidor y nunca se entrega al cliente. No introducir nombres alternativos de modo o banderas en adaptadores, UI o despliegue.

## U-BIB-01 · Contrato común y orquestador de consultas

**Objetivo.** Crear una única frontera de servidor para búsqueda de ISBN, búsqueda de título/autor y portadas; permitir cambiar proveedor y políticas sin cambiar los formularios ni escribir una falsa ficha.

**Alcance propuesto.** Definir adaptadores con capacidades explícitas y un servicio que reciba consulta validada, el usuario autenticado, política de proveedores y presupuesto total de tiempo. Los adaptadores no guardan libros. El orquestador normaliza ISBN-10/13 con `normalizeIsbn`/`normalizedBookIdentifier`, consulta primero Open Library y después BNE por defecto, dentro de una cuota acotada; ambos pasos son secuenciales, con orden configurable y sin duplicar una fuente. Valida respuestas y devuelve candidatos neutrales. `lookupISBN` solo acepta una coincidencia ISBN que el adaptador devuelva y la vuelve a comparar localmente; `searchTitleAuthor` nunca atribuye ISBN no recibido; `getCover` es una operación separada para no confundir imagen con ficha bibliográfica.

Contrato TypeScript orientativo, no contrato de endpoint de cliente:

```ts
type ProviderStatus =
  | "found"
  | "notFound"
  | "unavailable"
  | "rateLimited"
  | "disabled"
  | "misconfigured"

interface ProviderCapability {
  lookupISBN: boolean
  searchTitleAuthor: boolean
  resolveEditions: boolean
  getCover: boolean
}

interface ProviderRecordRef {
  provider: "open-library" | "bne" | "google-books"
  recordKind: "work" | "edition"
  recordId: string
}

interface BibliographicCandidate {
  provider: "open-library" | "bne" | "google-books"
  level: "work" | "edition"
  recordId?: string
  sourceUrl?: string
  isbns: string[]
  title?: string
  subtitle?: string
  authors: { name: string; sourceUrl?: string }[]
  publishers: { name: string }[]
  language?: string
  format?: string
  publishDate?: string
  numberOfPages?: number
  coverUrl?: string
  evidence: { isbnExact: boolean; languageCompatible?: boolean; formatCompatible?: boolean }
  retrievedAt: string
}

interface CoverCandidate {
  provider: "open-library" | "bne" | "google-books"
  coverKey: string
  sourceUrl?: string
  imageUrl?: string // HTTPS validada; ausencia no genera una URL inventada.
  width?: number
  height?: number
  rightsPolicyVersion: string
  attribution?: string
}

type ProviderResult<T> =
  | { status: "found"; provider: string; value: T; requestId: string }
  | { status: Exclude<ProviderStatus, "found">; provider: string; retryAfterSeconds?: number; requestId: string }

interface ProviderOutcome {
  provider: string
  status: ProviderStatus | "notAttempted" // Solo el orquestador, no una respuesta inventada del proveedor.
  reason?: "deadline" | "unsupported" | "policy"
  requestId: string
  retryAfterSeconds?: number
}

interface CatalogLookupResult<T> {
  status: "found" | "notFound" | "incomplete"
  candidates: T[]
  providers: ProviderOutcome[]
  complete: boolean
  deadlineExceeded: boolean
}

interface BibliographicCatalogService {
  capabilities(): Record<string, ProviderCapability>
  lookupISBN(isbn: string, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  searchTitleAuthor(query: TitleAuthorQuery, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  resolveEditions(work: ProviderRecordRef, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  getCover(isbn: string, options?: LookupOptions): Promise<CatalogLookupResult<CoverCandidate>>
}
```

`ProviderResult` es el resultado de un adaptador individual; el servicio agrega candidatos y un `ProviderOutcome` por fuente en `CatalogLookupResult`. `notFound` se devuelve solo cuando al menos una fuente tiene capacidad aplicable, todas las fuentes elegibles terminaron sanas y ninguna halló candidato. Si OL devuelve candidato y BNE termina en timeout, el resultado es `status: "found"`, `complete: false`, con el candidato y el fallo de BNE explícitos en `providers`; `incomplete` se usa si no hay candidatos y alguna fuente elegible falló, fue limitada o superó el deadline. `unavailable` significa caída/timeout, `rateLimited` límite explícito, `disabled` política apagada y `misconfigured` configuración ausente/inválida. Las operaciones de portada mantienen capacidades y resultados separados de la ficha bibliográfica. Si no hay fuentes aplicables/habilitadas, no existe un «no encontrado» por conjunto vacío: devolver `incomplete`, `complete: false` y el diagnóstico de capacidad/configuración correspondiente.

**Normalización y combinación.** Validar checksum del ISBN antes de consultar; canonicalizar ISBN-10/13 a ISBN-13 y conservar los identificadores originales que publique cada fuente. Para una posible edición común deben coincidir el ISBN canónico exacto y señales compatibles de idioma/formato. Una fecha/año diferente se presenta como conflicto y no decide por sí sola que sean ediciones distintas o iguales. Para resultados de título/autor sin ISBN exacto, mostrar candidatos independientes y no fusionarlos. No calcular un porcentaje de «confianza» sin una fórmula validada; presentar evidencia observable («ISBN exacto», «idioma no informado», «formato distinto»).

**Timeouts/cuotas.** Presupuesto inicial propuesto: deadline común máximo de 8 s para cada búsqueda ISBN/título y máximo de 3,5 s por fuente dentro del tiempo restante; `getCover` tiene un deadline separado de máximo 4 s. Consultar secuencialmente como máximo tres fuentes habilitadas, en orden configurado: OL y BNE son las dos fuentes base, Google queda apagado por defecto y puede ser la tercera cuando se habilite. Si vence el deadline o queda una fuente elegible sin consultar, usar `complete: false`: conservar `found` si hay candidatos, e `incomplete` si no los hay; nunca convertir una ejecución parcial en `notFound`. Revisar estos valores con medición, sin ampliarlos silenciosamente. No crear promesas no cancelables que sigan consumiendo cuota después de que el usuario cambió de pantalla. El primer incremento usa el limitador existente de Open Library y acota tráfico por instancia; integrar coordinación y caché compartidas de DAT05 en un incremento posterior antes de declarar aceptación multiinstancia/global. Sin distribución de IPs ni tormenta de reintentos. Fallo parcial no borra un resultado válido.

**Archivos/contratos propuestos.** Nuevo `lib/bibliographic-catalog/` con tipos, orquestador, normalización de DTO y registro de proveedores; acciones autenticadas en `app/actions/bibliography.ts`; los endpoints actuales pueden conservar sus rutas, pero delegan a este servicio. No enviar una API key o secreto al navegador. Registrar proveedor/requestId/latencia/status, nunca la URL completa con credenciales ni contenido privado de la biblioteca.

**Dependencias/modelo.** Para el primer incremento: `lib/isbn.ts`, contratos actuales de alta y el limitador ya disponible. La integración del presupuesto/caché global de DAT05 es posterior y necesaria para aceptación multiinstancia, no para habilitar el contrato inicial. Compatibilidad de export/import/almacenamiento offline con DAT10 es una integración posterior y no bloquea el flujo URL de consultas en línea. Tratar proveedor, licencia y TTL como política, no como constante común. Sin base de datos de proveedores si solo se realiza consulta en línea. La política versionada `ProviderRightsPolicy` forma parte de U-BIB-01 desde el primer incremento: capacidades `cacheMetadata`, `persistMetadata`, `exportMetadata`, `previewCover`, `rehostCover`, `backupAsset`, `offlineUse`, TTL y atribución. Desconocido implica denegado para esa capacidad. Validar la política antes de caché, guardar, snapshot, exportar o servir offline; seleccionar un candidato no concede derechos. DAT05 aplica esta misma política a la coordinación compartida; DAT10 añade validación y bytes de assets, no decide tardíamente si los metadatos ya exportados estaban permitidos. El catálogo base conserva la política publicada por fuente; para Open Library no se declara que todas las contribuciones/imágenes tengan CC0: [licencias de Open Library](https://openlibrary.org/developers/licensing).

**Criterios de aceptación.** Las operaciones del servicio tienen tipo y estados discriminados; ISBN inválido no causa red; cada fuente puede fallar sin convertir `unavailable` en `notFound`; ninguna respuesta sin coincidencia exacta se etiqueta como match ISBN; un timeout cancela la operación y el error no incluye secretos; se puede desactivar un proveedor sin cambiar UI.

**Pruebas locales.** Tests unitarios del contrato y del canonicalizador (ISBN-10 con X, ISBN-13, guiones, checksum inválido); fixtures para cada estado; resultado parcial; timeout/cancelación; compatibilidad y conflicto de campos; pruebas que aseguren ausencia de llamadas al proveedor con ISBN inválido.

**Activación/recuperación.** Entregar como servicio interno bajo `BIBLIB_CATALOGUE_MODE=fixture|live`. `fixture` solo está permitido en local/test y genera cero tráfico externo. El target real `prod` rechaza fixture antes de servir datos; el fallback ante caída en producción es desactivar la fuente o completar manualmente, nunca presentar libros ficticios. Cualquier adaptador anterior se conserva únicamente detrás de la misma cuota/política vigente, sin reabrir un camino directo de fetch.

**Esfuerzo: M.**

## U-BIB-02 · Adaptadores base Open Library y BNE SRU

**Objetivo.** Cubrir gratuitamente consultas ISBN, título/autor y portadas con una fuente abierta internacional y un catálogo bibliotecario nacional, respetando sus interfaces y límites.

### Adaptador Open Library

**Hechos documentados.** La API ofrece datos estructurados y endpoints de Search, Covers y Work/Edition; sus directrices piden peticiones útiles iniciadas por una persona, cachear y enviar `User-Agent` con nombre de aplicación y contacto. La documentación indica 1 solicitud por segundo sin identificación y 3 con `User-Agent`/email identificados, y pide no hacer cientos de solicitudes individuales ni descargas masivas por API. [Open Library: API, directrices y límites](https://openlibrary.org/developers/api).

**Implementación propuesta.** Usar API JSON documentada, no páginas HTML. Mantener un User-Agent claro `BibLib (contacto@dominio-configurado)` si se proporciona un contacto operativo; si no, respetar el nivel no identificado. El primer incremento respeta el limitador existente y `Retry-After` si está disponible; la cuota/caché compartida DAT05 se integra después y es requisito de aceptación multiinstancia. Para importación/recovery no lanzar una consulta por libro sin cola: lotes compatibles con el API, máximo de trabajo por ejecución, deadline y botón continuar. No dividir carga por varias IPs para eludir cuotas.

### Adaptador BNE SRU

**Hechos confirmados para esta integración.** BNE publica el endpoint SRU `https://catalogo.bne.es/view/sru/34BNE_INST`, compatible con SRU 1.2 y respuesta MARCXML; incluye `Explain` y permite consultar índices Alma `alma.isbn`, `alma.title` y `alma.creator`. El aviso legal del catálogo declara metadatos bibliográficos bajo CC0. Ese permiso de metadatos no demuestra licencia equivalente para portadas o miniaturas; no reutilizar imágenes por inferencia. [Servicio SRU de BNE](https://www.bne.es/en/node/33551), [aviso legal de BNE](https://www.bne.es/es/aviso-legal).

**Implementación propuesta.** En integración inicial probar `Explain` contra el endpoint y registrar la versión/diagnóstico sin volcar respuestas completas a logs. `searchRetrieve` envía query escapada a los índices confirmados; parsear solo MARCXML esperado y convertir a DTO neutral. Consultas incluyen ISBN exacto primero y título/autor como búsqueda secundaria. Configurar `maximumRecords`, respuesta máxima en bytes y timeout. Rechazar DTD/XXE, entidades externas, XML excesivo/profundamente anidado y namespaces desconocidos; usar parser seguro que deshabilite resolución de entidades y mapear con fixtures MARCXML guardadas. No scraping del catálogo web.

**Mapeo propuesto.** Documentar el mapeo MARC mediante una ficha real pública de prueba, validada antes de codificar: ISBN, título/subtítulo, creador, editor, fecha, idioma, descripción física y URL de registro. La propuesta no asume que todo campo esté en todo registro ni sustituye originales MARC. Conservar solo valores que puedan atribuirse a un campo del registro. Exponer URL de catálogo del registro cuando exista.

**Caché y material almacenado.** En el primer incremento, cachear respuestas de Open Library cuando la guía lo recomienda usando la caché disponible; DAT05 define después TTL y caché compartidos por fuente/operación. En BNE, los metadatos indicados como CC0 pueden conservarse con procedencia. La caché por proveedor se distingue de los datos que la persona guarda en su biblioteca. Los campos elegidos solo se persisten/exportan si la política de U-BIB-01 lo permite, con fuente/URL/retrievedAt; las reglas de metadatos y offline se aplican desde su primer writer, sin esperar DAT10. Portadas conservan licencia/política propia, no se vuelven CC0 por acompañar metadatos. No cachear imagen de una fuente sin comprobar su licencia.

**Archivos/contratos propuestos.** `lib/bibliographic-catalog/providers/open-library.ts`, `.../bne-sru.ts`, parser MARCXML, schemas runtime (`zod` ya está en el proyecto), fixtures bajo `tests/fixtures/bibliography/`; `lib/open-library.ts` existente delega al adaptador común. Endpoint SRU configurable por entorno solo para tests/administración; producción usa host allowlist fijo y HTTPS.

**Dependencias/modelo.** Primer incremento: red saliente desde servidor, agente de identificación/contacto Open Library y limitador existente. DAT05 añade después presupuesto/caché globales y es requisito para aceptación multiinstancia; DAT10 integra posteriormente retención/export/offline, sin bloquear el flujo en línea. La licencia CC0 de BNE cubre metadatos de catálogo según aviso; no cubre automáticamente imágenes, capturas o datos de otros proveedores.

**Criterios de aceptación.** Una respuesta Open Library sin ISBN exacto no satisface `lookupISBN`; BNE resuelve `Explain`, interpreta `searchRetrieve` MARCXML y solo consulta índices permitidos; XML malicioso o malformado falla de forma cerrada sin acceso externo; adaptadores cumplen su deadline y el limitador inicial por instancia; O08/DAT05 y BIB05 verifican además el presupuesto global; ningún proveedor se invoca por lote sin límites; dato conservado mantiene URL de fuente y hora.

**Pruebas locales.** Respuestas fixture para título con diacríticos, varias ediciones, ISBN-10/13, no resultado y registros incompletos; HTTP 429/5xx, timeout, XML roto, XXE, tamaño máximo y orden de records. Banco de parser MARC con varias namespaces e identificadores. Verificar que portada BNE quede deshabilitada salvo contrato/licencia por separado.

**Activación/recuperación.** Activar OL primero bajo `BIBLIB_CATALOGUE_MODE=live`; mantener BNE bajo la bandera separada `BIBLIB_BNE_ENABLED`. Para errores de parser, apagar BNE sin afectar OL. El primer incremento usa limitador existente; incorporar coordinación compartida DAT05 después, antes de aceptar operación multiinstancia.

**Esfuerzo: M.**

## U-BIB-03 · Google Books opcional y sin facturación implícita

**Objetivo.** Dejar disponible una fuente adicional solo si una revisión de cuota, coste y términos prueba que conviene; mantener la aplicación usable sin ella.

**Hechos documentados.** Google Books busca volúmenes con `q=isbn:{isbn}` y los recursos incluyen `industryIdentifiers` tipados `ISBN_10`/`ISBN_13`; el adaptador debe verificar esos identificadores exactos y no fiarse solo del resultado de búsqueda. Para datos públicos Google exige identificar la aplicación mediante API key o token; la clave identifica proyecto, cuota e informes y admite restricciones. [Google Books: búsqueda, identificadores y credenciales](https://developers.google.com/books/docs/v1/using). Los términos contienen restricciones de uso y contenido, pero la documentación revisada no establece en estas páginas una cuota o tarifa fija garantizada; por tanto, no se presupuesta una tarifa gratuita ni se activa billing automáticamente. Los términos también dicen que no se puede cobrar por el uso de la aplicación sin acuerdo separado o permiso escrito. [Términos de Google Books API](https://developers.google.com/books/terms). Revisar cuota y cualquier precio aplicable en consola antes de habilitar en un entorno real.

**Alcance propuesto.** Implementar el adaptador como código opcional con `BIBLIB_GOOGLE_BOOKS_ENABLED=false` por defecto y `GOOGLE_BOOKS_API_KEY` solo en runtime servidor. Clave restringida por API/IP cuando la infraestructura lo permita, rotación documentada, valor nunca enviado al cliente, URL nunca registrada en logs porque la API key puede ir en query string. Enviar únicamente el ISBN o texto de búsqueda; nunca notas, fotos, préstamos, perfil ni el catálogo privado completo. Los términos de Google avisan que contenido enviado puede aparecer en servicios Google y restringen cobrar por el uso sin acuerdo separado o permiso escrito. Si la key no existe al habilitar, estado `misconfigured` y no petición. Sin activar productos con cargo, facturación automática ni cuotas de pago. El responsable de despliegue confirma consola/proyecto, límites, terms, privacy/contacto y autorización para cualquier modelo de cobro antes del primer tráfico real. [Términos Google Books API](https://developers.google.com/books/terms).

**Información visible.** Antes del primer uso Google, mostrar junto a su selector qué consultas se envían, enlace a sus condiciones/privacidad y el aviso sobre contenido enviado que exigen sus términos; ofrecer desactivar Google y seguir con OL/BNE/manual. No enviar nombre, alias, notas o inventario. Probar presencia y accesibilidad del aviso cuando Google esté habilitado, y ausencia de solicitudes cuando se desactive. Es una comunicación de ese proveedor, sin un diálogo repetido para cada ISBN.

**Búsqueda/validación.** `GET /books/v1/volumes?q=isbn:{canonical}`; validar runtime la respuesta; recorrer `industryIdentifiers` y normalizar cada ISBN. Si ninguno coincide exactamente, no devolverla como match ISBN, aunque el título coincida. `searchTitleAuthor` puede combinar `intitle:`/`inauthor:` dentro de cuota definida. El `getCover` separado puede presentar URLs de `imageLinks` para previsualización temporal; no escribir una portada Google en `Book.cover`, export ni cache permanente hasta que una revisión legal de términos/imagen defina permiso y retención. No descargar imágenes de forma indirecta como si la API metadata las licenciara.

**Archivos/contratos propuestos.** `lib/bibliographic-catalog/providers/google-books.ts`, schema de respuesta y mapa de `industryIdentifiers`; configuración de despliegue (`BIBLIB_GOOGLE_BOOKS_ENABLED`, API key server-only); página de estado diagnóstico solo para operador y sin secreto. No cambiar OAuth Google existente para conceder scopes adicionales.

**Dependencias/modelo.** Cuenta Google Cloud, API habilitada y key restringida; cuota/coste comprobados manualmente en consola y permiso de terms. No usar proveedor para reemplazar Open Library/BNE en ausencia de key. Resultado no persiste antes de elección y validación; imagen queda solo en memoria de la interacción hasta resolver licencia.

**Criterios de aceptación.** Por defecto ninguna solicitud Google ocurre; con flag apagado status `disabled`; flag activo sin key da `misconfigured`; key nunca aparece en navegador, error, URL registrada, analytics o test fixture; ISBN que no aparece en `industryIdentifiers` no se da por encontrado; tests funcionan sin credenciales; no se inicia facturación desde código ni deployment automático.

**Pruebas locales.** Mock de volumen con identificador coincidente, ISBN distinto, sin identifiers, múltiples editions, 429/403/5xx y key ausente; escaneo de logs para el secreto. Canary real solo después de verificar consola, 1–2 ISBN públicos conocidos y sin comprobar un número fijo de hits.

**Activación/recuperación.** F2 opt-in por entorno con límites bajos y monitoreo de cuota; ninguna activación automática tras deploy. Desactivar flag con una variable basta para volver al flujo OL+BNE; no reescribir datos ya elegidos. Si no se confirma coste/terms, el adaptador permanece apagado y la unidad se considera correctamente degradada. La entrega técnica de U-BIB-03 se acepta con fixtures, flag apagado y controles negativos probados; la activación externa es un estado independiente. Por eso BIB05 puede consumir el adaptador deshabilitado sin quedar bloqueado por una cuenta, cuota o permiso externos.

**Esfuerzo: S–M.**

## U-BIB-04 · Procedencia, conflictos y elección de candidato

**Objetivo.** Hacer que la persona elija qué ficha/portada guardar y entienda por qué las fuentes discrepan, preservando datos manuales y verificados.

**Alcance de UI.** El resultado presenta tarjetas candidatas independientes con proveedor, registro fuente, ISBN recibidos, título, autoría, idioma/formato si está disponible, fecha original, campos ausentes y evidencia del match. La portada se elige en control separado, con fuente/caption y preview/fallback. No fusionar dos candidatos por título parecido. Si mismo ISBN canónico y compatible idioma/formato, ofrecer «Combinar campos compatibles» con resumen de diferencias; si no, selección de una fuente o edición campo por campo. Los valores escritos manualmente, marcados verificados por la persona o ya guardados no se pisan en background. Antes de guardar, enseñar resumen editable y estantería/estado elegidos. En ausencia/error de catálogo, «Completar manualmente» mantiene ISBN y entradas.

**Conflictos y certeza.** Mostrar la evidencia literal disponible, nunca un porcentaje inventado: «ISBN coincide», «la fuente no incluye idioma», «año distinto» o «formato no compatible». Campo de año siempre se presenta como fecha editorial de la fuente, no «edición física verificada». Solo la confirmación humana en base a libro físico puede marcar una comprobación física; una API y checksum no la prueban. La portada puede proceder de proveedor distinto del resto de los campos.

**Archivos/contratos propuestos.** `app/books/add/page.tsx`, `components/book-search-result.tsx`, `components/book-form.tsx`, `components/book-cover.tsx`, detalle/edición, `lib/types.ts`, `lib/db/schema.ts`, `lib/library-import.ts`, `lib/library-export.ts`, validación de importación y servicio U-BIB-01. DTO propuesto:

```ts
interface FieldProvenance {
  provider: "manual" | "open-library" | "bne" | "google-books" | "photo" | "import"
  sourceUrl?: string
  recordId?: string
  retrievedAt?: string
  selection: "user-selected" | "manually-verified" | "unverified"
}

interface CatalogueAttributionV2 {
  isbnVerified: boolean // la persona confirmó que el ISBN corresponde a su ejemplar físico; false por defecto
  isbnChecksumValid?: boolean // derivado de normalizeIsbn; no equivale a comprobación del ejemplar
  fields?: Partial<Record<"title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover", FieldProvenance>>
}
```

El enum actual `CatalogueMetadata.source` (`manual | open-library | photo | import`) no representa BNE/Google ni procedencia por campo. Evolucionarlo de forma compatible: lectores aceptan v1 y v2, writers de catálogo escriben v2 después de la migración; preservar valor legado como fuente primaria y añadir `fields` opcional o extender enum con mapeo explícito. `isbnVerified` conserva la semántica vigente de confirmación humana frente al ejemplar físico y debe ser `false` cuando no existe valor legado; un checksum válido o un match de proveedor nunca lo establece. `isbnChecksumValid` puede derivarse al leer y no sustituye ni renombra la comprobación física. No degradar desconocidos a `manual` sin advertir. Export/import versionado acepta export v1 existente y la siguiente versión guarda atribución disponible. No introducir `google-books` en tipos/importación antes de implementar ese lector/validador.

**Salida portable antes de separar tablas.** Esta unidad entrega el payload v2 canónico de U-DAT-06 y un adaptador sobre la tabla legacy actual: `works=[]`, edición y copia con IDs derivados del `book.id` existente según el contrato de DAT06, verificación física en copia y fuentes por campo en edición. No publica un segundo formato v2 que aún use arrays `books`. El lector previo al cambio de modelo rechaza capacidades no representables, y el export antiguo v1 se ofrece solo si conserva todos los datos. Las fuentes BNE/Google o atribuciones no representables en v1 requieren v2. Desplegar estos lectores/exportadores antes de activar writers de procedencia ampliada; no dejar fichas nuevas sin un respaldo que conserve sus fuentes entre O09 y O12.

**Dependencias/modelo.** Contrato común, migración de JSON `catalogue` opcional y fuente URL HTTPS normalizada. La UI de candidatos y atribución puede salir con datos en línea seleccionados; integrar posteriormente reglas DAT10 de almacenamiento/export/offline y filtrado de campos Google no autorizados. No se exige una tabla por proveedor ni se duplican bibliografías por cuenta.

**Criterios de aceptación.** Los formularios no escriben antes de confirmar; no hay sobreescritura de campo manual/verificado; conflicto visible conserva cada valor y fuente; fusión solo con ISBN exacto y señales compatibles; proveedor/checksum nunca marcan `isbnVerified`; la ausencia de valor legacy deja ese booleano en `false`; metadatos legacy se leen igual; exportación antigua sigue importando; source enum no clasifica Google por defecto.

**Pruebas locales.** Conflictos por título, autor, fecha, idioma, formato, ISBN; selección por campo y por portada; edición concurrida; historial/versión de ficha; round-trip v1→v2; accesibilidad teclado/lector en elección de candidatos.

**Activación/recuperación.** Presentar primero candidatos OL+BNE bajo `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED`; mantener alta manual como fallback. Desplegar lectores v1/v2 antes que writers v2. Si UI falla, no afectar fichas ya guardadas ni borrar procedencia.

**Esfuerzo: M.**

## U-BIB-05 · Pruebas, medición y activación segura en todos los flujos

**Objetivo.** Probar comportamiento de contrato y rendimiento con red simulada; evitar cuotas por pruebas, duplicación de integraciones y activación involuntaria.

**Alcance.** Centralizar llamadas desde alta por ISBN, búsqueda por título/autor, importación y recuperación de portadas. Importación es trabajo limitado/reanudable: presupuesto por lote, pausado, contadores y fuente de cada portada. No ejecutar request por cada fila en paralelo; aplicar el límite existente por instancia en el primer incremento. Integrar después cuota y caché compartidas DAT05 para coordinar todas las instancias y cumplir aceptación global/multiusuario. La caché se organiza por proveedor + operación + ISBN/query normalizados con TTL separado; deduplicar solicitudes concurrentes del mismo cache key. Revisar respuestas cacheadas antes de leer de proveedor. Nunca guardar credenciales ni contenidos de usuario en clave de caché.

**Retención/export/offline.** Mantener política de caché por licencia/condiciones y TTL versionado. La decisión de «seleccionar» metadatos en libro y el cache operativo son capas distintas. Export de la biblioteca conserva atribución necesaria de las fuentes que ya están autorizadas; no exporta cache sin seleccionar. La política de U-BIB-01/DAT05 define retención de metadatos, exportación y offline desde el primer writer; DAT10 añade los controles de bytes/rehosting, sin ser dependencia de consultas URL ni posponer la política. Excluir resultados Google y sus imágenes de retención permanente hasta verificar términos/licencias. BNE CC0 de metadatos no convierte sus imágenes en CC0. Política no debe borrar edición manual.

**Archivos/contratos propuestos.** Llamadores `app/books/add/page.tsx`, `app/settings/page.tsx`, `components/cover-recovery-panel.tsx`, `app/api/books/search/route.ts`, `app/actions/cover-recovery.ts`; `tests/bibliographic-catalog/` y `tests/fixtures/bibliography/`; panel/telemetría agregado por proveedor. Las pruebas focalizadas y la activación fixture/live se entregan con el servicio. DAT05 es requisito explícito para declarar aceptación global/multiinstancia; DAT10 solo requiere una integración posterior de retención/export/offline y no bloquea los flujos URL. BIB-01 y BIB-02 no dependen de BIB-05, por lo que no hay ciclo de aceptación.

**Datos de prueba y benchmarks.** Fixtures deterministas con respuestas públicas recortadas o construidas, sin claves, emails, datos de usuario, fotos/imports personales ni screenshots privados. La suite normal no hace llamadas live. Benchmark con red simulada para una, diez y cien consultas concurrentes que mide p50/p95, deduplicación, cola, timeout y tamaño de caché; no mide rendimiento externo con carga. Probe real opcional fuera de CI: máximo 1–2 ISBN públicos, solo tras permiso/configuración; el test comprueba parseo de cualquier respuesta válida y registra «sin ficha» sin fallar por un recuento esperado. No batch-harvesting.

**Pruebas locales.** Contrato completo: `found`, `notFound`, `incomplete` para el resultado agregado y `found`, `notFound`, `unavailable`, `rateLimited`, `disabled`, `misconfigured` por adaptador; 429 y reintento respetuoso; primero limitador/caché existentes y, tras DAT05, cola compartida simulada entre instancias y caché hit/expiry/invalidation; respuesta parcial; import/recovery limitado y reanudable; bloqueo de salida para Google disabled; OCR/escáner no requiere foto enviada; tests inspeccionan que logs no contengan key ni query secreta. Ejecutar la suite focalizada del servicio y sus callers modificados, no la suite global tras cada archivo; la suite completa va en la integración final.

**Criterios de aceptación.** Los cuatro flujos consumen solo el orquestador; no hay fetch directo/duplicado a Open Library en componentes o jobs; cada ejecución tiene topes por proveedor y deadline; Open Library nunca recibe tráfico masivo; total de solicitudes concurrentes por query está acotado; tests por defecto no usan red ni foto personal; Google permanece apagado hasta revisión de cuota/precio/terms y key server-only; una fuente caída no bloquea guardar manual ni convierte fallo en inexistencia.

**Activación/recuperación.** F1: usar `BIBLIB_CATALOGUE_MODE=fixture` para revisar contrato/UI; habilitar OL en `live` con limitador existente y BNE mediante `BIBLIB_BNE_ENABLED`, sin duplicar llamadas live. Tras integrar DAT05, validar cola, caché y límites compartidos antes de aceptación global/multiinstancia. F2: habilitar revisión con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED` y, si se aprueba coste/terms, Google opt-in con `BIBLIB_GOOGLE_BOOKS_ENABLED` en un entorno controlado. El operador puede devolver el modo a `fixture` o desactivar proveedor/revisión sin cambiar datos de libros. Mantener fallback manual y los metadatos elegidos.

**Esfuerzo: M.**

## Fuentes y límites de verificación

- Open Library API/directrices/cuotas: https://openlibrary.org/developers/api (revisado 2026-10-22). Sus números son límites publicados para solicitudes, no un SLA.
- BNE SRU y descripción de endpoint: https://www.bne.es/en/node/33551; aviso legal/metadatos: https://www.bne.es/es/aviso-legal (referencias confirmadas para esta especificación el 2026-10-22). Probar `Explain` y la respuesta real antes de cerrar el mapeo MARC; no inferir licencia de portada.
- Google Books API: https://developers.google.com/books/docs/v1/using; términos: https://developers.google.com/books/terms (revisados 2026-10-22). No se da por probada cuota o precio fijo ni autorización de almacenamiento permanente por consultar estos documentos.

No se ha llamado a estas APIs durante la redacción. Los contratos XML/JSON, presupuestos de timeout, TTL, límites por usuario y nombres de variables son propuestas de implementación y deben validarse con fixtures y configuración operacional antes de activar tráfico.
