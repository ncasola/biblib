# BibLib

Biblioteca personal con Next.js, React, Supabase y Drizzle ORM. Permite catalogar y editar libros, organizar estanterías, gestionar el estado de lectura y consultar la colección en tabla, cuadrícula o vista 3D.

La [spec de pendientes](docs/spec-pendientes/README.md) organiza el trabajo futuro en 45 unidades, cinco fases y 17 olas: Supabase local completo, scripts por entorno, varios proveedores ISBN, recuperación, UX y funciones de biblioteca. Es una propuesta; sus comandos nuevos todavía no están implementados.

## Desarrollo

Requiere Node.js 24, versión 24.11.1 o posterior dentro de esa rama, y pnpm 10.32.1. Consulta `.nvmrc` y `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Configura estas variables en `.env.local`, sin subir el archivo al repositorio:

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase para autenticación en servidor y navegador. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública de Supabase. Nunca introducir aquí una clave `service_role`. |
| `SUPABASE_DB_URL` | Conexión privada Postgres utilizada por la aplicación y las migraciones. Solo servidor. |
| `OPEN_LIBRARY_CONTACT` | Opcional: contacto real de quien mantiene el despliegue, incluido en el `User-Agent` de las consultas bibliográficas. |
| `NEXT_PUBLIC_ENABLE_ANALYTICS` | Opcional: `true` antes del build para habilitar Analytics; desactivado por defecto. |

El acceso utiliza Google OAuth mediante Supabase Auth. Registra los orígenes y callbacks de cada entorno. La [guía de operación](docs/operacion.md) explica conexión, migraciones, respaldo, restauración y privacidad.

## Catalogar y organizar

- Busca por ISBN o añade una ficha manual. Los ISBN se validan y normalizan; su equivalente de 10 y 13 dígitos identifica la misma edición a efectos de duplicados.
- Revisa título, autores, editoriales, fecha, páginas, portada, estado de lectura y estantería antes de guardar. Puedes corregir estos campos desde el detalle del libro.
- Si otra pestaña modifica la ficha, BibLib detiene la operación sobre la versión antigua. El formulario conserva el borrador y permite cargar explícitamente la versión guardada.
- Un ejemplar sin ISBN recibe un identificador interno manual; no necesita un ISBN inventado.
- La ficha conserva procedencia y si el ISBN ha sido comprobado físicamente. Marca la verificación solo después de contrastar la edición de tu ejemplar: encontrar una ficha o portada no la confirma.
- La estantería predeterminada permanece protegida. Puedes organizar libros en las demás estanterías y mover varios desde la colección.

## Importar y exportar

En **Ajustes**, seleccionar un archivo abre una revisión de cantidades, duplicados y portadas pendientes. La selección no inicia la importación. Se aceptan el JSON antiguo `{ books, shelves }` y el formato versionado:

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-10-22T12:00:00.000Z",
  "books": [],
  "shelves": []
}
```

Puedes elegir entre:

- **Fusionar**, opción inicial: añade los libros nuevos y omite los que ya existen por ISBN normalizado o identificador manual. Conserva sus datos actuales y une las estanterías con el mismo nombre.
- **Reemplazar**: sustituye libros y estanterías personalizadas tras una confirmación explícita. Conserva la estantería predeterminada local. Descarga antes una copia para poder recuperar la colección anterior.

