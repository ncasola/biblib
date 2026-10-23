# U-BIB-01 · Contrato y orquestador bibliográfico

Implementación en la rama `u-bib-01`, hija de `feature/spec-pendientes`, sin stack ni tráfico bibliográfico real.

## Entrega

- Contratos TypeScript del documento 06, registro de capacidades, DTO validados y orquestador secuencial con orden configurable, sin duplicados y máximo tres fuentes.
- ISBN-10/13 validado antes de consultar y comparado de nuevo con los identificadores devueltos; se conservan los originales. La clave ISBN devuelta por Books API cuenta como identificador publicado cuando no hay un bloque `identifiers`; un bloque con ISBN distintos no se etiqueta como coincidencia.
- Búsqueda con máximo 8 segundos, máximo 3,5 segundos por fuente y portada con presupuesto independiente de 4 segundos. Los límites pueden reducirse por llamada; no ampliarse. La cancelación llega al fetch y a la espera del limitador.
- `notFound` exige al menos una fuente aplicable sana y ninguna fuente elegible fallida o pendiente. Con candidatos y fallos se conserva `found`, con `complete:false`; sin candidatos y con fallos se devuelve `incomplete`.
- Adaptador Open Library sobre el cliente existente, conservando el limitador por instancia y caché acotada. La caché mantiene la fecha de recuperación original. El adaptador fixture usa los JSON existentes mediante `lib/catalogue-fixtures.ts`, sin crear clientes live ni usar fetch.
- BNE y Google registrados sin adaptadores ni capacidades simuladas. En O07 BNE está apagado por defecto; una activación anticipada informa `notAttempted/unsupported`. Google activo sin clave informa `misconfigured`, sin peticiones.
- `compareCandidates` conserva conflictos de campos, incluida fecha; exige ISBN canónico exacto y rechaza señales incompatibles de idioma/formato. Ausencia de idioma/formato se conserva como evidencia desconocida; no se fusionan datos ni se calculan porcentajes.
- Política de derechos versionada `2026-10-23.1`: metadatos OL con TTL operativo de 3600 segundos, atribución y referencia de términos; preview de portada separada; rehosting, respaldo de imágenes y offline denegados. No se declara CC0 para las imágenes ni para todas las contribuciones; capacidades o versiones desconocidas quedan denegadas. BNE/Google permanecen denegados hasta sus entregas y revisión correspondiente.
- Acciones autenticadas `lookupIsbnAction` y `getCoverAction`, con el `ActionResult` existente. Los errores esperados usan los códigos actuales y conservan el agregado por fuente en `value` mediante una extensión estructural compatible del resultado de acción; un resultado encontrado parcial sigue siendo éxito.
- La ruta `/api/books/search` delega al servicio, conserva el DTO público `Book`, errores HTTP y cabecera `x-correlation-id`. Usa `getCover` separado para la portada. La página de alta ya llama esa ruta y no se ha modificado.
- `provider.request` registra proveedor, UUID `requestId`, duración y estado en `result`; excluye ISBN, contenido, URL y credenciales.

## Configuración

Solo se reconocen `BIBLIB_CATALOGUE_MODE`, `BIBLIB_OPEN_LIBRARY_ENABLED`, `BIBLIB_BNE_ENABLED`, `BIBLIB_GOOGLE_BOOKS_ENABLED`, `GOOGLE_BOOKS_API_KEY` y `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED`, junto al selector de destino `BIBLIB_TARGET`.

`local/test` usan `fixture` por defecto; `preprod/prod` usan `live` y rechazan `fixture` al cargar el servicio del servidor. Sin selector explícito se toma `NODE_ENV=production` como producción; el resto usa local. Las banderas OL/BNE/Google/revisión parten de `true/false/false/false` en O07. Una clave Google solo se consulta en servidor para diagnosticar configuración: no se exporta ni se incorpora a logs o URLs.

## Validación ejecutada

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | Correcto, sin advertencias. |
| `pnpm typecheck` | Correcto. La primera ejecución detectó que la ampliación de `ProcessEnv` de Next exige `NODE_ENV`; se corrigió el parámetro de configuración a un diccionario de solo lectura y la ejecución final pasa. |
| `pnpm test` | 96 pruebas pasadas, cero fallos y cero omitidas. Incluye 29 pruebas del servicio y adaptadores, la nueva prueba de telemetría y las suites existentes `open-library` y `book-search`. |
| `pnpm test:scripts` | Salida 0: 120 pasadas, 2 omitidas por ausencia de stack acreditado, cero fallos. No se levantó un stack para habilitarlas. |
| `pnpm build` | Correcto, con `BIBLIB_TARGET=test`, modo fixture y placeholders CI; salida `.next-test`. |
| `pnpm check:bundle` con `BIBLIB_TARGET=test` | Bundle cliente limpio: 29 archivos revisados. |
| `git diff --check` | Correcto. |

El build utilizó exclusivamente `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55331`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=public-build-placeholder` y `SUPABASE_DB_URL=postgresql://postgres:placeholder@127.0.0.1:55332/postgres`, con `NODE_ENV=production`. No se leyeron archivos privados ni se accedió a bases de datos.

La prueba fixture instala un fetch espía que falla ante cualquier llamada, con banderas externas activadas. Las pruebas de red live inyectan respuestas sintéticas; cubren ISBN exacto/distinto, 429, 5xx, JSON inválido, timeout y cancelación. Los casos del contrato cubren todos los estados, ninguna fuente habilitada, parcial encontrado más timeout, orden secuencial, conflictos y diagnóstico de errores de acción.

## Límites y conciliación

- U-BIB-05/O10 debe enrutar los caminos legacy de `app/actions/books.ts`, `lib/library-import.ts` y recuperación de portadas por el orquestador. Esos archivos, `lib/api-client.ts`, los tipos de dominio y el schema no se han modificado.
- U-BIB-02/O08 añade el adaptador BNE y amplía capacidades reales; U-BIB-03/O09 añade Google. La política BNE debe revisarse con su entrega. U-DAT-05 aporta coordinación/caché globales antes de declarar aceptación multiinstancia; U-DAT-10 añade controles de bytes/rehosting/backup/offline.
- La revisión visual y atribución persistida por campo corresponden a U-BIB-04. No se escribe procedencia ampliada incompatible con export/import actuales.
- El coordinador autorizó exclusivamente añadir `requestId` a la telemetría y su prueba, en commit separado, y convertir a relativos los dos imports JSON de `lib/catalogue-fixtures.ts` con su comentario. No se añadió `status` a la lista blanca.
- `app/api/books/search/route.ts` conserva la expresión original de mapeo HTTP de `DomainError`; el coordinador debe conciliar la sustitución por `httpStatusForDomainError` de U-DAT-01 al fusionar. No hay cambios en `app/books/add/page.tsx`, compartido con U-EXP-01.
- No se ejecutaron pruebas HTTP autenticadas/manuales con stack, ni probes de catálogos reales. No se crearon, arrancaron, pararon ni modificaron recursos Docker; redes y volúmenes dejados por esta unidad: ninguno.
