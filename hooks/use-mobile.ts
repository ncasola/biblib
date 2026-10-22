"use client"

import { useSyncExternalStore } from "react"

const QUERY = "(max-width: 767px)"

function subscribe(callback: () => void) {
  const query = window.matchMedia(QUERY)
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false)
}
