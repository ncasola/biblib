# U-EXP-07 · Catálogo imprimible

Fecha: 26-10-2026. Rama de entrega: **`u-exp-07-stack`**, en el worktree `u-qa-01`, desde `u-exp-07`. Integra `feature/spec-pendientes` de forma aditiva (préstamos y offline), merge `784323a`; los conflictos conservaron ambas secciones de operación y todas las rutas privadas. Última corrección funcional: `2d001f9`, nombre accesible explícito del enlace de impresión de estantería.

## Entrega

- Acción «Imprimir catálogo» en los resultados y en cada estantería, sin reescribir `books-table.tsx`.
- Ruta privada `/books/print`, filtros compartidos de texto, estado, estantería, serie, etiquetas OR/AND y orden; «Volver» recupera página y vista originales.
- Selección de título, autor, ISBN, estado, ubicación física y notas cuando existan; portada desactivada inicialmente. Fecha del navegador, total y numeración de filas.
- Lectura por páginas de 100 con límite de 2.000 ejemplares. Un exceso pide filtrar y no ofrece impresión truncada. Se rechazan recuentos cambiantes, páginas incompletas e IDs repetidos durante la carga.
- Ubicaciones consultadas por los IDs de la página, propietario de sesión y RLS, hasta ocho niveles; no se confunden con estanterías lógicas. No existe filtro de ubicación en el listado actual, por lo que no se añade uno específico de impresión.
- CSS de papel aislado: negro sobre blanco, Fraunces e Inter, márgenes de 12 mm, controles ocultos, cabecera repetida y filas sin cortes.

## Validación final de la rama integrada

| Comando | Resultado |
| --- | --- |
| `pnpm install --frozen-lockfile` | Correcto, sin cambios de dependencias ni lockfile. |
| `pnpm lint` | Correcto en la rama integrada y después de la corrección accesible. |
| `pnpm typecheck` | Correcto en la rama integrada, incluidos los E2E nuevos. |
| `pnpm test` | 521/521 en la rama integrada, incluidas cinco pruebas nuevas de impresión; antes de integrar, 494/494. |
| `pnpm build` | Correcto con Turbopack, sin objetivo ni archivos de entorno, variables ficticias explícitas y DB en puerto local cerrado. |
| `pnpm test:e2e:local --check-untargeted-build` | Correcto antes de integrar: build temporal sin `.env`, 93 archivos estáticos revisados y sin credenciales ni acceso local. |
| `pnpm test:smoke` | Correcto en ambas ramas, 12 comprobaciones con Auth simulado y Postgres temporal; recursos del runner eliminados. |
| `pnpm test:scripts` | Correcto en la rama integrada: 273 ejecutadas, cero fallos, dos omitidas por falta de `scratch` acreditado; antes de integrar, 270 ejecutadas y dos omitidas. Incluye promoción contra un remoto simulado en contenedores propios, sin destinos remotos reales. |
| `pnpm test:e2e:local --profile test --project chromium --grep impresión` | 6/6 (dos sesiones GoTrue y cuatro recorridos de impresión), cero fallos, omisiones o repeticiones; run `7cd3dad7d81e`. |
| `pnpm test:e2e:local --profile test` | Correcto: 85 pasadas, 17 omisiones heredadas, cero fallos o repeticiones; run `caeec2b30af0`. Los cuatro recorridos de impresión pasan también aquí. |
| `pnpm test:integration:security --profile test` | 24/24, sin omisiones, run `3df6d7b2c24b`: GoTrue, Postgres, Data API, RLS, callback PKCE, sesiones, aislamiento y CSP. |
| `pnpm test:a11y:local --profile test` | 10/10, sin fallos, omisiones ni repeticiones, run `3436b902e25e`: axe en ambos temas, contraste, reflujo 320/375/768/1440 y zoom equivalente 200/400 %, diálogos y teclado. |

