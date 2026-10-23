# Entornos, CI y artefactos · U-QA-04

La validación local de los workflows no acredita una ejecución en GitHub. La entrega de PR está preparada; el cierre de U-QA-04 requiere subir la rama y abrir PR, a decisión de Néstor, y conservar el enlace a una ejecución real. No se ha hecho push, creado PR, configurado secretos ni accedido a un proyecto remoto.

| Objetivo / perfil | Identidad y puertos | Qué puede tocar cada job | Artefacto |
| --- | --- | --- | --- |
| Sin objetivo | Placeholders `example.supabase.co`, sin conexión | `ci.yml`: frozen install, lint, tipos, unitarias, scripts, build, bundle sin acceso local | `.next`, manifiesto `target: untargeted`; solo evidencia, no desplegable |
| `local` / `main` | `biblib-local`, 55320–55329, app 3147 | Desarrollo en checkout principal; ningún job CI | `.next-local`, huella propia |
| `local` / `test` | `biblib-test`, 55330–55339, app 3148 | PR y cierre: bootstrap/migraciones, fixtures ficticios, integración y E2E; reconstrucción solo en runner descartable de cierre | `.next-local`; no reutilizar tras cambiar claves/identidad |
| `local` / `scratch` | `biblib-scratch`, 55340–55349, app 3149 | Solo worktree autorizado por coordinación; CI no lo usa | Estado propio, nunca compartido |
| `test` (harness explícito) | Variables sintéticas construidas por la prueba | Pruebas unitarias de aislamiento y builds; no equivale al perfil `test` real | `.next-test` |
| `preprod` | Referencia Supabase pendiente | Solo promoción manual con environments protegidos `preprod-plan` y `preprod`; jobs deshabilitados | `.next-preprod` construido para ese proyecto |
| `prod` | Referencia no inspeccionada | Solo promoción manual independiente con environments protegidos `prod-plan` y `prod`; jobs deshabilitados | `.next-prod` construido para ese proyecto |

Los jobs locales no tienen `environment`, referencias a `secrets`, `supabase link` ni credenciales remotas. El token de GitHub tiene únicamente `contents: read`; checkout no conserva credenciales. Se usa `pull_request`, nunca `pull_request_target`. Las migraciones de PR se limitan a bases locales ficticias; ninguna fase de instalación, build o arranque ejecuta migraciones remotas ni locales por su cuenta.

## Orden y aislamiento de PR

`.github/workflows/ci.yml` ejecuta: `pnpm install --frozen-lockfile` → lint → typecheck → test → test:scripts → contratos CI → build sin objetivo → `check:bundle --forbid-local-login` → identificar artefacto → bootstrap `test` → test:db → test:integration:local → Chromium → test:smoke. `test:db` usa su Postgres efímero propio; integración/E2E usan los servicios Supabase reales del perfil `test`. El smoke conserva sus escenarios complementarios y usa Auth simulado, sin sustituir los E2E reales.

Node 24.11.1, pnpm 10.32.1 (`packageManager`), Supabase CLI **2.117.0** y Playwright **1.64.1** proceden de las versiones fijadas del repositorio. Chromium usa el canal `chrome`: se instala Chrome, no solo el navegador Chromium de Playwright. Se respeta una ventana de 310 s entre integración y E2E por el limitador GoTrue; no se desactiva la limitación para pasar CI.

La concurrencia cancela versiones obsoletas del mismo PR. El paso `always()` de limpieza usa `db:local:down --profile test`: valida propiedad de raíz, red y recursos antes de parar; no existe una limpieza Docker global. Los runners alojados de GitHub son descartables; el wrapper conserva los volúmenes propios hasta que se retira la VM. Una terminación forzosa del runner no garantiza ejecutar pasos finales, por lo que no se configura un runner compartido permanente con este diseño.

