# U-EXP-07 · Catálogo imprimible

Fecha: 26-10-2026. Rama de implementación: `u-exp-07`, hija de `feature/spec-pendientes`.

## Entrega

- Acción «Imprimir catálogo» en los resultados y en cada estantería, sin reescribir `books-table.tsx`.
- Ruta privada `/books/print`, filtros compartidos de texto, estado, estantería, serie, etiquetas OR/AND y orden; «Volver» recupera página y vista originales.
- Selección de título, autor, ISBN, estado, ubicación física y notas cuando existan; portada desactivada inicialmente. Fecha del navegador, total y numeración de filas.
- Lectura por páginas de 100 con límite de 2.000 ejemplares. Un exceso pide filtrar y no ofrece impresión truncada. Se rechazan recuentos cambiantes, páginas incompletas e IDs repetidos durante la carga.
- Ubicaciones consultadas por los IDs de la página, propietario de sesión y RLS, hasta ocho niveles; no se confunden con estanterías lógicas. No existe filtro de ubicación en el listado actual, por lo que no se añade uno específico de impresión.
- CSS de papel aislado: negro sobre blanco, Fraunces e Inter, márgenes de 12 mm, controles ocultos, cabecera repetida y filas sin cortes.

## Validación ejecutada hasta este punto

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | Correcto tras corregir la sincronización de fecha local. |
| `pnpm typecheck` | Correcto, incluidos los E2E nuevos. |
| `pnpm test` | 494/494, incluidas cinco pruebas nuevas de impresión. |
| `pnpm build` | Correcto con Turbopack, sin objetivo ni archivos de entorno, variables ficticias explícitas y DB en puerto local cerrado. |
| `pnpm test:e2e:local --check-untargeted-build` | Correcto, build temporal sin `.env`, 93 archivos estáticos revisados y sin credenciales ni acceso local. |
| `pnpm test:smoke` | Correcto, 12 comprobaciones con Auth simulado y Postgres temporal; recursos del runner eliminados. |
| `pnpm test:scripts` (primera ejecución) | 268 correctas, dos fallos y dos omitidas: faltaba inventariar `/books/print` y un commit durante la prueba de promoción invalidó un plan ligado al HEAD. Pendiente repetir con HEAD fijo y la matriz actualizada. |
| `pnpm test:scripts` (repetición, HEAD `5c9cb9a`) | Correcto: 270/270 ejecutadas, cero fallos, dos omitidas porque `scratch` no está disponible/acreditado. Incluye promoción contra remoto simulado en contenedores temporales propios, sin conectar con destinos remotos reales. |
| E2E de impresión con Supabase real | Pendiente del turno de `stack-test`, solicitado al coordinador. |

El primer fallo de lint y la primera ejecución de scripts se conservan como diagnóstico; no equivalen a aceptación. No se ha declarado superada G15 sin el turno de E2E real.

### Ajuste compartido mínimo

La prueba de inventario exigía registrar la ruta nueva en `scripts/security/headers-matrix.mjs`. Se consultó al coordinador (`msg_76f79b1ef09b`); al transcurrir diez minutos sin respuesta, se aplicó la regla conservadora explícita del encargo: añadir únicamente `/books/print` a la lista privada y su fila en `docs/seguridad.md`, en el commit aislado `5c9cb9a`. No se modifican cabeceras, permisos ni reglas de autenticación.

## Evidencia prevista en el turno real

`tests/e2e/flujos/impresion.spec.ts` cubre resultados vacíos, más de una página de consulta (105 IDs), título largo, estantería, notas y ubicación, serie/etiquetas, retorno y delegación en `window.print()`. Compara todos los IDs impresos con una consulta filtrada de la cuenta y excluye otra cuenta. Usa `page.emulateMedia({ media: "print" })`, comprueba que desaparecen los controles y genera `catalogo-A4.pdf`, `catalogo-Letter.pdf` y `vista-print.png` en este directorio.

## Límites y pendientes explícitos

- No se ha probado una impresora física ni el diálogo nativo de impresión; la prueba de cancelación sustituye `window.print` por una función que retorna y comprueba que la URL permanece igual.
- Firefox y WebKit todavía no ejecutados en esta unidad; no se acreditan por la ejecución de Chromium.
- No se añade migración, persistencia de preferencias ni generación de PDF en el servidor.

## Recursos y seguridad

No se ha levantado ningún perfil desde `u-exp-07`, ni se han leído o copiado secretos ni tocado bases remotas. El smoke y las pruebas de scripts crean y limpian sus contenedores temporales propios; no se dejaron contenedores propios activos tras ambos runners. Las redes `biblib-test-network`, `biblib-local-network` y `biblib-scratch-network`, y los volúmenes `supabase_db_biblib-{test,local,scratch}` y `supabase_storage_biblib-{test,local,scratch}` eran preexistentes y no se modificaron por gestión de stacks de esta unidad. No se detuvo ni modificó ningún recurso de HolaERP.
