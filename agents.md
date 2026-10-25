# BibLib - Gestor Personal de Biblioteca

## Resumen del Proyecto

BibLib es una aplicación de gestión de biblioteca personal con estética vintage, construida con Next.js 16. Permite catalogar libros, organizarlos en estanterías personalizadas y visualizar la colección tanto en tabla como en vista 3D con CSS.

## Filosofía de Diseño

### Identidad Visual: «Biblioteca nocturna» (U-UX-01, Dirección A aprobada)
- **Dirección**: biblioteca de noche, con tinta cálida, nogal, latón y crema. Profundidad por capas y sombras suaves, sin degradados chillones. El tema claro es la versión en papel crema de la misma dirección, no otra distinta. Referencia: `docs/diseno/prototipo/direccion-a.dc.html` y [07](docs/spec-pendientes/07-rediseno.md).
- **Paleta** (tokens en `app/globals.css`; contraste AA comprobado en ambos temas, también en hover, foco y bordes de control):

  | Papel | Oscuro | Claro | Token |
  | --- | --- | --- | --- |
  | Fondo | `#16110d` tinta cálida | `#f5eddd` papel | `--background` |
  | Tarjeta | `#221a14` nogal | `#fcf8f0` | `--card` (+ `--card-sheen`) |
  | Texto | `#f6eddd` crema | `#2a1d14` tinta | `--foreground`, `--heading` |
  | Texto secundario | `#cdbfa6` / `#e3d6bf` | `#64513f` / `#4f3d2e` | `--muted-foreground`, `--foreground-light` |
  | Acción | `#c0392b` | `#b3302a` (mismo rojo ajustado a AA) | `--primary`, `vintage-red` |
  | Latón | `#c9a24a` / `#f2d58a` | `#c9a24a` (superficie) / `#7a5a12` (texto) | `--brass`, `--brass-light`, `--brass-text` |
  | Enlace y foco | `#f2d58a` | `#8a2a1e` (enlace) / `#8a6514` (foco) | `--link`, `--ring` |
  | Secundario | crema sobre tinta | tinta sobre crema | `--secondary` |
  | Nogal decorativo | `#6b4326` | `#6b4326` | `--walnut` |

  Estados de lectura (`--status-*` y `--status-*-bg`): leído (oliva), leyendo (ámbar), por leer (azul), sin empezar (neutro) y prestado (teja, reservado para O14). Los `vintage-*` siguen existiendo y se reajustaron a la paleta; para texto de color en oscuro se usan sus variantes `--vintage-*-text`.
- **Tipografía**: Fraunces (titulares, `h1`–`h3` y `font-heading`) e Inter (texto, `font-sans`), autoalojadas con `next/font/local` en `app/fonts.ts` (woff2 variables del subconjunto latino, licencias OFL en `app/fonts/`). Nada se descarga de Google ni de terceros en build ni en ejecución.
- **Movimiento**: microinteracciones sobrias (elevación de tarjetas, `active:translate-y-px`) solo con `motion-safe:`; `prefers-reduced-motion` anula animaciones y transiciones.

### Recursos por Defecto
- **Portada fallback**: `/public/default-book-cover.webp`
- **Logo**:
  - Cabecera: `/public/logo-mark.png` (solo el personaje) junto a «BibLib» en Fraunces.
  - Logo completo: `/public/logo-transparent.png` en claro y `/public/logo-dark.png` en oscuro (por ejemplo, en el acceso).
  - Favicon: `logo-mark.png`; icono de iOS y `maskable` del manifiesto: `logo.png` (fondo blanco). Variantes generadas con `scripts/brand/logo-variants.mjs`.

## Arquitectura

### Stack Tecnológico
- **Framework**: Next.js 16 (App Router)
- **Estilos**: Tailwind CSS v4 + tokens propios
- **ORM**: Drizzle ORM (enfoque code-first)
- **Base de datos**: Supabase Postgres
- **Autenticación**: Supabase Auth con Google OAuth
- **Persistencia**: datos por usuario en Supabase (sin `localStorage` para datos de dominio)
- **UI**: shadcn/ui + componentes propios
- **API externa**: Open Library para búsqueda por ISBN

### Tecnologías Clave
- React 19
- TypeScript
- Server Actions de Next.js para lecturas/escrituras
- RLS (Row Level Security) en Postgres
- CSS 3D transforms para estantería 3D

## Estructura del Proyecto

```text
/app
  /actions                 - Server Actions de dominio
  /api
    /books
      /add                 - Endpoint para alta de libro
      /search              - Búsqueda por ISBN (Open Library)
  /(auth)                  - Pantallas de autenticación
  /auth/callback           - Callback OAuth
  /book/[id]               - Detalle de libro
  /books                   - Colección
  /books/add               - Alta manual o por ISBN
  /books/search            - Búsqueda avanzada
  /shelves                 - Gestión de estanterías
  /shelves/3d              - Vista 3D de estantería
  /settings                - Importación/exportación
  page.tsx                 - Inicio / dashboard

/components                - Componentes de UI y dominio
/lib
  /db                      - Cliente y schema Drizzle
  /supabase                - Clientes SSR/browser/proxy
  types.ts                 - Tipos de dominio
  api-client.ts            - Cliente Open Library
```

## Funcionalidades Principales

1. **Inicio (`/`)**
   - Tarjetas de estadísticas y accesos rápidos.
2. **Libros (`/books`)**
   - Tabla con filtros, orden y paginación.
