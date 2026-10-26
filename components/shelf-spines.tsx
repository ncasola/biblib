import { cn } from "@/lib/utils"

// Lomos decorativos de una estantería: colores de encuadernación y alturas deterministas a partir del ID.
// No representan libros concretos; solo cuántos hay (hasta 18) para dar idea de lo llena que está.
const SPINE_COLORS = ["#7a1f24", "#1f3a5f", "#2f4a2c", "#5b3a29", "#c9b48a", "#3b2a4a", "#a0522d", "#22303a", "#8a6d2f", "#e8dcc4", "#0f3d3e", "#6d1a36"]

export function ShelfSpines({ id, count, className }: { id: string; count: number; className?: string }) {
  const seed = [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 7)
  return (
    <span aria-hidden="true" className={cn("shelf-preview", className)}>
      {Array.from({ length: Math.min(count, 18) }, (_, index) => (
        <span key={index} style={{ width: 10 + ((seed + index * 7) % 9), height: 58 + ((seed * 3 + index * 13) % 30), backgroundColor: SPINE_COLORS[(seed + index * 5) % SPINE_COLORS.length] }} />
      ))}
    </span>
  )
}
