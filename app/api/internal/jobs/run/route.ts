import { NextResponse, type NextRequest } from "next/server"
import { drainJobs } from "@/lib/jobs/worker"
import { isRunnerAuthorized, workerDeps } from "@/lib/jobs/server"

// Entrada interna del ejecutor de trabajos (U-DAT-03), para el runner local y el scheduler de F4.
// Solo acepta el token del ejecutor; no lee el cuerpo ni la sesión: el dueño sale siempre de la
// fila reclamada, nunca de la petición.

const headers = { "Cache-Control": "private, no-store" }

export async function POST(request: NextRequest) {
  if (!isRunnerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401, headers })
  }
  try {
    const steps = await drainJobs(workerDeps(), {}, 25_000)
    return NextResponse.json({ steps: steps.length, leaseLost: steps.filter((step) => step.outcome === "lease_lost").length, failed: steps.filter((step) => step.outcome === "error").length }, { headers })
  } catch {
    return NextResponse.json({ error: "El ejecutor no está disponible." }, { status: 503, headers })
  }
}
