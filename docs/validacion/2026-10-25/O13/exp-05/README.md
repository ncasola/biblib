# U-EXP-05 · Alta consecutiva y cámara ISBN

Implementación del 25 de octubre de 2026 en `u-exp-05`, hijo de `feature/spec-pendientes`. No cambia schema, Server Actions ni dependencias y no utiliza perfiles Supabase desde este worktree.

Código validado: `f9ecfc4` (escáner/cabeceras) y `99a90fb` (alta consecutiva y recorridos); ajustes del harness separados en `acddfc4` y `d82a858`. El commit documental posterior solo incorpora esta evidencia y la sección de operación.

## Entrega

- Alta manual, resultado ISBN y revisión bibliográfica ofrecen **Guardar y añadir otro**. El éxito del libro anterior se anuncia con su título y enlace; solo entonces se limpian campos, autores/editoriales, portada e ISBN/comprobación. Estado y estantería se conservan en memoria de la pantalla y el foco vuelve al primer campo. Salir o recargar termina las preferencias.
- Fallo de guardado conserva el borrador. Un cierre síncrono evita dos envíos antes del render de React y la clave de idempotencia permanece al reintentar. Se renueva al montar el formulario del siguiente libro. Los duplicados muestran la ficha existente y el control explícito de otra copia de U-DAT-06, también si aparece un conflicto al guardar desde revisión.
- Escáner local opcional, sin dependencias, mediante `BarcodeDetector`/`ean_13`. Comprobar compatibilidad no pide permiso; **Escanear ISBN con cámara** solicita solo vídeo. Longitud y checksum se validan con `normalizeIsbn`; muestra el código canónico, exige **Usar este ISBN** y después **Buscar libro**. Nunca marca comprobación física ni almacena/envía fotogramas.
- Detener, desmontar, cambiar de tab del formulario, ocultar la página, detectar ISBN o agotar 30 segundos libera la captura. Una concesión de permiso tardía se descarta y sus pistas se paran. Si no hay soporte o permiso, ISBN escrito y alta manual siguen disponibles.
- `camera=(self)` solo en `/books/add`; resto `camera=()`, sin ampliar permisos de micrófono ni otros dispositivos. Matriz de seguridad y pruebas actualizadas. La política del documento inicial sobrevive a navegación cliente: si bloquea cámara, se ofrece abrir el alta en otra pestaña conservando el borrador actual.
- `BIBLIB_ISBN_CAMERA=1` habilita la UI; otros valores la apagan sin afectar ISBN/manual. Lectura de servidor por petición. Operación/retirada documentadas en la sección propia añadida a `docs/operacion.md`.

## Verificación ejecutada

| Comando | Resultado y evidencia |
| --- | --- |
| `pnpm lint` | Exit 0, sin avisos: `lint.log`. |
| `pnpm typecheck` | Exit 0; incluye compilación de los ocho recorridos nuevos: `typecheck.log`. |
| `pnpm test` | Exit 0; 378/378, sin omitidas: `unit.log`. |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | Exit 0; 251 superadas, 2 de stack omitidas, 0 fallos (253): `scripts.log`. No se atribuye éxito a las omitidas. |
| `pnpm build` | Exit 0, build sin objetivo con valores públicos/DB ficticios en loopback puerto 9, sin conectar: `build.log`. Antes se comprobó que no había archivos de entorno en el worktree; no se leyeron secretos. |
| `pnpm check:bundle --forbid-local-login` | Exit 0; bundle sin acceso local ni material privado: `bundle.log`. |
| `pnpm test:smoke --artifacts=docs/validacion/2026-10-25/O13/exp-05/smoke` | Exit 0, 13 grupos: `smoke.log`, `smoke/report.json`, build/log del servidor y capturas. Build temporal sin archivos de entorno, Auth simulado y Postgres efímero propio; sin solicitudes externas. No sustituye GoTrue/Storage reales. Se omiten del repositorio las descargas JSON voluminosas del fixture. |

Pruebas nuevas sin stack: `tests/isbn-camera.test.ts` (capacidad, EAN compatible/no compatible, permiso denegado, checksum/longitud/guiones, parada con permiso tardío, cierre síncrono y timeout), `tests/book-entry-ui.test.ts` (bandera, entrada ISBN, valores de sesión y acción accesible), `tests/book-entry-duplicates.test.ts` (ficha existente sin escritura y copia explícita). Las reglas de Next y la matriz verifican el privilegio por ruta.

## Integración pendiente del coordinador

Los ocho recorridos de `tests/e2e/flujos/alta-consecutiva.spec.ts` **compilan, pero no se han ejecutado aquí con Supabase real**: consecutiva/defaults, error y doble toque, duplicado, denegación seguida de alta manual, detección/confirmación, incompatibilidad, parada/desmontaje y documento nuevo tras navegación cliente. Ejecutar en el worktree dueño de `test`, por ejemplo `pnpm test:e2e:local --grep 'alta consecutiva|cámara'`, y después la suite integrada de G13. La matriz real de cabeceras se ejecuta allí con `pnpm security:headers:local --profile test`. No se afirma superada G13 con estas pruebas aisladas.

Pendientes manuales: cámara física en HTTPS/navegador compatible; permiso nativo, móvil, teclado y lector de pantalla en los estados nuevos. Se conservan los límites de `docs/accesibilidad.md`; no se declara certificación ni compatibilidad física por los mocks de Playwright.

## Ajustes compartidos y coordinación

La pregunta `msg_e3a39c8447aa` pidió el ajuste mínimo del runner para activar la bandera. Tras 10 minutos sin respuesta se aplicó la alternativa conservadora obligatoria del encargo, en commits aislados: `acddfc4` activa únicamente `BIBLIB_ISBN_CAMERA=1` en `tests/e2e/run.mjs`; `d82a858` admite expresamente solo el valor `1` en `scripts/next-target.mjs`, porque el filtrado de entorno del wrapper eliminaba la capacidad antes de llegar a Next. La prueba de `nextEnv` comprueba valores apagados y la excepción estrecha. Se notificó por `escalation` (`msg_927b229a4c28`). No se amplía la herencia de otras variables y la app normal permanece apagada por defecto.

`BookForm` incorpora solo dos props opcionales (`entryDefaults`, `onSaveAndAddAnother`) y el cierre de envío; no añade notas/tags/rating ni reorganiza sus campos, para facilitar U-PRO-01. No cambia `createEditionAction` ni otro contrato de dominio.

## Recursos

No se arrancó, paró ni alteró ningún perfil Supabase (`main`, `scratch`, `test`) ni recursos ajenos. El smoke creó y retiró su propio Postgres efímero; no deja contenedores, redes ni volúmenes propios nuevos. Los demás recursos Docker no se modificaron. Sin push ni PR; árbol final commiteado.
