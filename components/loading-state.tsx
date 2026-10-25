"use client"

import { Loader2 } from "lucide-react"

interface LoadingStateProps {
  message?: string
}

export function LoadingState({ message = "Cargando tu biblioteca..." }: LoadingStateProps) {
  return (
    <div className="flex h-96 items-center justify-center">
      <div className="surface-card flex items-center gap-3 px-8 py-6">
        <Loader2 aria-hidden="true" className="size-5 animate-spin text-brass-text" />
        <p className="font-medium text-foreground">{message}</p>
      </div>
    </div>
  )
}
