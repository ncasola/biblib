# U-BIB-03 · Google Books opcional y sin facturación implícita

Rama `u-bib-03`, worktree hijo de `feature/spec-pendientes`; implementación técnica aceptada con fixtures y proveedor apagado por defecto. No se realizó activación externa, despliegue, canary, contratación, cambio de OAuth, schema, dependencias ni acceso a bases de datos.

## Entrega

- Adaptador `lib/bibliographic-catalog/providers/google-books.ts`: Books API v1, endpoint HTTPS fijo `https://www.googleapis.com/books/v1/volumes`, `q=isbn:{canonical}`, máximo diez volúmenes. Schema Zod acotado antes de mapear; ISBN válido de tipo `ISBN_10`/`ISBN_13` en `industryIdentifiers`, normalizado y comparado exactamente. Un título similar, un identificador `OTHER` o una ficha sin ISBN no certifican coincidencia. Se conservan ISBN originales, ID de volumen, URL pública de ficha y hora; varias fichas permanecen separadas.
- Búsqueda por texto con `intitle:`/`inauthor:` entre comillas, sin inferir ISBN ni consultar obras/ediciones auxiliares. `resolveEditions:false`. Solo se envían ISBN o título/autor, más parámetros técnicos `maxResults`/key; no se serializan identidad, notas, fotos, préstamos o inventario.
- Deadline propio de hasta 3,5 segundos incluyendo cola, fetch y lectura del cuerpo; límite declarado y real de 1 MiB, streaming cancelable, sin redirects ni credenciales de sesión. HTTP 429 devuelve `rateLimited`, conserva `Retry-After` y aplica cooldown sin reintentos. 403/5xx, JSON inválido, schema inválido, timeout y cancelación son `unavailable`, nunca ausencia certificada.
- Registro Google únicamente en `live`, con flag activo y configuración presente. Se preserva `config.ts`: ya contiene `BIBLIB_GOOGLE_BOOKS_ENABLED=false` por defecto y expone solo el booleano `googleConfigured`. La key se toma de runtime de servidor; el adaptador rechaza ejecución en navegador. `disabled`, `misconfigured` y `fixture` no realizan peticiones. Fixture no crea el adaptador Google, incluso con banderas y clave sintética.
- Cuota propia conservadora: intervalo de 2000 ms, una reserva interactiva por dueño, gateway U-DAT-05 y host `www.googleapis.com`. Es un techo de BibLib, no una cuota o precio publicados de Google. La registry utiliza `gateway.fetch` cuando hay gateway; las pruebas verifican que no se omite la reserva aunque no se pase `options.fetch`. El adaptador conserva además un limitador por instancia con cola máxima de un segundo; rechaza el exceso.
- Política Google `2026-10-23.3`: permite únicamente `previewCover`; deniega `cacheMetadata`, `persistMetadata`, `exportMetadata`, `rehostCover`, `backupAsset` y `offlineUse`, con TTL cero. Sin caché local. El gateway no escribe payload ni en caché pública ni privada. Los candidatos de metadatos nunca incluyen `coverUrl`; `getCover` separado devuelve preview HTTPS validada de hosts Google permitidos, sin descargar bytes, eliminando parámetros de credenciales y excluyendo ISBN no exactos. No hay writers de `Book.cover` ni export en esta unidad.
- Clave solo en la URL entregada al fetch de servidor. No se registran URL, cuerpo ni errores externos; se retorna estado seguro incluso si fetch lanza un error que contiene la URL completa o el proveedor refleja la key (también escapada en JSON). `redactGoogleBooksUrl()` ofrece únicamente el endpoint sin query para diagnósticos futuros. El DTO de configuración nunca contiene el valor. La documentación exige omitir la query también en APM/proxies del operador.
- Diagnóstico exclusivamente de operador: `node scripts/catalogue-status.mjs`, sin argumentos, red, archivos `.env*`, ruta pública o acción. Proyecta `disabled`, `misconfigured`, `fixture` o `ready` sin revelar variables ni key; `ready` solo significa configuración presente y no aprueba coste/términos.
- `components/google-books-notice.tsx`: aviso accesible con región etiquetada, enlaces de condiciones/privacidad Google y Books, advertencia de posible publicación de contenido enviado y botón de desactivación. Con `enabled:false` renderiza vacío; no se monta en páginas de esta unidad. Explica OL, BNE y alta manual como alternativas. El caller de revisión debe conectar `onDisable` al selector y detener las consultas Google.
- Sección propia anexada a `docs/operacion.md`: opt-in por entorno, revisión manual de consola/proyecto, cuota, coste, términos/modelo de cobro, privacidad/contacto, restricciones de key, rotación/revocación y recuperación apagando el flag.

