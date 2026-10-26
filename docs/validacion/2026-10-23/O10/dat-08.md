# U-DAT-08 · Búsqueda por título y autor

Fecha: 23-10-2026. Rama: `u-dat-08`, worktree propio, sin Docker ni acceso remoto. Implementación disponible detrás de `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED`; la aceptación con servicios reales queda pendiente de la puerta integrada.

## Cambios

- Añadidas al final de `app/actions/bibliography.ts` las acciones `searchBibliographyAction`, `loadEditionCandidatesAction` y `prepareCandidateLinkAction`. Sesión obligatoria antes de consultar, validación estricta sin `user_id`, mínimo de tres letras/números Unicode, título hasta 300 caracteres, autoría hasta 200, páginas enteras y tamaños 10/20. Máximo configurable `BIBLIB_BIBLIOGRAPHY_MAX_PAGE=20`, acotado a 1–100.
- Consultas por el orquestador y su gateway, con dueño tomado de la sesión. Las claves privadas incluyen consulta/página/tamaño/idioma antes del HMAC por dueño. Los DTO solo contienen bibliografía pública, claves opacas y estados de proveedor.
- Tokens AES-256-GCM por cuenta, con clave derivada del secreto de caché servidor, caducidad de 15 minutos y un identificador que liga obra y consulta. No aceptan URL arbitraria, claves ajenas, alteradas, de otra consulta o caducadas. En `live`, falta de secreto falla cerrada. El secreto fijo del modo fixture sirve solo para datos sintéticos de local/test.
- La preparación no escribe. Una obra no aporta ISBN al ejemplar; «No sé la edición», ediciones sin ISBN o con varios ISBN canónicos distintos producen `manual-<uuid>`. Ninguna similitud marca `isbnVerified`; la revisión U-BIB-04 conserva la comprobación física explícita de la persona. El destino opcional exige UUID y versión vigentes, con lectura de la acción existente bajo RLS; el caller debe escribir mediante el CAS existente.
- Nueva sección accesible en español, montada con dos líneas en `/books/add/page.tsx`, con envío explícito, resultados y ediciones paginados, procedencia, estados separados y revisión antes de guardar. La entrada manual conserva el texto actual; cancelar, desmontar o iniciar otra interacción invalida las respuestas anteriores mediante una señal compartida. Los identificadores internos manuales no se presentan en el campo ISBN.
- OL: página/tamaño, offset de ediciones, idioma documentado, metadatos mínimos y tolerancia a título ausente/ID de obra con o sin prefijo. BNE: `startRecord`, páginas SRU de diez (dos como máximo para tamaño veinte), sin caché de texto por URL. El parser MARC admite una respuesta vacía después del total, conservando límites, validación XML y rechazo de una primera página vacía incoherente.
- El fixture sirve obras homónimas y ediciones parciales sin `fetch`, incluso con flags de BNE/Google activos. No se habilita Google ni se modifica su política de derechos.

## Propiedad y coordinación

La pregunta `msg_c1466ee5bbb6` solicitó la ampliación mínima necesaria porque los tipos y claves del orquestador no transportaban paginación. Sin respuesta durante el trabajo se aplicó la alternativa conservadora que prescribe el despacho: cambio aislado de tipos opcionales, claves del orquestador, fixture y núcleo inyectable del contrato. También se añadió el pequeño helper cliente de cancelación/borrador y la opción `startRecord` del parser MARC para distinguir el final de la paginación de una caída. Estas ampliaciones se señalan expresamente para la integración.

No se han modificado `lib/library-import.ts`, `lib/api-client.ts`, `app/actions/cover-recovery.ts`, `components/cover-recovery-panel.tsx`, E2E de proveedores, cabeceras, `next.config.mjs`, `proxy.ts`, schema, dependencias ni lockfile. Se añadió únicamente una sección al final de `docs/operacion.md`. Los contratos de lookup ISBN y la UI de revisión existente permanecen compatibles con las pruebas anteriores.

## Cobertura

