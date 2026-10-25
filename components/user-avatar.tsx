"use client"

import { useState } from "react"
import type { User } from "@/lib/auth-context"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"

/** Si Storage falla, se sigue mostrando Google o las iniciales sin borrar el perfil privado. */
export function UserAvatar({ user, className, decorative = false }: { user: User; className?: string; decorative?: boolean }) {
  const [failed, setFailed] = useState<string[]>([])
  const src = [user.avatar, user.googleAvatar].find((url) => url && !failed.includes(url))
  return <Avatar className={className}>
    <AvatarImage src={src} alt={decorative ? "" : `Foto de perfil de ${user.name || user.email}`} onLoadingStatusChange={(status) => { if (status === "error" && src) setFailed((urls) => [...urls, src]) }} />
    <AvatarFallback className="bg-accent text-accent-foreground">{(user.name || user.email || "L").charAt(0).toUpperCase()}</AvatarFallback>
  </Avatar>
}
