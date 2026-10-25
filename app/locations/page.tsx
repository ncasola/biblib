import { LocationManager } from "@/components/location-manager"
import { uuidSchema } from "@/lib/book-validation"

interface LocationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// U-PRO-03 · Ubicación física: árbol mueble → balda, contenido filtrable y foto de referencia. `?ubicacion=<id>` abre una.
export default async function LocationsPage({ searchParams }: LocationsPageProps) {
  const selected = (await searchParams).ubicacion
  const initial = typeof selected === "string" && uuidSchema.safeParse(selected).success ? selected : null
  return <LocationManager initialLocationId={initial} />
}
