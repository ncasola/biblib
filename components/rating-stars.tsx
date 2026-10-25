import { cn } from "@/lib/utils"

/** Estrellas decorativas de una valoración de 0 a 5. El texto accesible lo pone siempre quien la usa. */
export function RatingStars({ value, className }: { value: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex gap-0.5 text-base leading-none", className)}>
      {[1, 2, 3, 4, 5].map((star) => <span key={star} className={star <= value ? "text-brass-text" : "text-muted-foreground"}>{star <= value ? "★" : "☆"}</span>)}
    </span>
  )
}
