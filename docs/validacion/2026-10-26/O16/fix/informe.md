# O16-FIX · Correcciones antes de G16

Fecha: 26 de octubre de 2026. Rama `o16-fix`, worktree propietario de `test`. Base: `feature/spec-pendientes` con O16/U-QA-05 integrada. Solo servicios locales y cuentas sintéticas; no se ha leído ningún archivo de entorno ni operado sobre destinos remotos. No se modifican `unidades.json` ni `matriz-auditoria.md`.

## 1. Inicio: causa y medición de CLS

El observador detectó la inserción tardía de «Seguir leyendo» y «Tu lectura registrada» sobre estanterías ya pintadas, con desplazamientos de 152 y 247 px en la muestra de escritorio. El resumen inicial se resolvía antes de montar esos componentes, que entonces lanzaban otras acciones. Ahora el inicio conserva la reserva de carga inicial hasta resolver resumen, estanterías y las dos secciones de lectura; se muestran juntas. Cada fallo auxiliar conserva su mensaje y las estadísticas usan la zona del navegador. No se han cambiado fuentes ni `font-display`.

[Medidor reproducible](medir-inicio.mjs): usa directamente `runWebVitals` de `perf:local`, Chrome estable, 1280×800 DPR1 y 390×844 DPR3 con CPU ×4, es-ES, Europe/Madrid, tres contextos nuevos por perfil, carga fría/caliente y cambio de tema. Espera `networkidle` + 700 ms; CLS por ventanas de 1/5 segundos sin entrada reciente. Sesión GoTrue real de A ficticia, misma cuenta y datos en ambas mediciones, sin escrituras de dominio. Incluye otra navegación diagnóstica con fuentes de cada `layout-shift`.

| Perfil | CLS frío antes → después | CLS caliente antes → después | CLS con gestos antes → después | LCP frío después |
| --- | --- | --- | --- | --- |
| Escritorio | 0,118 → **0,004** | 0,118 → **0,004** | 0,118 → **0,004** | 776 ms |
| Móvil CPU ×4 | 0,037 → **0,000** | 0,037 → **0,000** | 0,037 → **0,000** | 1.416 ms |

Evidencia: [antes](inicio-antes.json), [después](inicio-despues.json). El peor CLS medido cumple `< 0,1`. Se mantiene el método de U-QA-05, pero A tiene lecturas registradas y no es la cuenta de escala 100/1.000/10.000 de la auditoría: su 0,159 histórico no se presenta como una nueva medición de este checkout. La pintura final espera los datos de lectura; LCP permanece bajo 2.500 ms y el contenido no cambia de altura después de mostrarse.

## 2. Next y AGENTS.md

Se comprobó `agentRules?: boolean` en `node_modules/next/dist/server/config-shared.d.ts` y su esquema booleano de primer nivel en `config-schema.js` (Next 16.4.2). Se fija `agentRules: false` en `next.config.mjs` y se retira la advertencia obsoleta del README.

[Comprobador](comprobar-agentes.mjs): arranca nuestro `next dev` con el wrapper local del perfil `test`, solicita `/login` (200), compara todos los bytes y termina solo el proceso que ha creado. [Resultado](next-dev-agentes.json): SHA-256 antes/después idéntico, `3dd0454233ecba7f006b9f5e993f41d62eb09fac53176688a220c15a3f83ae56`.

## 3. Paginación permanente

Se convierte el ensayo de U-QA-05 en [paginacion.spec.ts](../../../../../tests/e2e/flujos/paginacion.spec.ts). Comprueba 11 resultados en ambas páginas, filtro desde la segunda que vuelve a una sola coincidencia, 10 resultados con siguiente deshabilitada, página 2 inexistente que se normaliza, 1 resultado y 0 con «Limpiar filtros», recuento 0 a 0 y ambos controles deshabilitados. Utiliza fixtures compartidas, slugs exclusivos, sesión real y limpieza por dueño.

## 4. Proxy con Auth no disponible

`readProxySession` impone un plazo único de **6.000 ms**, que incluye `getUser`, renovación y lectura de sesión. Cancela el transporte de Supabase con `AbortSignal`, ignora cookies tardías y solo devuelve autenticación tras completar la verificación; cualquier error, incluido un usuario acompañado de error, cierra el acceso. No emite atestación ni sirve la ruta privada al expirar el plazo. Conserva la redirección existente a `/login?error=session&redirect=…`, el aviso de sesión y las cabeceras privadas; las rutas públicas siguen funcionando.