La caché pnpm se vincula al lockfile. La caché Docker contiene únicamente imágenes Supabase/Postgres, con clave de plataforma, versión CLI y configuración; no contiene volúmenes, `.temp`, `.biblib`, conexiones ni archivos de entorno. No se comparte entre jobs remotos y locales.

## Cierre semanal y de ola

`extended.yml` admite ejecución manual y cron semanal. Se debe fijar `BIBLIB_PREVIOUS_SCHEMA_COMMIT` o el input manual a un SHA completo anterior, ancestro del commit actual y con un prefijo **estricto e idéntico** del historial. No se utiliza `HEAD^` arbitrariamente, ni se recorta un journal para simular una versión anterior. La ausencia de ese SHA falla de forma visible antes de levantar Docker.

El job cambia al checkout anterior, instala su lockfile y hace bootstrap con fixtures anteriores; avanza en la **misma raíz** al commit actual, reinstala y aplica un plan de upgrade con `--expect-plan`. Comprueba integración, reconstruye físicamente los recursos ficticios registrados con un plan de reset de solo lectura y vuelve a comprobar integración desde cero. No se usa un dry run que ejecute y deshaga DDL. Conserva planes y recibos locales.

Firefox y WebKit se descargan según Playwright; se reconstruye la base entre navegadores para separar fixtures y la ventana de Auth, y se vuelve a construir después de la segunda reconstrucción para acreditar posibles claves nuevas. La auditoría automática axe-core 4.14.0, instalada fuera del repositorio sin cambiar su lockfile, revisa `/login` en claro/oscuro con reglas WCAG 2 A/AA y 2.1 A/AA. Una infracción falla el job; los resultados incompletos quedan registrados para revisión humana. Esta auditoría acotada no acredita accesibilidad completa de las pantallas privadas.

El paso de escala usa el contrato acordado de U-QA-03: `pnpm perf:local --profile test --scale 1000 --out .biblib/ci/perf --json`. Si aún no existe, escribe **pendiente**, nunca un resultado de escala superado. Si existe, conserva los resultados estructurados y falla ante error, informe ausente o presupuesto `over-budget`; la incidencia se debe resolver o aceptar expresamente antes de cerrar la ola.

## Identidad del release y evidencia

`pnpm ci:release create untargeted|preprod|prod` exige un checkout limpio y escribe `.biblib/ci/release.json` con commit Git completo, SHA-256 del lockfile, hash del journal, tags/timestamps/checksums de todos los SQL, `BUILD_ID`, objetivo, huella pública y checksums de los archivos del build y `public`. Excluye la caché de compilación. `ci:release verify <target>` recalcula todo y comprueba además `assertBuildTarget`: cambiar bytes, añadir/quitar un archivo, cambiar commit, lockfile o historial da salida **6**; cambiar destino/huella o introducir enlaces da **3**; historial inválido da **5**. No se normalizan ni reescriben migraciones ya aplicadas.

La huella actual de U-INF-02 incluye la raíz del checkout y el perfil. Los dos jobs alojados usan la misma ruta de repositorio; al adaptar otro alojamiento se debe conservar ese contrato o revisar el wrapper mediante su unidad propietaria. Un cambio de ruta no autoriza omitir la verificación. La huella identifica configuración, no constituye una firma criptográfica de procedencia; la confianza depende del commit autorizado y del artefacto inmutable de esa ejecución de GitHub.

`ci:collect` publica solo una lista permitida: manifiesto del release, checksums del historial, planes/recibos locales del perfil `test`, estados reales de los pasos, recuentos E2E (superados, conocidos, pendientes, fallos y repeticiones), resultados de accesibilidad/escala y PNG ficticios. Añade `SHA256SUMS`. No sube sesiones, fixtures privados con contraseñas, `.env*`, trazas, HTML con adjuntos, logs de app, backups ni listados de corrección remotos. Las credenciales de fixtures siguen siendo privadas aunque sus cuentas sean ficticias. La evidencia de PR/cierre se retiene 14 días; registrar enlaces y resultados de cada puerta de ola antes de que expire.

