# Incidencia durante la validación de U-EXP-02

El primer `pnpm db:local:bootstrap --profile scratch --json` completó la actualización
`0006_library_snapshots → 0007_saved_views`, el seed A/B y la verificación de Auth, Storage y
Mailpit. Su recibo devolvió `head.applied: 8`, `head.expected: 8`, `state: up-to-date` y
`manifest: true`. Los metadatos reales se capturaron en
[`objects-0007.json`](../../../../../tests/fixtures/migrations/objects-0007.json); su evaluación
contra el manifest produjo **261 comprobaciones y 0 fallos**.

Después, las consultas de estado local empezaron a fallar y los comandos básicos del host
tardaron minutos. Las dos primeras ejecuciones de `test:integration:views --profile scratch`
no llegaron a ejecutar pruebas: la primera falló en la consulta de estado previa al build
(salida 11 del runner), y la segunda en `resolveSeedTarget` (salida 8).

`db:local:status --profile scratch --json` informó:

```text
version.supabase: No se pudo consultar la versión fijada de supabase.
docker: Docker no está disponible; abre el motor manualmente y repite el diagnóstico.
```

Al no poder inspeccionar Docker, el diagnóstico presentó los puertos 55341/55342/55343/55344
como ocupados por un proceso ajeno (PID 28272). **No se detuvo ese proceso**: el diagnóstico
no permite inferir que el backend Docker sea un recurso ajeno ni autoriza terminarlo.

Un `docker ps` posterior sí devolvió los ocho contenedores de scratch: Studio, pg-meta,
Storage, PostgREST, Mailpit, Auth, Kong y Postgres. Todos los que tienen healthcheck figuraban
como `unhealthy`. Se solicitó la parada mediante `pnpm db:local:down --profile scratch --json`;
el resultado definitivo debe acreditarse antes de considerar el perfil detenido.

Se terminó exclusivamente el árbol del runner propio de `test:scripts` identificado con PID
41028, que seguía ejecutándose durante la degradación, y se inició una repetición con
concurrencia 1 y las omisiones documentadas de pruebas de stack/build. No se reinició Docker,
no se liberaron puertos y no se modificaron recursos de HolaERP ni del perfil test.

El coordinador recibió escalaciones y la pregunta `msg_9a528664065b`; tras agotar los primeros
600000 ms se continuó esperando la misma pregunta con `--resume`, sin duplicarla. La falta
de respuesta no se trató como autorización para modificar otros recursos.

La parada canónica terminó con salida 4 en preflight (consulta de pnpm). La CLI Supabase
local verificada como 2.117.0 tampoco pudo listar contenedores: Docker devolvió HTTP 500 en
`dockerDesktopLinuxEngine/v1.54/containers/json`. Ese intento terminó y recuperó el prompt.
La alternativa `detener-scratch.mjs --apply`, que exige identidad, lock y propiedad antes de
parar exclusivamente IDs registrados, terminó con salida 8 durante la consulta de Docker;
el recibo `parada-acreditada.json` indica `stopped: false`. No se eludió esa comprobación.

Las seis comprobaciones finales acotadas agotaron la espera. El build registró además
un fallo de creación de proceso de Turbopack con código Windows `0xc0000142`; la ejecución
de scripts registró subprocesos fallidos sin diagnósticos suficientes. Los resultados
completos del controlador están en `resultados-acotados.json`; no son una pasada verde.

Esta incidencia **no acredita** migración desde vacío, integración, build, smoke, SQL
completo ni parada final. Se cierra con aceptación fallida y recursos conservados, conforme
al informe de la unidad; la falta de respuesta del coordinador no es el motivo del fallo.
