# U-BIB-02 · Adaptadores Open Library y BNE SRU

Rama `u-bib-02`, hija de `feature/spec-pendientes`; trabajo sin Docker ni acceso a bases de datos. Contrato U-BIB-01 conservado, sin cambios en schema, migraciones, gateway, cache o quota compartidos.

## Entrega y límites

- Open Library: Books API por ISBN exacto, Search JSON por título/autor (`fields=key,title,author_name`, `limit=10`) y resolución por `/works/{id}/editions.json?limit=10` o `/books/{id}.json`. Se distingue obra de edición; los campos que no existen siguen ausentes. No hay `fields=*`, scraping, fan-out de autores ni paginación automática. Las referencias de edición/obra se validan antes de construir URLs.
- `lib/open-library.ts` pasa a ser una fachada del adaptador; conserva el DTO `Book`, los fallbacks, la validación de ISBN, la deduplicación de consultas legacy simultáneas y la clasificación de telemetría. Con contacto se envía `User-Agent: BibLib (<OPEN_LIBRARY_CONTACT>)`; sin contacto se conserva `BibLib/1.0` y el nivel conservador de una petición/segundo. Si Books API omite el enlace HTML, se conserva como fuente la URL JSON realmente consultada.
- BNE: SRU 1.2, MARCXML, `alma.isbn`, `alma.title` y `alma.creator`; valores CQL entre comillas con escape de comillas, barras y comodines. HTTPS y host fijo `catalogo.bne.es`, sin redirects. El endpoint solo admite inyección explícita en `test`, nunca por una variable URL de producción.
- Cada adaptador usa su limitador por instancia, compartido por sus operaciones; espera máxima de cola de un segundo y rechazo del exceso, sin cola ilimitada. Un HTTP 429 conserva `Retry-After` en segundos o fecha HTTP, bloquea nuevas llamadas durante ese intervalo y no reintenta automáticamente. La señal del orquestador cancela tanto la cola como fetch y lectura; el deadline local incluye el cuerpo (OL hasta 8 s, reducido por el deadline de fuente del orquestador; BNE hasta 3,5 s).
- BNE limita `maximumRecords` a 1–10 (10 por defecto), bytes UTF-8 a 524288 y profundidad XML a 24 antes de parsear; también limita a 20000 elementos y comprueba `Content-Length` y bytes reales de streaming. Cancela el cuerpo al excederlos. XML roto, entidades definidas, DTD/XXE, CDATA, instrucciones de proceso externas, namespaces ajenos, diagnósticos SRU o posiciones inconsistentes devuelven `unavailable`, nunca ausencia certificada. Se permiten únicamente referencias numéricas válidas y las cinco entidades XML predefinidas, decodificadas una vez sin resolución externa.
- El orden predeterminado sigue siendo OL → BNE → Google opcional; `BIBLIB_BNE_ENABLED=false` apaga BNE sin afectar OL. En `fixture` no se crea el adaptador BNE ni se llama a fetch, incluso con todas las banderas activas. Los fixtures de contrato anteriores siguen funcionando.
- Cachés por instancia de máximo 500 entradas, TTL positivo de 3600 s y negativo de 300 s; lectura sin renovar TTL ni fecha de recuperación y copias independientes. OL conserva solo objetos validados por sus schemas, BNE solo candidatos normalizados: no se guardan XML crudos, bloques de disponibilidad, imágenes ni respuestas de error. Las claves distinguen operación/ISBN/query y no contienen credenciales. La aceptación distribuida corresponde a U-DAT-05 y U-BIB-05; esta entrega no reclama coordinación multiinstancia.
- BNE publica política `2026-10-23.2`: metadatos CC0 con `cacheMetadata`, `persistMetadata`, `exportMetadata` y atribución, URL y hora; toda capacidad de imagen/offline permanece denegada. `getCover` ni siquiera se anuncia para BNE y el mapper ignora 856. La política OL permanece en `2026-10-23.1`. No se añaden writers de procedencia ampliada ni formatos de exportación; pertenecen a U-BIB-04.

## Validación pública previa al mapeo

Se hicieron **tres peticiones públicas puntuales**, sin bucles ni cosecha: dos `Explain` y un solo `searchRetrieve` con máximo dos registros, el 23-10-2026. Las dos consultas iniciales precedieron a la implementación; el segundo `Explain` corrigió un recorte local que omitía índices `<index sort="true">`. No se hicieron consultas reales a Open Library ni solicitudes al catálogo durante las pruebas automatizadas.