## Promoción deshabilitada y condiciones de activación

`promote.yml` tiene solo `workflow_dispatch` y **ambos jobs llevan `if: ${{ false }}`**. No basta con crear una variable para activarlos: se necesita un cambio revisado del workflow y autorización de Néstor. La selección `preprod|prod` produce ejecuciones y binarios independientes. Producción solo se autoriza tras aceptar preproducción del mismo commit/lockfile/migraciones; comprobar y registrar esa aceptación forma parte de la autorización del release.

La plantilla: checkout de SHA completo → frozen install → `build:<target>` → bundle sin acceso local → sellado/verificación → `db:plan:<target>` → artefacto con plan y hash en el resumen → revisión del entorno de aplicación → recuperar el **mismo** binario y plan → verificar huella/checksums → `db:migrate:<target> --expect-project ... --expect-plan <hash revisado> --backup-receipt ...` → status y nueva verificación. No reconstruye en el job de aplicación. Un plan de adopción excepcional se rechaza y se resuelve por el procedimiento separado de U-INF-07.

Configurar las reglas de protección fuera del YAML: revisores obligatorios, ramas autorizadas y prohibir autoaprobación, comprobando que el plan contratado de GitHub lo admite. El entorno `*-plan` permite acceso de solo planificación del runner; el entorno de aplicación exige revisar el hash concreto del plan, no solo el commit. La caducidad es de 30 minutos: si la revisión tarda más, el runner rechaza el plan y se repiten planificación y revisión. Nunca se amplía la caducidad en CI.

| Configuración futura por environment | Finalidad |
| --- | --- |
| Variable `BIBLIB_EXPECT_PROJECT_REF` | Identidad permitida del proyecto |
| Variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Configuración pública específica que queda incorporada al binario |
| Secreto `SUPABASE_DB_URL` | Conexión administrativa del mismo proyecto; directa o pooler de sesión |
| `SUPABASE_DB_SSLMODE=verify-full` | TLS y validación del nombre obligatorios |
| Opcional `SUPABASE_DB_SSLROOTCERT` | CA provisionada de forma segura si no basta el sistema |
| Variable `BIBLIB_BACKUP_RECEIPT_PATH` | Ruta privada del recibo, inventario y ensayo provisionados en el runner de aplicación |
| Credenciales/adaptador del almacenamiento privado y del alojamiento | Pendientes de elegir, autorizar e implementar; no se crean en esta entrega |

Antes de quitar los `false` faltan: destinos e identidades autorizados; respaldo remoto real con recibo U-OPS-02 y restauración ensayada; mecanismo privado que provisione recibo, archivos e informe sin publicarlos como artifacts; despliegue del mismo binario expandido compatible y smoke real del alojamiento; aceptación de preproducción; reglas de protección verificadas y CI real. El último paso de la plantilla sale con **2** hasta implementar publicación/verificación: no declara un despliegue ficticio. No se ha creado ninguno de esos secretos o environments.

Ante hash/destino/historial distintos se detiene antes de DDL con los códigos de U-INF-04/07. El runner relee el estado bajo bloqueo y escribe el registro de promoción con head anterior/posterior. Si se aplicó con verificación fallida, no se reaplica: seguir [promoción](../promocion.md) y [recuperación](../recuperacion.md), conservando la app anterior compatible o resolviendo hacia delante. Nunca se improvisa SQL inverso.

Referencias oficiales consultadas para la configuración: [checkout v4](https://github.com/actions/checkout/tree/v4), [upload-artifact y archivos ocultos](https://github.com/actions/upload-artifact/tree/v4), [protecciones de environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) y [axe CLI/core](https://github.com/dequelabs/axe-core-npm). Las actions v4 existen; esta entrega no presupone que las referencias v7/v6 anteriores fueran ejecutables.
