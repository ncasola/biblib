"use client"

import { useSyncExternalStore } from "react"
import { useTheme as useNextTheme } from "next-themes"

const subscribe = () => () => {}

export function useTheme() {
  const { resolvedTheme, setTheme } = useNextTheme()
  const mounted = useSyncExternalStore(subscribe, () => true, () => false)
  const theme = mounted && resolvedTheme === "dark" ? "dark" : "light"
  return { theme, mounted, toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark") }
}