Las 17 omisiones del E2E completo corresponden a casos preexistentes de `pendientes.spec.ts` y a una captura opcional de la estantería 3D; se identifican en [el resumen](e2e-completo-resumen.json). No hay omisiones nuevas en impresión. La aceptación local de U-EXP-07 aporta la evidencia de impresión requerida para G15; la puerta conjunta corresponde al coordinador.

El primer lint detectó el efecto síncrono de fecha (corregido). La primera ejecución de scripts detectó el inventario ausente y un plan invalidado por un commit durante la prueba; la repetición con HEAD fijo pasó. El primer E2E focal falló porque el nombre accesible incorporaba un espacio antes de los dos puntos; se corrigió con `aria-label` explícito, se retiró la ubicación temporal de ese intento y la repetición y el E2E completo pasaron. No se ocultaron fallos con reintentos automáticos.

### Ajuste compartido mínimo

La prueba de inventario exigía registrar la ruta nueva en `scripts/security/headers-matrix.mjs`. Se consultó al coordinador (`msg_76f79b1ef09b`); al transcurrir diez minutos sin respuesta, se aplicó la regla conservadora explícita del encargo: añadir únicamente `/books/print` a la lista privada y su fila en `docs/seguridad.md`, en el commit aislado `5c9cb9a`. No se modifican cabeceras, permisos ni reglas de autenticación.

## Evidencia real

`tests/e2e/flujos/impresion.spec.ts` comprueba resultados vacíos, más de una página de consulta (105 IDs), título largo, estantería, notas y ubicación, serie/etiquetas, retorno y delegación en `window.print()`. Compara todos los IDs impresos con una consulta filtrada de la cuenta y excluye otra cuenta. Usa `page.emulateMedia({ media: "print" })`, verifica negro sobre blanco, cabecera repetida, filas sin cortes y ausencia de controles visibles.

- [PDF A4](catalogo-A4.pdf): 14 páginas, MediaBox 595,91998 × 842,88 puntos.
- [PDF Carta](catalogo-Letter.pdf): 14 páginas, MediaBox 612 × 792 puntos.
- [Captura con medio print](vista-print.png), inspeccionada visualmente: título largo completo, numeración y tabla legible sin navegación ni controles.
- [Metadatos de papel](papel.json): dimensiones, número de páginas, hashes y fuentes Fraunces e Inter embebidas en ambos documentos.
- Registros de [impresión](impresion.log), [E2E completo](e2e-completo.log), [seguridad](seguridad.log), [accesibilidad](accesibilidad.log), [lint](lint.log), [tipos](tipos.log), [unitarias](unitarias.log), [scripts](scripts.log), [build](build.log) y [smoke](smoke.log).
- Resumen y mediciones de accesibilidad: [10/10](a11y-resumen.json), [contraste](a11y-contraste.json) y [reflujo](a11y-reflujo.json).

## Límites y pendientes explícitos

- No se ha probado una impresora física ni el diálogo nativo de impresión; la prueba de cancelación sustituye `window.print` por una función que retorna y comprueba que la URL permanece igual.
- Firefox y WebKit no ejecutados en esta unidad; la validación corresponde a Chromium/Chrome.
- No se añade migración, persistencia de preferencias ni generación de PDF en el servidor.

## Recursos y seguridad

No se levantó ningún perfil desde `u-exp-07`, ni se leyeron o copiaron secretos ni se tocaron bases remotas. El smoke y los scripts limpiaron sus contenedores temporales. El coordinador cedió el perfil `test` ya levantado en `u-qa-01` y ordenó **dejarlo levantado**: se conserva la red `biblib-test-network`, los volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`, y los ocho contenedores `supabase_{studio,pg_meta,storage,rest,inbucket,auth,kong,db}_biblib-test`. Los runners detienen únicamente sus propios procesos de aplicación y limpian los datos ficticios de sus runs. No se gestionaron los perfiles `main`/`scratch` ni se detuvo o modificó ningún recurso de HolaERP. La evidencia histórica de préstamos y accesibilidad regenerada por las suites se devolvió a HEAD; las mediciones nuevas de contraste y reflujo se guardan aquí, sin reescribir los informes originales.
