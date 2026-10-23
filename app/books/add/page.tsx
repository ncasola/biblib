import { connection } from "next/server"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { AddBookScreen } from "./add-book-screen"

/** La bandera de revisión se lee en el servidor en cada petición; ante una configuración inválida, la UI actual. */
export default async function AddBookPage() {
  await connection()
  let reviewEnabled = false
  try { reviewEnabled = readCatalogConfig().reviewEnabled } catch { reviewEnabled = false }
  return <AddBookScreen reviewEnabled={reviewEnabled} />
}