| Nº | Hora UTC | Consulta a `https://catalogo.bne.es/view/sru/34BNE_INST` | Resultado |
| --- | --- | --- | --- |
| 1 | 15:28:51.338 | `operation=explain&version=1.2` | HTTP 200, 186457 bytes; SRU 1.2 y MARCXML, índices Alma. |
| 2 | 15:28:51.802 | `operation=searchRetrieve&version=1.2&query=alma.isbn%3D%229788401337208%22&recordSchema=marcxml&maximumRecords=2&startRecord=1` | HTTP 200, 15163 bytes; `numberOfRecords=4`, recibidos solo los dos solicitados. |
| 3 | 15:37:19.148 | `operation=explain&version=1.2` | HTTP 200, 186457 bytes; recorte corregido de `alma.creator`, `alma.isbn`, `alma.title`, con relación `=` publicada. |

El ISBN `9788401337208` corresponde a una publicación española conocida de «El nombre del viento», pero la respuesta concreta muestra por qué no se debe confiar solo en el índice: el registro `991049552139708606`, titulado «La música del silencio», publica ese mismo ISBN en 020; el registro `991007050249708606`, «El nombre del viento», publica otro ISBN en 020 y el solicitado únicamente en 776 de relación. El adaptador conserva literalmente el candidato del primer registro y excluye el segundo en lookup exacto. No declara verificación física ni corrige la bibliografía del proveedor por inferencia.

Los XML recortados están en `tests/fixtures/bibliography/bne/explain.xml` y `search-retrieve.xml`; `probe.json` registra cantidad, fecha, estado HTTP, tamaños originales y SHA-256 originales. Se retiraron inventario, disponibilidad, datos de ejemplares, fechas biográficas y campos ajenos al mapeo; quedan únicamente metadatos bibliográficos públicos. `constructed.xml` es sintético y prueba namespaces prefijados, orden distinto, ISBN-10, 264 y ausencias. Los JSON de OL también son fixtures construidos, no una captura de biblioteca privada.

## Mapeo MARC campo a campo

| MARC / SRU | DTO | Regla |
| --- | --- | --- |
| 020 `$a` | `isbns`, evidencia ISBN exacto | Solo ISBN válido de ese subcampo; separa el calificador entre paréntesis y conserva puntuación del identificador. Normaliza ISBN-10/13 únicamente para comparar. Nunca usa 776 `$z` ni otros campos relacionados. |
| 245 `$a` / `$b` | `title` / `subtitle` | Cada valor en su campo; recorta separación ISBD final. No divide un título heurísticamente ni extrae autoría de `$c`. |
| 100 `$a`, 700 `$a` | `authors[].name` | Principal 100 y coautores 700 con `$4=aut`, etiqueta autor/a o sin rol declarado; excluye 700 con rol explícito de traducción/ilustración. No copia fechas biográficas ni inventa nombres desde claves. |
| 264 con indicador 2=`1`, o 260 | `publishers[].name`, `publishDate` | `$b` editor; `$c` fecha literal, incluidos corchetes. Prefiere publicación 264 y no confunde 264 de copyright con publicación. Sin fecha atribuible no usa una fecha inventada desde 008. |
| 041 `$a`, o 008 posiciones 35–37 | `language` | Primer código de tres letras válido; 041 tiene precedencia. No usa 041 `$h` (idioma original) como idioma de esta edición. |
| 300 `$a`, `$b`, `$c` | `format`, `numberOfPages` | Descripción física literal concatenada si cabe en los 100 caracteres del contrato; no la clasifica como encuadernación. Solo extrae páginas si `$a` empieza por una cantidad explícita seguida de `p.`, `página(s)` o `page(s)`; no convierte hojas, recursos, volúmenes ni extensión relacionada en páginas. |
| 001, con fallback `recordIdentifier` SRU | `recordId`, `sourceUrl` | ID validado y URL de ficha Primo de la BNE con `docid=alma{id}`, `context=L`, `vid=34BNE_INST:CATALOGO`. Sin identificador atribuible falla cerrado para no almacenar material sin fuente. |
| `recordPosition` SRU | Orden de candidatos | Posiciones enteras positivas únicas, dentro del total; orden numérico independiente del orden XML. |
| Hora de respuesta | `retrievedAt` | ISO UTC capturada al recuperar; la caché mantiene la hora original. |
| 856 / cualquier imagen | Ninguno | No concede licencia de portada; no produce `coverUrl` ni descarga bytes. |

