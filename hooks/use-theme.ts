"use client"

import { useEffect, useState } from "react"

export function useTheme() {
  const [mounted] = useState(typeof window !== "undefined")
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light"
    const stored = localStorage.getItem("theme") as "light" | "dark" | null
    return stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  })

  // Sync theme class without mutating state in effects
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark")
    } else {
      document.documentElement.classList.remove("dark")
    }
  }, [theme])

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light"
    setTheme(newTheme)
    if (newTheme === "dark") {
      document.documentElement.classList.add("dark")
    } else {
      document.documentElement.classList.remove("dark")
    }
    localStorage.setItem("theme", newTheme)
  }

  return { theme, toggleTheme, mounted }
}
