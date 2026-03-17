# BibLib - Gestor Personal de Biblioteca

## Resumen del Proyecto

BibLib es una aplicación de gestión de biblioteca personal con estética vintage, construida con Next.js 16. Permite catalogar libros, organizarlos en estanterías personalizadas y visualizar la colección tanto en tabla como en vista 3D con CSS.

## Filosofía de Diseño

### Identidad Visual
- **Logo**: personaje de libro caricaturesco con gafas rojas redondas.
- **Paleta principal**:
  - Rojo principal: `#DC2626` (`vintage-red`)
  - Verde oliva: `#6B7C3F` (`vintage-olive`)
  - Amarillo cálido: `#D4AF37` (`vintage-yellow`)
  - Morado profundo: `#6B4E8B` (`vintage-purple`)
  - Marrón cálido: `#8B6F47` (`vintage-brown`)
- **Tipografía**: limpia y legible, con buen espaciado.
- **Efectos**: glassmorphism con `backdrop-blur` y transparencias.
- **Estilo general**: biblioteca clásica con experiencia web moderna.

### Recursos por Defecto
- **Portada fallback**: `/public/default-book-cover.webp`
- **Logo**: `/public/logo.png`

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

- **Tarjetas**: `bg-card/80 backdrop-blur-xl border border-border rounded-2xl shadow-xl`
- **Botones**: énfasis visual, estados hover/active y buen contraste
- **Espaciado**: uso consistente de `gap-*`, `p-*`, `rounded-*`
- **Responsivo**: enfoque mobile-first con breakpoints Tailwind

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