3. **Agregar libro (`/books/add`)**
   - Búsqueda por ISBN y alta manual.
4. **Detalle (`/book/[id]`)**
   - Información completa, estado y eliminación.
5. **Estanterías (`/shelves`)**
   - Crear, renombrar y eliminar estanterías (con estantería predeterminada protegida).
6. **Vista 3D (`/shelves/3d`)**
   - Visualización inmersiva con CSS 3D.
7. **Búsqueda avanzada (`/books/search`)**
   - Filtro por texto, estado, estantería y orden.
8. **Ajustes (`/settings`)**
   - Exportar/importar colección en JSON.

## Modelo de Datos

### `Book`
```ts
interface Book {
  id: string
  isbn: string
  title: string
  subtitle?: string
  authors: Author[]
  number_of_pages: number
  publish_date: string
  publishers?: Publisher[]
  cover: {
    small: string
    medium: string
    large: string
  }
  status: "read" | "reading" | "unread" | "to-read"
  shelf_id: string
  shelf_name: string
}
```

### `Shelf`
```ts
interface Shelf {
  id: string
  title: string
  book_count: number
  isDefault?: boolean
}
```

## Base de Datos y Seguridad

- El schema de Postgres es `biblib`.
- Las tablas principales son `biblib.shelves` y `biblib.books`.
- Todas las operaciones de dominio pasan por Server Actions.
- El aislamiento de datos es por usuario mediante RLS (`auth.uid()`).
- Existe una estantería predeterminada por usuario, creada de forma idempotente.

## Integración con Open Library

- Endpoint: `https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data`
- Uso principal: completar datos al agregar libro por ISBN.

## Convenciones de Estilo

- **Tarjetas**: utilidad `surface-card` (fondo de tarjeta con brillo superior, borde fino, `rounded-2xl` de 20 px y sombra `--elev-2`). Añade solo el relleno (`p-4`–`p-6`). Para tarjetas enlazadas: `hover:shadow-xl motion-safe:hover:-translate-y-0.5`. Los paneles anidados usan `bg-surface/50` con borde, sin sombra.
- **Elevación**: `shadow-sm`…`shadow-2xl` están redefinidas con sombras cálidas por capas (`--elev-1`…`--elev-4`); no uses sombras de color ni `backdrop-blur` salvo en la cabecera, menús y diálogos.
- **Cabecera de pantalla**: `PageHeader` (`components/page-header.tsx`) con antetítulo (`eyebrow`, versalitas de latón), un único `h1` (`heading-vintage text-3xl md:text-5xl`), descripción en `text-foreground-light` y acciones.
- **Botones**: variantes de `components/ui/button.tsx` sin colores a mano: `default` (rojo de acción, una por vista), `secondary` (crema/tinta), `outline`, `ghost`, `destructive` y `link`. Mínimo 44 × 44 px, radio de 12 px, deshabilitado al 60 %.
- **Formularios**: `Input`, `Select` y los `<select>`/`textarea` nativos con `bg-input` y `--control-border`; el foco es el contorno global de 3 px en `--ring`.
- **Estados**: `BookStatusBadge` (`.status-chip[data-status]`) para el estado de lectura; `RatingStars` para la valoración (decorativa, el texto «Valoración: N de 5» se conserva); confirmaciones con borde izquierdo `--status-read`; errores en `text-destructive`; vacíos con `border-dashed` y `bg-surface/50`; carga con `LoadingState`.
- **Navegación**: píldoras (`bg-foreground text-background` para la activa, `aria-current="page"`), menú móvil por debajo de `lg`, búsqueda rápida GET a `/books?q=` y «Añadir libro» en escritorio.
- **Enlaces de texto**: `link-quiet` (latón en oscuro, rojo tinta en claro, subrayado suave).
- **Espaciado**: uso consistente de `gap-*`, `p-*`, `rounded-*`; secciones de pantalla separadas con `gap-12`.
- **Responsivo**: enfoque mobile-first con breakpoints Tailwind; sin scroll horizontal en 320, 375, 768 y 1440 px.

## Patrones de Desarrollo

- `useState` para estado local.
- `useEffect` para carga inicial en cliente.
- `useMemo` para filtros/ordenamientos costosos.
- Manejo de errores con `try/catch` y mensajes de usuario claros.

## Notas Importantes para Agentes

1. Mantener todos los textos visibles al usuario en español.
2. No usar `any`.
3. Usar `pnpm` para instalación/ejecución de scripts.
4. Priorizar acciones de servidor para datos de dominio.
5. Preservar estética vintage y buen contraste en claro/oscuro.
6. Usar `/default-book-cover.webp` como fallback de portada.
7. Respetar estantería predeterminada (no eliminable).

## Tareas Comunes

### Agregar una funcionalidad
1. Evaluar si requiere nueva ruta.
2. Crear/ajustar componentes.
3. Actualizar tipos y schema si aplica.
4. Implementar en Server Actions.
5. Verificar RLS y UX.

### Modificar funcionalidad existente
1. Leer archivo completo antes de editar.
2. Mantener consistencia visual y de idioma.
3. Revisar impacto en acciones, tipos y componentes relacionados.

### Depuración
1. Reproducir el problema.
2. Corregir en la capa adecuada (UI / action / DB).
3. Validar con lint y prueba manual.

---

**Última actualización**: Marzo 2026  
**Mantenido por**: agentes de desarrollo de BibLib