## Pruebas y resultados reales

| Comprobación | Resultado |
| --- | --- |
| Suite Google focalizada | 19 pruebas correctas con fetch simulado; incluye render HTML del aviso mediante React y configuración sintética. |
| `pnpm lint` | Correcto, sin advertencias. |
| `pnpm typecheck` | Correcto, incluidos tipos de rutas Next. |
| `pnpm test` | **199 pasadas, cero fallos, cero omitidas** en la ejecución final. |
| `pnpm test:scripts` | **150 pasadas, cero fallos, 2 omitidas** por ausencia de stack acreditado; 152 pruebas declaradas. Incluye builds aislados de la suite existente. |
| `pnpm build` | Correcto, Next.js 16.4.2, `NODE_ENV=production`, `BIBLIB_TARGET=test`; salida `.next-test`. |
| `pnpm check:bundle` | Correcto: **39 archivos cliente revisados**. |
| Escaneo literal adicional de key sintética en `.next-test/static` | Correcto: 39 archivos, ninguna coincidencia; se devuelve solo el recuento. |
| `git diff --check` | Correcto. |

El build usó únicamente placeholders de CI: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55331`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=public-build-placeholder` y `SUPABASE_DB_URL=postgresql://postgres:placeholder@127.0.0.1:55332/postgres`. Se activó sintéticamente el flag Google con una key falsa durante el build en `BIBLIB_CATALOGUE_MODE=fixture`, para verificar que el valor no se incorporara al cliente. Antes del build se comprobó solo la inexistencia de los archivos privados que Next cargaría, sin leerlos. No hubo conexiones de dominio ni llamadas a Google Books.

Los fixtures `tests/fixtures/bibliography/google/volumes.json` y `empty.json` son construidos, con datos bibliográficos ficticios y sin keys. Las pruebas cubren ISBN-10/13 con separadores, múltiples ediciones, ISBN distinto/ausente/inválido/OTHER, registros incompletos, vacío, respuesta inválida, búsqueda, portada exacta y host seguro, 429/403/500/503, cooldown, timeout de fetch/cuerpo, cancelación previa, límites de bytes y JSON roto. Los espías prueban cero llamadas con flag apagado, clave ausente y fixture; se inspeccionan resultados, logs/telemetría y errores reflejados, además de las salidas del diagnóstico y fixtures, sin mostrar la clave sintética.

La prueba del gateway inyecta un store de coordinación simulado, verifica reservas Google y completions sin payload, y demuestra que búsqueda por texto no escribe caché privada y preview no escribe caché permanente. No se reejecuta aquí aceptación distribuida sobre Postgres real: esa infraestructura pertenece a U-DAT-05 y esta unidad no tiene stack asignado.

## Conciliación y límites

Se ajustaron expectativas legacy en commits aislados, con autorización del coordinador:

- `48e6681`: `tests/catalogue-gateway.test.ts` reconoce la nueva política Google y mantiene la comprobación de proveedor deshabilitado sin peticiones/caché. Autorización `msg_61dfa217fe7e`.
- `0768bd9`: `tests/bibliographic-catalog-providers.test.ts` cambia la expectativa O07 de adaptador inexistente (`notAttempted`) a key ausente en runtime (`misconfigured`), añadiendo fetch espía para impedir red. Autorizado por `msg_f33576e52fe0` y la respuesta a `orca orchestration ask`.

La primera suite completa dio 198/199 por esa expectativa antigua; tras la conciliación autorizada, la ejecución final pasa 199/199. No se cambió el comportamiento requerido para satisfacer una expectativa obsoleta.

U-BIB-04/05 deben integrar el aviso y selector antes del primer uso externo, aplicar derechos a los callers/mapper legacy y mantener Google fuera de `Book.cover`, persistencia y exportación mientras siga denegado. Se avisó al coordinador, que confirmó comunicarlo a U-BIB-04. No se tocaron `normalize.ts`, `types.ts`, alta, componentes `book-*`, import/export, acciones existentes, scripts DB ni E2E ajenos. La activación manual sigue pendiente como estado externo independiente: la entrega técnica se acepta apagada, según U-BIB-03.

Se contrastaron únicamente páginas públicas de documentación: [API Google Books](https://developers.google.com/books/docs/v1/using), [condiciones](https://developers.google.com/books/terms) y [privacidad](https://policies.google.com/privacy), el 23-10-2026. No se usaron como evidencia de tarifa o cuota fija, ni para inferir derechos de almacenamiento de imágenes.

No se ejecutaron pruebas de navegador con stack ni probes reales de catálogos. No se crearon, arrancaron, pararon ni modificaron contenedores, redes o volúmenes Docker; recursos dejados por esta unidad: **ninguno**. Sin push ni PR.