| Aceptación | Evidencia |
| --- | --- |
| Contrato, sesión requerida, flag y entrada acotada | `tests/title-author-search.test.ts`, núcleo real inyectable que usan las tres acciones |
| Unicode/tildes, campos opcionales y pagina/tamaño/idioma | Normalización NFC, entrada inválida sin llamadas, claves diferentes por página, URL de OL y SRU de BNE |
| Homónimos, obras y ediciones parciales | Fixtures sintéticos; candidatas separadas, sin ISBN de obra ni verificación inferida |
| Consultar ediciones, claves válidas y cuenta destino | Consulta/obra ligadas, UUID/versión y rechazo de referencia o selección ajena/caducada |
| 429, timeout, red bloqueada, ausencia y misconfigured | Respuestas simuladas y `title-author-failures.json`; estados separados, sin selección silenciosa |
| Aislamiento A/B y caché privada | Mismo texto genera dos entradas HMAC privadas; segunda cuenta no reutiliza la caché de la primera, y tokens ajenos son rechazados |
| Respuesta tardía/cancelación | Promesa diferida y gestor de señales real compartido por la UI; la selección nueva se conserva |
| Entrada manual y compatibilidad | Se conservan título/autor; `manual-<uuid>` pasa el validador y la ida/vuelta exportación/importación |
| Accesibilidad y envío explícito | SSR real de ambos componentes con controles etiquetados, roles, paginación y acciones que fallarían si se invocaran al renderizar |
| Fixture sin red y Google apagado | Cero `fetch` con flags activos en fixture y ausencia de fallback Google tras un 429 de OL en live simulado |

La comprobación de sesión en estas pruebas es inyectada; no acredita GoTrue real. No se ha ejecutado navegador interactivo para esta sección. Auth local, recorrido real de alta provisional/edición y el smoke completo deben ejecutarse en el perfil autorizado del coordinador.

## Comandos ejecutados

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | Correcto, sin advertencias tras corregir la inicialización del ref |
| `pnpm typecheck` | Correcto |
| `pnpm test` | Correcto: **265/265**, 0 fallos y 0 omitidas; incluye 15 pruebas nuevas |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | Correcto: 180 superadas, 2 omitidas, 0 fallos; incluye dos builds de aislamiento |
| `pnpm build` con placeholders públicos de CI | Correcto tras cerrar cambios: compilación, TypeScript y generación de las 15 páginas |
| `pnpm check:bundle --forbid-local-login` | Correcto: 38 archivos cliente limpios, sin formulario de acceso local |
| `DOCKER_HOST=npipe:////./pipe/biblib-dat08-no-docker pnpm test:smoke --artifacts=.biblib/dat-08-smoke` | **No superado**, exit 1: el smoke exige Docker. Se aisló expresamente el daemon para respetar «sin Docker»; no se levantó ningún contenedor. Diagnóstico en `.biblib/dat-08-smoke/` |

No se presenta el smoke fallido ni los casos reales pendientes como aceptación superada. La escalación `msg_13013a09ad3b` informó al coordinador de la necesidad de correr ese smoke en la puerta integrada o autorizar sus recursos efímeros.

Se solicitó esa decisión por `orca orchestration ask`, mensaje `msg_ce0cc2cd03d1`, con el código ya commiteado y revisable. Sin autorización no se conecta el smoke al daemon Docker real; la opción conservadora es conservar la restricción y dejar la comprobación al coordinador. Logs locales de las últimas ejecuciones: `.biblib/dat-08-{lint,typecheck,unit,scripts,build}.log`.

Commits de implementación: `ff6d77f` (contrato de paginación/proveedores/fixtures, ampliación auxiliar aislada), `13618e1` (acciones, tokens, núcleo y pruebas de contrato), `d33c724` (montaje y componentes accesibles) y `0acab46` (mensaje de conexión siempre en español).

## Rollout y recuperación

1. Integrar y validar esta rama junto con U-BIB-05, conservando el transporte de página/tamaño/idioma y la caché privada. Revisar conflictos del núcleo bibliográfico antes de activar el flag.
2. Mantener Google apagado; con modo fixture probar «Árbol»/«María Núñez», consulta de ediciones, elección provisional, revisión manual y guardado en el perfil autorizado.
3. En live, compartir `BIBLIB_CATALOGUE_CACHE_SECRET` entre instancias y verificar la coordinación de cuota U-DAT-05. La búsqueda privada paginada omite la caché por URL del adaptador; los contratos legacy anteriores permanecen para U-BIB-05.
4. Desactivar `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED` retira la sección y rechaza las acciones nuevas; las fichas existentes y la entrada manual siguen disponibles. No requiere rollback de datos.

Recursos Docker creados o dejados por esta unidad: **ninguno** (contenedores, redes y volúmenes). No se han leído ni copiado `.env*`, no se han utilizado secretos reales y no se ha conectado a ninguna base remota.

Referencia consultada para el transporte de consulta/idioma/paginación: [Open Library Search API](https://openlibrary.org/dev/docs/api/search).
