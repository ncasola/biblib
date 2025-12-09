# BibLib - Personal Book Library Manager

## Project Overview

BibLib is a vintage-themed personal book library management application built with Next.js 16, featuring a warm, nostalgic aesthetic inspired by classic library collections. The app allows users to catalog books, organize them into custom shelves, and visualize their collection through both table and 3D CSS views.

## Design Philosophy

### Visual Identity
- **Logo**: A cute, cartoonish book character with red round glasses reading another book
- **Color Palette**: 
  - Primary Red: `#DC2626` (vintage-red)
  - Olive Green: `#6B7C3F` (vintage-olive)  
  - Warm Yellow: `#D4AF37` (vintage-yellow)
  - Deep Purple: `#6B4E8B` (vintage-purple)
  - Warm Brown: `#8B6F47` (vintage-brown)
- **Typography**: Clean, readable fonts with generous spacing
- **Effects**: Glassmorphism (liquid glass) effects throughout with `backdrop-blur` and semi-transparent backgrounds
- **Aesthetic**: Vintage library meets modern web - warm, inviting, nostalgic but clean

### Default Assets
- **Book Cover Placeholder**: `/public/default-book-cover.webp` - An ornate vintage book cover with golden baroque scrollwork on dark leather background
- **Logo**: `/public/logo.png` - The BibLib mascot character

## Architecture

### Tech Stack
- **Framework**: Next.js 16 (App Router)
- **Runtime**: Next.js (browser-based)
- **Styling**: Tailwind CSS v4 with custom design tokens
- **State Management**: localStorage for data persistence + React hooks
- **UI Components**: shadcn/ui + custom components
- **External API**: Open Library API for book data

### Key Technologies
- React 19.2 with Server Components
- TypeScript for type safety
- CSS 3D transforms for book visualization
- localStorage for client-side persistence

## Project Structure