Los límites son **8 MiB, 2000 libros y 200 estanterías por archivo**, además de las longitudes de campos validadas. Se rechazan referencias rotas y duplicados dentro del mismo archivo; no se truncan datos. Para restauraciones mayores, consulta el [procedimiento por partes](docs/operacion.md#restaurar-una-colección).

La exportación consulta los datos actuales y añade versión y fecha. Si la colección supera los límites, prepara varias partes JSON y muestra un botón para descargar cada una; conserva también las estanterías vacías. Para sustituir una colección completa, importa la primera parte con **Reemplazar** y las restantes con **Fusionar**, revisando cada resultado. Al restaurar en la misma cuenta se conservan identificadores de entidades reconocidas; entidades nuevas o de otra cuenta pueden recibir otros IDs, con cambios en sus enlaces.

Las portadas que falten se buscan en Open Library por lotes de hasta 20 ISBN, con timeout por petición y un presupuesto total de 20 segundos por importación. Se conservan las portadas existentes; si no hay resultados o el proveedor falla se usa `/default-book-cover.webp`. El resultado distingue libros importados, omitidos, portadas recuperadas y pendientes. En **Ajustes → Portadas pendientes** puedes volver a buscarlas para toda la colección, con progreso, pausa al terminar el lote y continuación en la misma página. Cada portada encontrada se guarda sin sobrescribir una corrección concurrente. También puedes buscar una portada desde el detalle.

Se guardan **URL de imágenes**, no los archivos de las portadas. Una copia JSON conserva esas URL y depende de que el proveedor continúe sirviéndolas. Ejecutar un SQL de carga no consulta Open Library. La búsqueda bibliográfica requiere sesión; usa caché acotada y diferencia ISBN incorrecto, falta de ficha, límite de consultas y proveedor no disponible. Véase la [política oficial de Open Library](https://openlibrary.org/developers/api).

## Datos iniciales para pruebas

En `tests/fixtures/library/` se conservan únicamente el [JSON importable](tests/fixtures/library/biblioteca.json) y el [SQL de carga](tests/fixtures/library/anadir-biblioteca.sql) generados a partir de la biblioteca fotografiada: **111 libros**, 102 con ISBN de referencia y nueve con identificador manual. Todos tienen estado **Sin leer**, provisional. Los ISBN no se han verificado contra el ejemplar físico y pueden corresponder a otra edición. Se han eliminado las fotografías, la preview y los archivos intermedios de extracción.

Para probar la importación, selecciona el JSON desde **Ajustes** en una cuenta de pruebas y revisa la fusión antes de confirmarla. Para cargar por SQL, aplica antes las migraciones de BibLib y usa una sesión del usuario de pruebas o completa su UUID en `v_user_id`. El SQL añade libros y estanterías, omite conflictos y no busca portadas; después puedes usar **Portadas pendientes**. Ambas opciones representan los mismos datos: elige una para la carga inicial. La semilla no se ejecuta automáticamente durante tests, migraciones o despliegues.

## Comprobaciones

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:import
pnpm test:db
pnpm test:smoke
pnpm build
```

`test:db` requiere Docker y puede descargar `postgres:17-alpine`. Crea un contenedor temporal propio, prueba migraciones, RLS con dos usuarios, restricciones y rollback, y después lo elimina. No utiliza `.env.local` ni una base real. Las pruebas unitarias usan respuestas simuladas para Open Library.

`test:smoke` requiere además Chrome (puedes indicar `CHROME_BIN`). Construye en una carpeta temporal sin `.env`, usa Auth simulado y Postgres efímero y comprueba los recorridos principales sin datos reales. El [resumen de implementación](docs/implementacion-2026-10-22.md) detalla lo aplicado y lo pendiente del roadmap.

GitHub Actions ejecuta instalación con lockfile congelado, lint, tipos, pruebas, build y pruebas Postgres aisladas. Este flujo no publica la aplicación ni ejecuta migraciones en Supabase.

## Migraciones

`drizzle/0000_biblib_init.sql` crea el esquema, tablas, índices y RLS por usuario. `drizzle/0001_library_integrity.sql` añade procedencia bibliográfica, la relación de propietario entre libro y estantería, restricciones de contenido y protección de la predeterminada. `drizzle/0002_book_versions.sql` añade versiones de edición y su rotación en cada escritura, incluso mediante SQL. Aplica las migraciones pendientes antes de usar esta versión de la aplicación.

```bash
pnpm db:generate
pnpm db:migrate
```

Revisa los SQL generados y el destino antes de ejecutar una migración. El procedimiento y los requisitos de respaldo están en [Operación](docs/operacion.md#migraciones-y-recuperación). Las fotos, catálogos personales y copias de seguridad son datos privados: selecciona explícitamente los archivos al preparar un commit.