[Unitarias](../../../../../tests/proxy-session.test.ts): éxito, sesión ausente frente a error, fallo, servidor que ignora cancelación, resolución tardía y renovación atascada. [Caída real](../../../../../tests/integration/auth/caida-servicios.test.mjs): detiene solo el GoTrue registrado de `test`, conserva Kong vivo, exige redirección en menos de 9 segundos y comprueba `/login`, `/offline` y portada pública; recuperación en `finally`. El inventario estático de red reconoce este transporte de Auth, manteniendo la prohibición de hosts bibliográficos fuera de los adaptadores.

## 5. Pendientes y cobertura demostrada

Se conservan los recorridos existentes y se enlazan desde [pendientes.spec.ts](../../../../../tests/e2e/flujos/pendientes.spec.ts). No se transforma ningún `fixme` en una prueba vacía superada.

| Antiguo pendiente | Cobertura real |
| --- | --- |
| U-DAT-06: dos copias y libro sin ISBN | `integration/model/ejemplares.test.mjs`: dos copias del mismo ISBN; libro sin ISBN editado/exportado/restaurado |
| U-DAT-04: fallo sin datos parciales | `integration/restore/conjuntos.test.mjs`: error de última sentencia, timeout y observadores durante publicación |
| U-DAT-02: deshacer con cambios posteriores | `integration/snapshots/versiones.test.mjs`: segunda pestaña genera conflicto y nueva comparación permite restaurar |
| U-DAT-03: cerrar/reabrir | `integration/jobs/acciones.test.mjs`: progreso persistido, nueva sesión GoTrue, control y continuación; no afirma cierre físico del navegador |
| U-DAT-03: worker interrumpido y lease | `integration/jobs/trabajadores.test.mjs`: matar tras consultar y lease vencido/fencing |
| U-DAT-03: pausa/cancelación/reintento | `jobs/acciones.test.mjs`, `jobs/importacion.test.mjs`: pausa/reanudación, cancelaciones y respuesta perdida antes/después de commit |
| U-DAT-04: v1/v2 juntos | Nuevo caso en `restore/conjuntos.test.mjs`: mezclar formatos se rechaza sin publicar, según el contrato vigente |
| U-DAT-04: orden/repetida/ausente/alterada | `restore/conjuntos.test.mjs`: llegada inversa añadida al caso de 2.001 libros, defectos de partes y reintentos |
| U-DAT-04: IDs definidos | `snapshots/versiones.test.mjs`: deshacer con IDs propios; `model/ejemplares.test.mjs`: ida/vuelta de v2 con dos copias |
| U-DAT-10: objetos privados | `integration/assets/acceso.test.mjs`: A accede, B no lee ni firma, tampoco por Storage |
| U-OPS-03: borrado de cuenta | `integration/account/worker.test.mjs` y `restore.test.mjs`: borrado reintentable y no resurrección |
| U-PRO-01 | `e2e/flujos/personal.spec.ts`: cuatro recorridos de notas/etiquetas/valoración |
| U-PRO-03 | `e2e/flujos/ubicaciones.spec.ts`: árbol, asignación, foto privada y borrado explícito |
| U-PRO-05 | `e2e/flujos/series.spec.ts`: cuatro recorridos de orden y filtros |

Quedan **dos `fixme` explícitos**, sin declararlos verificados:

- **U-BIB-04, dueño de la unidad:** edición discrepante entre dos proveedores. El fixture del servidor aún no ofrece ese caso multifuente para un ISBN; ampliar el contrato de fixtures corresponde a la unidad. Las unitarias `bibliography-review.test.ts` prueban discrepancias y selección por campo, pero no acreditan ese recorrido con el orquestador real.
- **U-BIB-03, dueño de la unidad:** Google habilitado sin clave. La suite E2E usa catálogo fixture y Google apagado; necesita un arranque dedicado con red simulada y configuración habilitada sin clave. `bibliographic-catalog-google.test.ts` cubre la lógica unitaria. Google y toda comprobación remota siguen pendientes.

## 6. Enlace del generador

`report.mjs` busca el `informe.md` existente más cercano hacia los directorios padres, con rutas relativas y separadores portables. Si aún no existe análisis, mantiene el destino junto a las tablas. La prueba añadida cubre misma carpeta, dos niveles anidados y precedencia del informe específico, sin modificar informes históricos.

## 7. Seguridad documentada

`docs/seguridad.md`, pendientes 5 y 6, distingue lo verificado localmente en G13 y O15 (cámara, cachés, aislamiento A/B, purga y matriz 53/53) de la repetición pendiente en HTTPS/CDN/navegadores del alojamiento, enlazando su evidencia. No se cierra ninguna comprobación remota.

## 8. Intento de contención de scripts

Se ejecutó **`pnpm test:scripts` con su concurrencia predeterminada**, sin cambiar el script ni forzar `BIBLIB_SKIP_STACK_TESTS`. Resultado: **277 pruebas superadas, 0 fallos, 2 omitidas y la suite scratch omitida**, en 84,8 segundos. El grupo de promoción con TLS en Postgres efímeros propios pasó completo; se ejecutó sin commits concurrentes.

