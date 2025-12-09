import type { LibraryData } from "./types"

const DATA_FILE = "/data.json"

export async function loadLibraryData(): Promise<LibraryData> {
  try {
    const response = await fetch(DATA_FILE)
    if (!response.ok) throw new Error("Failed to load data")
    return await response.json()
  } catch (error) {
    console.error("Error loading library data:", error)
    return { books: [], shelves: [] }
  }
}

export function saveLibraryData(data: LibraryData): void {
  if (typeof window !== "undefined") {
    localStorage.setItem("biblib-data", JSON.stringify(data))
  }
}

export function getStoredLibraryData(): LibraryData | null {
  if (typeof window === "undefined") return null
  const stored = localStorage.getItem("biblib-data")
  return stored ? JSON.parse(stored) : null
}
