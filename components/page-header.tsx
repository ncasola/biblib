import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Cabecera de pantalla del sistema «Biblioteca nocturna»: antetítulo de latón opcional, titular en Fraunces,
 * descripción y acciones. Mantiene un único `<h1>` por ruta.
 */
export function PageHeader({ eyebrow, title, description, actions, className, titleId }: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
  titleId?: string
}) {
  return (
    <div className={cn("mb-8 flex flex-col gap-5 md:mb-10 md:flex-row md:items-end md:justify-between", className)}>
      <div className="flex max-w-3xl flex-col gap-2">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 id={titleId} className="heading-vintage text-3xl leading-[1.08] md:text-5xl">{title}</h1>
        {description && <p className="text-base leading-relaxed text-foreground-light md:text-lg">{description}</p>}
      </div>
      {actions && <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3 md:justify-end">{actions}</div>}
    </div>
  )
}