\`\`\`
/app
  /api
    /books
      /add       - Add book to library
      /search    - Search books by ISBN
  /book
    /[id]        - Individual book details page
  /books
    /add         - Add new book via ISBN search
    /search      - Advanced book search
    page.tsx     - Books table view with filters
  /shelves
    /3d          - CSS 3D shelf visualization
    page.tsx     - Shelf management
  page.tsx       - Dashboard with statistics
  layout.tsx     - Root layout with theme provider
  globals.css    - Global styles and design tokens

/components
  header.tsx              - Navigation header
  books-table.tsx         - TanStack Table for books
  search-book-form.tsx    - ISBN search form
  book-search-result.tsx  - Book result display
  shelf-viewer-3d.tsx     - CSS 3D book shelf
  shelf-card.tsx          - Shelf management card
  book-status-badge.tsx   - Reading status badge
  book-status-form.tsx    - Status change form

/lib
  types.ts       - TypeScript interfaces
  storage.ts     - localStorage utilities
  api-client.ts  - Open Library API client

/hooks
  use-theme.ts   - Dark/light mode toggle

/public
  logo.png                 - BibLib logo
  default-book-cover.webp  - Default book cover
  data.json                - Seed data with example books
\`\`\`

## Core Features

### 1. Dashboard (`/`)
- Statistics cards showing total books, shelves, and reading progress
- Quick action buttons to add books or view collection
- Glassmorphism card design with hover effects
- Displays counts from localStorage

### 2. Book Management (`/books`)
- TanStack Table with sorting, filtering, and pagination
- Filters: Search (title/author), Status (read/reading/to-read/unread), Shelf
- Columns: Cover thumbnail, Title, Authors, Pages, Published date, Status
- Actions: View details, Add new book, View 3D shelf
- Real-time filtering with useMemo for performance

### 3. Add Books (`/books/add`)
- ISBN-based search via Open Library API
- Two-column layout: Search form + Book preview
- Auto-populates: Title, Authors, Publishers, Pages, Cover images, Publish date
- Adds books to "default" shelf initially
- Duplicate detection prevents adding same ISBN twice

### 4. Book Details (`/book/[id]`)
- Full book information display
- Large cover image with vintage border
- Metadata: Authors, Publishers, Publication date, Pages, ISBN
- Reading status management with inline editor
- Shelf assignment display
- Delete book action with confirmation

### 5. Shelf Management (`/shelves`)
- Create custom shelves with names
- Rename existing shelves (except default)
- Delete shelves (books move to default)
- Grid layout of shelf cards showing book count
- Protected default shelf that cannot be deleted

### 6. 3D Bookshelf View (`/shelves/3d`)
- CSS 3D transforms (NOT Three.js WebGL)
- Books rendered as 3D objects with 6 faces
- Perspective view with wooden shelf elements
- Hover effects: Books lift up with tooltip info
- Displays book covers on front face or title/author text
- Organized in rows of 6 books per shelf
- Color-coded spines based on title hash

### 7. Advanced Search (`/books/search`)
- Multi-criteria filtering: Text search, Status, Shelf, Sort options
- Sort by: Title, Author, Date, Pages
- Grid view of results with cover thumbnails
- Click to view book details
- Real-time result count

### 8. Theme Toggle
- Dark/light mode switcher in header
- Uses `classList.add/remove('dark')` on document element
- Persists preference to localStorage
- Smooth transitions between themes

## Data Model

### Book Interface
\`\`\`typescript
interface Book {
  id: string              // UUID
  isbn: string            // ISBN-10 or ISBN-13
  title: string
  subtitle?: string
  authors: Author[]       // Array of {name, url?}
  number_of_pages: number
  publish_date: string
  publishers?: Publisher[] // Array of {name}
  cover: {
    small: string        // URL
    medium: string       // URL
    large: string        // URL
  }
  status: "read" | "reading" | "unread" | "to-read"
  shelf_id: string       // Foreign key to Shelf
  shelf_name: string     // Denormalized for display
}
\`\`\`

### Shelf Interface
\`\`\`typescript
interface Shelf {
  id: string
  title: string
  book_count: number
  isDefault?: boolean    // Cannot be deleted
}
\`\`\`

### Storage Strategy
1. Check localStorage first (`library_data` key)
2. If empty, load from `/public/data.json` (seed data)
3. All mutations save to localStorage immediately
4. Seed data includes 6 classic books across 3 shelves

## API Integration

### Open Library API
- Endpoint: `https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data`
- Used for: ISBN book lookup during add flow
- Returns: Title, Authors, Publishers, Pages, Publish date, Cover URLs
- Error handling: Shows "Book not found" for invalid ISBNs

### Internal API Routes
- `POST /api/books/add` - Adds book to library, checks duplicates
- `GET /api/books/search?isbn={isbn}` - Searches Open Library by ISBN

## Styling Conventions

### Design Tokens (in `globals.css`)
\`\`\`css
--vintage-red: #DC2626
--vintage-olive: #6B7C3F
--vintage-yellow: #D4AF37
--vintage-purple: #6B4E8B
--vintage-brown: #8B6F47
\`\`\`

### Common Patterns
- **Glass Cards**: `bg-card/80 backdrop-blur-xl border border-border rounded-2xl shadow-xl`
- **Buttons**: `bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30`
- **Headings**: Use `.heading-vintage` class or manual styling with vintage colors
- **Spacing**: Generous padding and margins (p-6, p-12, gap-6, gap-8)
- **Borders**: Rounded corners (rounded-xl, rounded-2xl)

### Responsive Design
- Mobile-first approach with Tailwind breakpoints
- Grid layouts: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- Flexible containers with `max-w-7xl mx-auto px-4`

## Development Patterns

### State Management
- Use `useState` for local component state
- Use `useEffect` for data loading on mount
- Use `useMemo` for expensive filtering/sorting operations
- Call `saveLibraryData()` after any mutation

### Error Handling
- Try-catch blocks for async operations
- `onError` handlers for image loading fallbacks
- User-friendly error messages via `alert()` or inline display
- Console logs with `[v0]` prefix for debugging

### Performance Optimizations
- `useMemo` for filtered/sorted data to prevent re-renders
- Lazy loading for large book collections
- Debounced search inputs (if implemented)
- CSS transforms over layout-triggering properties

## Future Enhancement Ideas
- User authentication with Supabase
- Cloud storage sync
- Book recommendations
- Reading goals and statistics
- Export/import library data
- Barcode scanner for ISBN entry
- Book reviews and notes
- Social sharing features
- Advanced filtering (by genre, language, etc.)
- Drag-and-drop shelf organization

## Important Notes for AI Agents

1. **Route Structure**: `/book/[id]` is singular (individual book), `/books` is plural (collection)
2. **Storage**: Always use `getStoredLibraryData()` to load, `saveLibraryData()` to persist
3. **Default Cover**: Use `/default-book-cover.webp` for missing covers, NOT placeholders
4. **Theme System**: Uses `document.documentElement.classList` with 'dark' class
5. **Glassmorphism**: Achieved with `backdrop-blur-xl` + semi-transparent backgrounds
6. **ISBN Validation**: Clean ISBNs by removing hyphens/spaces before API calls
7. **Duplicate Books**: Check ISBN before adding to prevent duplicates
8. **Protected Shelves**: Default shelf (`shelf-1`) cannot be deleted
9. **CSS 3D**: Uses pure CSS transforms, NOT Three.js or WebGL
10. **Vintage Aesthetic**: Maintain warm, nostalgic color palette throughout

## Common Tasks

### Adding a New Feature
1. Determine if it needs a new route (add to `/app`)
2. Create necessary components in `/components`
3. Update types in `/lib/types.ts` if data structure changes
4. Update storage functions in `/lib/storage.ts` for persistence
5. Apply glassmorphism and vintage styling consistently
6. Test with seed data and empty state

### Modifying Existing Features
1. Read the current file completely before editing
3. Add Change Comments (`// `) to explain modifications
4. Update related components if data flow changes
5. Ensure localStorage persistence still works

### Debugging
1. Add `console.log("[v0] ...")` for execution tracing
2. Check browser console for errors
3. Verify localStorage data structure
4. Test with both seed data and user-added books
5. Remove debug logs after fixing issues

---

**Last Updated**: Created with project foundation
**Maintained By**: AI agents working on BibLib
