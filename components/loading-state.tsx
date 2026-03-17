"use client"

import { Loader2 } from "lucide-react"

interface LoadingStateProps {
  message?: string
}

export function LoadingState({ message = "Cargando tu biblioteca..." }: LoadingStateProps) {
  return (
    <div className="flex items-center justify-center h-96">
      <div className="rounded-2xl border border-border/70 bg-card/90 backdrop-blur-xl px-8 py-7 shadow-xl">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-vintage-red" />
          <p className="text-foreground font-medium">{message}</p>
        </div>
      </div>
    </div>
  )
}