El patrón de URL de ficha se ha contrastado con enlaces publicados por la propia [BNE](https://www.bne.es/es/colecciones/incunables/incunables-grabados/epilogo-medicina-cirurgia-conueniente-salud). No se usa la URL de un recurso digital 856 como si fuera la ficha o una portada.

## Dependencia XML

Se añadió **una única dependencia directa**, `fast-xml-parser@5.11.2`, mediante `pnpm add -E`, versión exacta consultada en el registro durante esta entrega. El [proyecto mantenido](https://github.com/NaturalIntelligence/fast-xml-parser) incluye parser, validador y tipos TypeScript, evitando DOM o resolución de recursos externos. Se configura `processEntities:false`, conserva namespaces y orden, y se antepone un rechazo explícito de `<!` (incluido DOCTYPE/ENTITY), referencias desconocidas, profundidad, elementos y bytes. No se confía en que el parser por sí solo evite XXE.

`package.json` incluye la versión exacta; el lockfile lo regenera el coordinador al fusionar con U-QA-02, según el reparto expreso de esta ola. No se modifican scripts ni decisiones de instalación de otras dependencias. La instalación avisó del peer preexistente de `@emnapi` bajo el resolver de ESLint, sin bloquear instalación ni comprobaciones.

## Validación

| Comando | Resultado |
| --- | --- |
| Suite focalizada de adaptadores | 25 pruebas nuevas correctas, sin red. |
| `pnpm lint` | Correcto. |
| `pnpm typecheck` | Correcto. |
| `pnpm test` | 154 pasadas y 2 fallos: expectativas legacy de `BibLib/1.0 (contacto)` frente al `BibLib (contacto)` exigido en esta unidad; pendiente autorización del coordinador para ajustar exclusivamente esas cadenas fuera del scope asignado. |
| `pnpm test:scripts` | 145 pasadas, 2 omitidas por ausencia de stack acreditado, cero fallos. |
| `pnpm build` | Correcto con placeholders de CI, `BIBLIB_TARGET=test`, modo fixture y `NODE_ENV=production`; artefacto `.next-test`. |
| `pnpm check:bundle` con `BIBLIB_TARGET=test` | Correcto: 40 archivos cliente limpios. |
| `git diff --check` | Correcto. |

El build utiliza `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55331`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=public-build-placeholder` y `SUPABASE_DB_URL=postgresql://postgres:placeholder@127.0.0.1:55332/postgres`. No se leyó ningún archivo privado ni se consultaron bases.

Las pruebas cubren título con diacríticos, ISBN-10/13, varias ediciones e incompletas, ausencia válida, identificadores distintos, referencias peligrosas, 429/Retry-After, 5xx sin caché, caducidad positiva/negativa, cancelación en cola/fetch/cuerpo, timeout no cooperativo, XML roto/XXE/DTD/entidades, namespaces, profundidad, tamaño declarado/real y orden. El agregado OL encontrado más BNE timeout conserva `found` con `complete:false`; apagar BNE deja OL completo y fixture conserva cero llamadas.

## Conciliación, activación y recuperación

U-DAT-05 debe enrutar ambas fuentes mediante su gateway/cuota/caché compartidos al fusionar; se conservan las firmas `CatalogProvider` y `ProviderContext` del orquestador, incluyendo `signal` y `requestId`. No se crearon `gateway.ts`, `cache.ts`, `quota.ts` ni la migración 0004. La persistencia/exportación por campo y UI de selección corresponden a U-BIB-04; los callers legacy de import/recovery siguen pendientes de U-BIB-05.

BNE permanece deshabilitada por defecto. Para activar en un entorno permitido: modo `live` y `BIBLIB_BNE_ENABLED=true`; para recuperarse de un fallo SRU/parser basta `false`, sin cambiar OL ni datos guardados. No se realizó activación ni despliegue.

No se ejecutaron pruebas de navegador, SQL ni integración con Supabase porque la unidad no tiene stack asignado. Recursos Docker creados, arrancados, parados o modificados: ninguno; redes y volúmenes dejados: ninguno.

Consulta de scope enviada mediante `orca orchestration ask`, mensaje `msg_caef7b0c8474`: ajustar únicamente las dos expectativas de cabecera de `tests/open-library.test.ts`. Se conserva intacta esa suite mientras no llegue respuesta; no se modifica telemetría ni otras pruebas ajenas. El resto de los grupos de `pnpm test`, incluida telemetría, pasa en la última ejecución completa.