No se reprodujo el deadlock. Las pruebas que necesitan `scratch` lo rechazaron como no disponible/acreditado (migraciones: salida 4); este checkout solo tiene asignado `test` y no se arrancó ni modificó `scratch`. Por ello esta ejecución no permite negar la contención observada en U-QA-05, ni demostrar que haya desaparecido cuando varios archivos comparten `scratch`. Se mantiene el script tal cual y queda documentado el intento, conforme al punto 8. Si el coordinador vuelve a asignar ese perfil a una prueba de contención, debe repetir desde su raíz propietaria o serializar ese grupo.

## Validación final

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | Correcto ([registro](lint.log)). |
| `pnpm typecheck` | Correcto ([registro](typecheck.log)). |
| `pnpm test` | **525/525**, sin omitidas ([registro](test.log)). |
| `pnpm test:scripts` | **277 superadas, 0 fallos, 2 omitidas** y suite scratch omitida; concurrencia predeterminada ([registro](test-scripts-paralelo.log)). |
| `pnpm test:db` | Correcto, migraciones y SQL en contenedor aislado retirado al terminar ([registro](test-db.log)). |
| `pnpm build` | Correcto ([registro](build.log)). |
| `pnpm test:smoke` | Correcto, **12 comprobaciones** y contenedor efímero retirado ([registro](test-smoke.log)). |
| `pnpm docs:links` | **109 documentos, 844 enlaces relativos, 0 rotos** ([registro](docs-links.log)). |
| `pnpm test:integration:restore --profile test --reuse-build` | **12/12**, incluidos formatos mixtos y partes fuera de orden ([registro](integration-restore.log)). |
| `pnpm test:integration:local --profile test` | **291/291**, ninguna omitida; cuentas de Auth sin cambios y limpieza completa ([registro](integration.log)). |
| `pnpm test:e2e:local --profile test --reuse-build` | **86 superados, 0 fallidos, 0 repeticiones y 3 omitidos**, con sesión y cierre por dependencias; build del primer recorrido (solo cambió una aserción). Sin tráfico externo y cuentas de Auth intactas ([registro](e2e-chromium.log), [resumen y omitidos](e2e-resumen.json)). Dos omitidos son los `fixme` descritos y uno es la captura opt-in de U-UX-02. |
| `pnpm db:status:local --profile test` | **up-to-date**, head `0015`, ninguna pendiente, **864 comprobaciones correctas** ([registro](db-status.log)). |

El [primer intento completo de integración](integration-intento1.log) falló solo en la nueva fixture mixta: generaba dos estanterías predeterminadas diferentes y, correctamente, recibía ese rechazo antes del de formatos. Se corrigió la fixture para compartir estanterías y aislar el formato; el grupo de restauración pasó 12/12 y la repetición completa, 291/291. El nuevo ensayo real de Auth obtuvo la redirección en **6.007 ms** en el primer intento y **6.010 ms** en la suite final, sin servir datos privados; el acceso público con la cookie antigua también respondió 200 con el aviso de sesión.

El [primer recorrido completo de Chromium](e2e-intento1.log) pasó los bordes 11/10/1 y encontró un error en la aserción nueva del vacío: se esperaba que no existiera resumen, cuando la UI conserva «Mostrando 0 a 0 de 0 libros», «Página 0 de 0» y ambos controles deshabilitados. Se corrigió la prueba para verificar ese estado explícito; no se cambió la aplicación ni se añadieron reintentos automáticos. Se repite la suite completa con sus dependencias de sesión y cierre.

## Recursos y cambios de estado para el coordinador

El perfil `test` queda levantado, como se solicitó. No se ha arrancado ni detenido otro perfil ni tocado HolaERP. Los contenedores temporales de `test:db`, smoke y promoción pertenecen a sus runners y se limpiaron al finalizar. [Inventario final](recursos-finales.json): ocho contenedores `supabase_*_biblib-test`, red **`biblib-test-network`** y volúmenes **`supabase_db_biblib-test`**, **`supabase_storage_biblib-test`**; la app de pruebas se ha detenido (3148 libre). El E2E regeneró cinco artefactos históricos de impresión y axe; se restituyeron sus versiones originales porque quedan fuera del scope. No hay cambios finales en esas rutas.

El coordinador puede incorporar la evidencia del CLS, la prueba permanente UX-06, el límite de Auth y las correcciones documentales a G16. Los dos `fixme` de proveedores y el ensayo de contención con `scratch` disponible siguen con los límites descritos. La matriz y el registro de unidades quedan reservados al coordinador; nada remoto cambia de estado.
