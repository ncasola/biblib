"use client"

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react"
import Link from "next/link"
import { Download, Upload, ArrowLeft, AlertCircle, CheckCircle, LoaderCircle, RefreshCw, History, RotateCcw, Trash2, X } from "lucide-react"
import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { CoverRecoveryJobPanel } from "@/components/cover-recovery-job-panel"
import { ImportJobPanel } from "@/components/import-job-panel"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { getLibraryDataAction } from "@/app/actions/library"
import { confirmImportAction, prepareImportAction, type PreparedImport } from "@/app/actions/import-preview"
import {
  deleteLibrarySnapshotAction, listLibrarySnapshotsAction, previewSnapshotRestoreAction, restoreSnapshotAction,
  type SnapshotRestorePreview,
} from "@/app/actions/library-snapshots"
import type { SnapshotPage, SnapshotSummary } from "@/lib/library-snapshots"
import {
  MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES, MAX_IMPORT_SHELVES,
  parseLibraryImport, type LibraryImportOptions, type LibraryExport,
} from "@/lib/library-import"
import type { ImportOperationResult } from "@/lib/import-plan"
import { backupPartCounts, exportLibraryBackup } from "@/lib/library-export"
import type { PortableBackupV2 } from "@/lib/backup-v2"
import type { LibraryData } from "@/lib/types"
import type { ActionError } from "@/lib/action-result"

type Message = { type: "success" | "error"; text: string; reference?: string }
type Preview = { name: string; library: LibraryData }
/** El archivo y la selección se conservan; la revisión del servidor ya no corresponde a la colección actual. */
type Stale = { reason: "conflict" | "expired"; text: string }

const newIdempotencyKey = () => crypto.randomUUID()

const longDate = (iso: string) => new Date(iso).toLocaleString("es", { dateStyle: "long", timeStyle: "short" })
const REASONS: Record<SnapshotSummary["reason"], string> = {
  "import.replace": "Antes de reemplazar la biblioteca con una importación",
  "snapshot.restore": "Antes de restaurar una versión anterior",
}

/**
 * U-DAT-02 · Historial de versiones anteriores: fecha, motivo, cantidades y caducidad. Restaurar
 * prepara una comparación nueva con la colección actual y exige confirmación; los avisos van a la
 * región en vivo de la página para no desplazar el contenido.
 */
function SnapshotHistory({ refreshKey, disabled, onNotice, onRestored }: {
  refreshKey: number
  disabled: boolean
  onNotice: (message: Message) => void
  onRestored: () => void
}) {
  const [page, setPage] = useState<SnapshotPage | null>(null)
  const [items, setItems] = useState<SnapshotSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [preview, setPreview] = useState<SnapshotRestorePreview | null>(null)
  const [stale, setStale] = useState<{ snapshotId: string; text: string } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [toDelete, setToDelete] = useState<SnapshotSummary | null>(null)
  // Una clave por comparación preparada: reintentar tras perder la respuesta recupera el mismo resultado.
  const restoreKey = useRef("")
  const busy = disabled || working !== null

  // Solo actualiza el estado al llegar la respuesta; quien recarga marca antes la carga en curso.
  const load = useCallback((cursor?: string) => listLibrarySnapshotsAction({ cursor: cursor ?? null, limit: 10 }).then((response) => {
    if (!response.ok) { setLoadFailed(true); return }
    setLoadFailed(false)
    setPage(response.value)
    setItems((previous) => cursor ? [...previous, ...response.value.items] : response.value.items)
  }).catch(() => {
    setLoadFailed(true)
  }).finally(() => {
    setLoading(false)
  }), [])
  const reload = (cursor?: string) => { setLoading(true); void load(cursor) }

  useEffect(() => { void load() }, [load, refreshKey])

  const prepareRestore = async (snapshotId: string) => {
    if (busy) return
    setWorking(snapshotId)
    setStale(null)
    setPreview(null)
    setAcknowledged(false)
    try {
      const response = await previewSnapshotRestoreAction({ snapshotId })
      if (!response.ok) {
        onNotice({ type: "error", text: response.error.message, reference: response.error.correlationId })
        if (response.error.code === "NOT_FOUND" || response.error.code === "PREVIEW_EXPIRED") void load()
        return
      }
      restoreKey.current = newIdempotencyKey()
      setPreview(response.value)
    } catch {
      onNotice({ type: "error", text: "No se pudo comparar la versión con tu biblioteca. No se ha modificado nada; vuelve a intentarlo." })
    } finally {
      setWorking(null)
    }
  }

  const confirmRestore = async () => {
    if (!preview || busy || !acknowledged) return
    setConfirmOpen(false)
    setWorking(preview.snapshot.id)
    try {
      const response = await restoreSnapshotAction({ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: restoreKey.current })
      if (!response.ok) {
        const { error } = response
        if (error.code === "REVISION_CONFLICT" || error.code === "PREVIEW_EXPIRED" || error.code === "IDEMPOTENCY_CONFLICT") {
          // Nunca se reintenta con la comparación antigua: hay que volver a comparar con los datos actuales.
          setStale({ snapshotId: preview.snapshot.id, text: error.message })
          setPreview(null)
        } else {
          if (error.code === "NOT_FOUND") { setPreview(null); void load() }
          onNotice({ type: "error", text: error.message, reference: error.correlationId })
        }
        return
      }
      const { result, replayed } = response.value
      setPreview(null)
      onNotice({ type: "success", text: `${replayed ? "Esta restauración ya se había aplicado. " : "Versión restaurada. "}Tu biblioteca tiene ahora ${result.imported} libros en ${result.shelves} estanterías. La colección que había antes se ha guardado como otra versión anterior.` })
      onRestored()
      void load()
    } catch {
      // Respuesta perdida: la misma clave permite reintentar sin restaurar dos veces.
      onNotice({ type: "error", text: "No se recibió la respuesta de la restauración. Puedes volver a confirmarla: si ya se aplicó, verás el mismo resultado sin repetirla." })
    } finally {
      setWorking(null)
    }
  }

  const confirmDelete = async () => {
    const target = toDelete
    if (!target || busy) return
    setToDelete(null)
    setWorking(target.id)
    try {
      const response = await deleteLibrarySnapshotAction({ snapshotId: target.id, expectedVersion: target.version })
      if (!response.ok) onNotice({ type: "error", text: response.error.message, reference: response.error.correlationId })
      else onNotice({ type: "success", text: `Se ha eliminado la versión del ${longDate(target.createdAt)}.` })
      if (preview?.snapshot.id === target.id) setPreview(null)
      void load()
    } catch {
      onNotice({ type: "error", text: "No se pudo eliminar la versión. Vuelve a intentarlo." })
    } finally {
      setWorking(null)
    }
  }

  const full = page ? page.quota.used >= page.quota.limit : false
  const plan = preview?.plan
  return (
    <section aria-labelledby="history-title" aria-busy={loading || working !== null} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
      <h2 id="history-title" className="text-2xl font-bold mb-2 flex items-center gap-2"><History aria-hidden="true" className="w-6 h-6" />Versiones anteriores</h2>
      <p className="text-muted-foreground mb-3">Antes de reemplazar tu biblioteca o de restaurar una versión, BibLib guarda automáticamente la colección que se va a sustituir. Puedes compararla con la actual y restaurarla.</p>
      <p id="history-quota" className="text-sm mb-4">{page
        ? `Versiones guardadas: ${page.quota.used} de ${page.quota.limit}. Cada una se conserva ${page.retentionDays} días.`
        : loading ? "Cargando el historial…" : ""}</p>
      {full && <p role="status" className="mb-4 rounded-xl border border-destructive bg-destructive/10 p-3 text-sm">Has alcanzado el máximo de versiones guardadas. Mientras no elimines alguna, no podrás reemplazar la biblioteca ni restaurar una versión: ninguna se borra sin que lo decidas.</p>}
      {loadFailed && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><span>No se pudo cargar el historial.</span><Button variant="outline" size="sm" onClick={() => reload()} disabled={loading}>Reintentar</Button></div>}
      {page && items.length === 0 && !loading && <p className="text-sm text-muted-foreground">Todavía no hay versiones anteriores. Se crea una cada vez que reemplazas la biblioteca o restauras una versión.</p>}

      {items.length > 0 && <ul className="space-y-3" aria-describedby="history-quota">
        {items.map((item) => {
          const label = `la versión del ${longDate(item.createdAt)}`
          return <li key={item.id} className="rounded-xl border border-border p-4">
            <p className="font-semibold">{longDate(item.createdAt)}</p>
            <p className="text-sm">{REASONS[item.reason]}</p>
            <p className="text-sm text-muted-foreground">{item.books} libros · {item.shelves} estanterías · caduca el {longDate(item.expiresAt)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void prepareRestore(item.id)} disabled={busy} aria-label={`Revisar la restauración de ${label}`}>{working === item.id && !preview ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />}Revisar restauración</Button>
              <Button size="sm" variant="outline" onClick={() => setToDelete(item)} disabled={busy} aria-label={`Eliminar ${label}`}><Trash2 aria-hidden="true" />Eliminar</Button>
            </div>
          </li>
        })}
      </ul>}
      {page?.nextCursor && <Button className="mt-4" variant="outline" onClick={() => reload(page.nextCursor ?? undefined)} disabled={loading || busy}>Ver versiones más antiguas</Button>}

      {stale && !preview && <div role="alert" className="mt-6 rounded-xl border border-destructive bg-destructive/10 p-4 space-y-3">
        <p className="font-medium">La comparación ya no es válida</p>
        <p className="text-sm">{stale.text}</p>
        <p className="text-sm text-muted-foreground">No se ha restaurado nada. Compara de nuevo la versión con tu biblioteca actual antes de decidir.</p>
        <div className="flex flex-wrap gap-3"><Button onClick={() => void prepareRestore(stale.snapshotId)} disabled={busy}><RefreshCw aria-hidden="true" />Volver a comparar con los datos actuales</Button><Button variant="outline" onClick={() => setStale(null)} disabled={busy}>Cancelar</Button></div>
      </div>}

      {preview && plan && <div className="mt-6 rounded-xl border border-border p-4 space-y-4" aria-labelledby="restore-preview-title">
        <h3 id="restore-preview-title" className="font-semibold">Restaurar la versión del {longDate(preview.snapshot.createdAt)}</h3>
        <p className="text-xs text-muted-foreground">Comparación con tu biblioteca actual. Caduca a las {new Date(preview.expiresAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}; si cambias algo en otra pestaña antes de confirmar, tendrás que volver a compararla.</p>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {([
            ["Libros en la versión", preview.snapshot.books],
            ["Libros que vuelven", plan.counts.added],
            ["Se sustituyen conservando su enlace", plan.counts.overwritten],
            ["Libros actuales que se eliminarán", plan.counts.deleted],
            ["Estanterías que se eliminarán", plan.counts.shelvesDeleted],
            ["Con identificador nuevo", plan.counts.reassigned],
          ] as const).map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold text-lg">{count}</dd></div>)}
        </dl>
        <p className="text-sm">Tras restaurar tendrás {plan.counts.booksAfter} libros en {plan.counts.shelvesAfter} estanterías.</p>
        {preview.changes.removedTotal > 0 && <details className="text-sm" open={preview.changes.removedTotal <= 10}><summary className="cursor-pointer font-medium">Libros actuales que se eliminarán ({preview.changes.removedTotal})</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{preview.changes.removed.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}</ul>{preview.changes.removedTotal > preview.changes.removed.length && <p className="mt-1 text-muted-foreground">Y {preview.changes.removedTotal - preview.changes.removed.length} más.</p>}</details>}
        {preview.changes.restoredTotal > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">Libros que vuelven ({preview.changes.restoredTotal})</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{preview.changes.restored.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}</ul>{preview.changes.restoredTotal > preview.changes.restored.length && <p className="mt-1 text-muted-foreground">Y {preview.changes.restoredTotal - preview.changes.restored.length} más.</p>}</details>}
        <p className="text-sm text-muted-foreground">Antes de restaurar se guardará tu colección actual como otra versión anterior, así podrás deshacer la restauración. Los libros recuperan sus enlaces cuando es posible; las ediciones abiertas en otras pestañas tendrán que recargarse.</p>
        <div className="flex flex-wrap gap-3"><Button variant="destructive" onClick={() => { setAcknowledged(false); setConfirmOpen(true) }} disabled={busy}>{working === preview.snapshot.id ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />}Restaurar esta versión</Button><Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>Cancelar</Button></div>
      </div>}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Confirmar restauración</AlertDialogTitle><AlertDialogDescription>Se eliminarán {plan?.counts.deleted ?? 0} libros actuales, se sustituirán {plan?.counts.overwritten ?? 0} y volverán {plan?.counts.added ?? 0}. Tu colección actual se guardará antes como versión anterior. Solo se aplicará si tu biblioteca no ha cambiado desde esta comparación.</AlertDialogDescription></AlertDialogHeader>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" /><span>Entiendo que se sustituirá mi colección actual por esta versión.</span></label>
          <AlertDialogFooter><AlertDialogCancel>Volver a la comparación</AlertDialogCancel><AlertDialogAction disabled={busy || !acknowledged} onClick={() => void confirmRestore()}>Sí, restaurar versión</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>¿Eliminar esta versión anterior?</AlertDialogTitle><AlertDialogDescription>{toDelete ? `La versión del ${longDate(toDelete.createdAt)} (${toDelete.books} libros) se eliminará definitivamente y no se podrá restaurar. Tu biblioteca actual no cambia.` : ""}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Conservar</AlertDialogCancel><AlertDialogAction onClick={() => void confirmDelete()}>Sí, eliminar versión</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

export default function SettingsPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [exportParts, setExportParts] = useState<(LibraryExport | PortableBackupV2)[]>([])
  const [exportFormat, setExportFormat] = useState<1 | 2 | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [prepared, setPrepared] = useState<PreparedImport | null>(null)
  const [stale, setStale] = useState<Stale | null>(null)
  const [mode, setMode] = useState<LibraryImportOptions["mode"]>("merge")
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [replaceAcknowledged, setReplaceAcknowledged] = useState(false)
  const [result, setResult] = useState<ImportOperationResult | null>(null)
  // Trabajo persistente de la última confirmación: publicación y portadas pendientes (U-DAT-03).
  const [importJobId, setImportJobId] = useState<string | null>(null)
  // Cambia tras un reemplazo para que el historial muestre la versión anterior recién guardada (U-DAT-02).
  const [historyKey, setHistoryKey] = useState(0)
  const [partsOpen, setPartsOpen] = useState(false)
  // Una clave por revisión preparada: reintentar tras una respuesta perdida recupera el mismo resultado.
  const idempotencyKey = useRef<string>("")
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = isImporting || isValidating || isPreparing || isExporting || isRecovering

  const refresh = useCallback(() => getLibraryDataAction().then((loaded) => {
      setData(loaded)
      setMessage(null)
    }).catch(() => {
      setData(null)
      setMessage({ type: "error", text: "No se pudo cargar tu biblioteca. Reintenta la carga antes de importar o exportar." })
    }).finally(() => {
      setLoading(false)
    }), [])

  useEffect(() => { void refresh() }, [refresh])

  const downloadPart = (part: LibraryExport | PortableBackupV2, index: number, total: number) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(part)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    const suffix = total > 1 ? `-parte-${String(index + 1).padStart(String(total).length, "0")}-de-${total}` : ""
    link.download = `biblib-backup-${part.formatVersion === 2 ? "v2-" : ""}${part.exportedAt.replace(/[:.]/g, "-")}${suffix}.json`
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const handleExport = async () => {
    if (busy) return
    setIsExporting(true)
    try {
      const current = await getLibraryDataAction()
      setData(current)
      setExportParts([])
      // U-BIB-04: formato 1 solo si no pierde datos; con procedencia BNE o por campo, formato 2.
      const backup = exportLibraryBackup(current)
      const parts: (LibraryExport | PortableBackupV2)[] = backup.parts
      setExportParts(parts)
      setExportFormat(backup.formatVersion)
      if (parts.length === 1) downloadPart(parts[0], 0, 1)
      // Las partes se ofrecen en un diálogo: la lista no empuja el resto de la página (tarea T2 de rendimiento).
      else setPartsOpen(true)
      const format = backup.formatVersion === 2
        ? " Se usa el formato 2 porque tu biblioteca tiene procedencia por campo o de la BNE que el formato 1 no conserva."
        : " Se usa el formato 1, compatible con versiones anteriores, porque conserva todos tus datos."
      setMessage({ type: "success", text: (parts.length === 1
        ? `Copia preparada con ${current.books.length} libros y ${current.shelves.length} estanterías. Conserva el archivo descargado para restaurar la colección.`
        : `Copia dividida en ${parts.length} archivos importables. Descarga y conserva todas las partes; puedes volver a abrir la lista con «Ver las ${parts.length} partes de la última copia».`) + format })
    } catch {
      setMessage({ type: "error", text: "No se pudo preparar la copia. No se han modificado tus datos; vuelve a intentarlo." })
    } finally {
      setIsExporting(false)
    }
  }

  const errorMessage = (error: ActionError): Message => ({ type: "error", text: error.message, reference: error.correlationId })

  /** Pide al servidor la revisión de este archivo y modo frente a la colección actual. */
  const prepare = async (library: LibraryData, importMode: LibraryImportOptions["mode"]) => {
    setIsPreparing(true)
    setPrepared(null)
    setStale(null)
    setMessage(null)
    setReplaceAcknowledged(false)
    try {
      const response = await prepareImportAction(library, importMode)
      if (!response.ok) { setMessage(errorMessage(response.error)); return }
      idempotencyKey.current = newIdempotencyKey()
      setPrepared(response.value)
      try { setData(await getLibraryDataAction()) } catch { /* La revisión del servidor sigue siendo válida. */ }
    } catch {
      setMessage({ type: "error", text: "No se pudo preparar la revisión. No se han modificado tus datos; vuelve a intentarlo." })
    } finally {
      setIsPreparing(false)
    }
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || busy) return
    setPreview(null)
    setPrepared(null)
    setStale(null)
    setResult(null)
    setMessage(null)
    setMode("merge")
    setReplaceAcknowledged(false)
    setIsValidating(true)
    let library: LibraryData
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("El archivo supera el límite de 8 MiB.")
      let input: unknown
      try { input = JSON.parse(await file.text()) } catch { throw new Error("No se pudo leer el JSON. Comprueba que el archivo esté completo y sea válido.") }
      // Revisión local inmediata de errores del archivo, antes de consultar al servidor.
      library = parseLibraryImport(input)
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "No se pudo revisar el archivo. No se han modificado tus datos." })
      return
    } finally {
      setIsValidating(false)
    }
    setPreview({ name: file.name, library })
    await prepare(library, "merge")
  }

  const changeMode = (next: LibraryImportOptions["mode"]) => {
    if (!preview || busy || next === mode) return
    setMode(next)
    void prepare(preview.library, next)
  }

  const handleConfirm = async () => {
    if (!preview || !prepared || busy || (mode === "replace" && !replaceAcknowledged)) return
    setConfirmationOpen(false)
    setIsImporting(true)
    setMessage(null)
    try {
      const response = await confirmImportAction({ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: idempotencyKey.current })
      if (!response.ok) {
        const { error } = response
        if (error.code === "REVISION_CONFLICT" || error.code === "PREVIEW_EXPIRED" || error.code === "IDEMPOTENCY_CONFLICT") {
          // Nunca se reintenta solo: se conserva el archivo y el modo, y la persona vuelve a revisar.
          setPrepared(null)
          setStale({ reason: error.code === "REVISION_CONFLICT" ? "conflict" : "expired", text: error.message })
        } else {
          // Sin espacio para la versión anterior no se aplicó nada: tras liberar una, la confirmación es nueva.
          if (error.code === "LIMIT_EXCEEDED") idempotencyKey.current = newIdempotencyKey()
          setMessage(errorMessage(error))
        }
        return
      }
      setImportJobId(response.value.jobId)
      if (mode === "replace") setHistoryKey((key) => key + 1)
      setPreview(null)
      setPrepared(null)
      if (!response.value.result) {
        // Otro proceso la está publicando: el panel del trabajo muestra cuándo queda confirmada.
        setMessage({ type: "success", text: "La importación está en cola y se publicará en segundo plano. Puedes seguir su estado debajo, aunque recargues la página." })
        return
      }
      setResult(response.value.result)
      try {
        setData(await getLibraryDataAction())
        setMessage({ type: "success", text: "La importación ha terminado. Revisa el resultado debajo." })
      } catch {
        setData(null)
        setMessage({ type: "success", text: "La importación ha terminado, pero no se pudo actualizar la vista. Recarga los datos para ver la colección actual." })
      }
    } catch {
      // Respuesta perdida: la misma clave permite reintentar sin aplicar la importación dos veces.
      setMessage({ type: "error", text: "No se recibió la respuesta de la importación. Puedes volver a confirmar: si ya se aplicó, se mostrará el mismo resultado sin repetirla." })
    } finally {
      setIsImporting(false)
    }
  }

  const cancelImport = () => {
    setPreview(null)
    setPrepared(null)
    setStale(null)
  }

  const plan = prepared?.plan
  const titles = new Map((data?.books ?? []).map((book) => [book.id, book.title]))
  const deletedTitles = plan ? plan.books.delete.map((id) => titles.get(id) ?? "Libro sin título disponible") : []
  const skippedTitles = plan && preview ? plan.books.skip.map((entry) => preview.library.books.find((book) => book.id === entry.sourceId)?.title ?? "") : []
  const expiresAt = prepared ? new Date(prepared.expiresAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : ""

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 py-8 md:py-12 outline-none">
        <div className="mb-8">
          <Button asChild variant="outline" className="mb-4 rounded-xl"><Link href="/"><ArrowLeft aria-hidden="true" />Volver al inicio</Link></Button>
          <h1 className="text-4xl md:text-5xl font-bold heading-vintage mb-2">Ajustes</h1>
          <p className="text-lg text-muted-foreground">Copia, revisa e importa tu biblioteca</p>
        </div>

        {/* Región en vivo fija: los avisos no desplazan el contenido de la página (tarea T2, CLS). */}
        <div aria-live="polite" className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-2xl pointer-events-none">
          {message && <div role={message.type === "error" ? "alert" : "status"} className={`pointer-events-auto p-4 rounded-xl border shadow-xl backdrop-blur-xl flex items-start gap-3 ${message.type === "error" ? "border-destructive bg-background/95" : "border-border bg-card/95"}`}>
            {message.type === "success" ? <CheckCircle aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5" /> : <AlertCircle aria-hidden="true" className="w-5 h-5 text-destructive shrink-0 mt-0.5" />}
            <div className="flex-1"><p className="text-foreground">{message.text}</p>{message.reference && <p className="text-xs text-muted-foreground mt-1">Referencia para soporte: {message.reference}</p>}</div>
            <Button type="button" variant="ghost" size="icon" className="shrink-0 -mr-2 -mt-2" onClick={() => setMessage(null)} aria-label="Cerrar aviso"><X aria-hidden="true" /></Button>
          </div>}
        </div>
        {!data && !loading && <Button onClick={() => { setLoading(true); void refresh() }} disabled={busy} variant="outline" className="mb-6">Reintentar carga</Button>}

        <div className="space-y-6">
          <section aria-labelledby="export-title" className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
            <h2 id="export-title" className="text-2xl font-bold mb-2">Exportar una copia</h2>
            <p className="text-muted-foreground mb-4">Descarga un JSON con libros, estanterías, estado de lectura, versión del formato y fecha de exportación. Se consultarán los datos actuales antes de descargar. Las colecciones grandes se dividen automáticamente en archivos que respetan los límites de importación.</p>
            {loading ? <p role="status" className="text-sm mb-4">Cargando biblioteca…</p> : data && <p className="text-sm mb-4">Biblioteca actual: {data.books.length} libros en {data.shelves.length} estanterías.</p>}
            <Button onClick={() => void handleExport()} disabled={!data || busy || loading} className="rounded-xl">{isExporting ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}{isExporting ? "Preparando copia…" : "Descargar copia de seguridad"}</Button>
            {/* Espacio reservado para el estado de la última copia: aparecer no empuja las secciones siguientes. */}
            <div className="mt-3 min-h-[4.5rem] text-xs text-muted-foreground space-y-1">
              <p>{exportFormat ? `Formato de la última copia: ${exportFormat === 2 ? "versión 2 (conserva la procedencia por campo; solo la importan versiones de BibLib que leen el formato 2)" : "versión 1 (sin pérdida de datos)"}.` : "Todavía no has descargado ninguna copia en esta visita."}</p>
              {exportParts.length > 1 && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setPartsOpen(true)} disabled={busy}>Ver las {exportParts.length} partes de la última copia</Button>}
            </div>
          </section>

          <Dialog open={partsOpen && exportParts.length > 1} onOpenChange={setPartsOpen}>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Descarga las {exportParts.length} partes</DialogTitle><DialogDescription>Para restaurar sustituyendo la colección, usa «Reemplazar» solo con la primera y «Fusionar» con todas las demás. Comprueba el resultado de cada importación.</DialogDescription></DialogHeader>
              <ol className="space-y-2 list-decimal pl-5">{exportParts.map((part, index) => <li key={index}><Button type="button" variant="outline" disabled={busy} onClick={() => downloadPart(part, index, exportParts.length)} className="h-auto whitespace-normal text-left">Descargar parte {index + 1} de {exportParts.length} · {backupPartCounts(part).books} libros · {backupPartCounts(part).shelves} estanterías</Button></li>)}</ol>
              <p className="text-xs text-muted-foreground">Las partes comparten fecha e identificadores. Las estanterías con libros en varias partes se unen al fusionar.</p>
            </DialogContent>
          </Dialog>

          <section aria-labelledby="import-title" aria-busy={isImporting || isValidating || isPreparing} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
            <h2 id="import-title" className="text-2xl font-bold mb-2">Importar una biblioteca</h2>
            <p className="text-muted-foreground mb-4">Selecciona un JSON para validarlo y revisar qué cambiará en tu biblioteca. Elegir el archivo todavía no modifica tus datos.</p>
            <p id="import-limits" className="text-sm text-muted-foreground mb-4">Formato antiguo de BibLib o versión 1. Máximo 8 MiB, {MAX_IMPORT_BOOKS.toLocaleString("es")} libros y {MAX_IMPORT_SHELVES} estanterías.</p>
            <input ref={fileInput} id="import-file" type="file" accept=".json,application/json" onChange={(event) => void handleFile(event)} disabled={busy || !data || loading} className="sr-only" tabIndex={-1} aria-label="Archivo JSON de biblioteca" aria-describedby="import-limits" />
            <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy || !data || loading} variant="secondary" className="rounded-xl">{isValidating ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}{isValidating ? "Validando archivo…" : preview ? "Elegir otro archivo" : "Seleccionar archivo JSON"}</Button>

            {preview && isPreparing && <p role="status" className="mt-6 flex items-start gap-2 text-sm"><LoaderCircle aria-hidden="true" className="w-4 h-4 animate-spin shrink-0 mt-0.5" />Preparando la revisión de «{preview.name}» con tu biblioteca actual. No se consulta ningún catálogo: las portadas pendientes se buscan después, en segundo plano.</p>}

            {preview && stale && !isPreparing && <div role="alert" className="mt-6 rounded-xl border border-destructive bg-destructive/10 p-4 space-y-3">
              <p className="font-medium">{stale.reason === "conflict" ? "Tu biblioteca ha cambiado" : "La revisión ya no es válida"}</p>
              <p className="text-sm">{stale.text}</p>
              <p className="text-sm text-muted-foreground">Se conservan el archivo «{preview.name}» y el modo «{mode === "replace" ? "Reemplazar" : "Fusionar"}». Revisa de nuevo el plan antes de confirmar.</p>
              <div className="flex flex-wrap gap-3"><Button onClick={() => void prepare(preview.library, mode)} disabled={busy}><RefreshCw aria-hidden="true" />Volver a revisar con los datos actuales</Button><Button variant="outline" onClick={cancelImport} disabled={busy}>Cancelar importación</Button></div>
            </div>}

            {preview && prepared && plan && <div className="mt-6 space-y-5">
              <div className="rounded-xl border border-border p-4">
                <h3 className="font-semibold break-all">Revisión: {preview.name}</h3>
                <p className="text-xs text-muted-foreground mt-1">Revisión preparada frente a tu biblioteca actual. Caduca a las {expiresAt}; si cambias algo en otra pestaña antes de confirmar, tendrás que volver a revisarla.</p>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  {([
                    ["Libros en el archivo", preview.library.books.length],
                    ["Estanterías en el archivo", preview.library.shelves.length],
                    ["Libros nuevos", plan.counts.added],
                    [mode === "merge" ? "Ya presentes (se omiten)" : "Se sustituyen conservando su enlace", mode === "merge" ? plan.counts.skipped : plan.counts.overwritten],
                    ["Libros que se eliminarán", plan.counts.deleted],
                    ["Estanterías nuevas", plan.counts.shelvesCreated],
                    ["Estanterías que se eliminarán", plan.counts.shelvesDeleted],
                    ["Con identificador nuevo", plan.counts.reassigned],
                    ["Sin portada", plan.counts.coversPending],
                  ] as const).map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold text-lg">{count}</dd></div>)}
                </dl>
                <p className="text-sm mt-3">Tras la importación tendrás {plan.counts.booksAfter} libros en {plan.counts.shelvesAfter} estanterías.</p>
                {skippedTitles.length > 0 && <p className="text-sm mt-3">Ya presentes: {skippedTitles.slice(0, 5).join("; ")}{skippedTitles.length > 5 ? "…" : ""}. Al fusionar se conservarán sus datos actuales.</p>}
                {deletedTitles.length > 0 && <details className="mt-3 text-sm" open={deletedTitles.length <= 10}><summary className="cursor-pointer font-medium">Libros actuales que se eliminarán ({deletedTitles.length})</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{deletedTitles.map((title, index) => <li key={`${plan.books.delete[index]}`}>{title}</li>)}</ul></details>}
                {preview.library.books.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Ver libros del archivo</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{preview.library.books.map((book) => <li key={book.id}>{book.title}{book.authors.length > 0 ? ` — ${book.authors.map((author) => author.name).join(", ")}` : ""}</li>)}</ul></details>}
              </div>

              <fieldset disabled={busy} className="space-y-3">
                <legend className="font-semibold mb-2">¿Cómo quieres importar?</legend>
                <label className="flex items-start gap-3 border border-border rounded-xl p-4 cursor-pointer"><input type="radio" name="import-mode" value="merge" checked={mode === "merge"} onChange={() => changeMode("merge")} className="mt-1" /><span><strong className="block">Fusionar con mi biblioteca</strong><span className="text-sm text-muted-foreground">Añade los libros nuevos y omite los ya presentes por ISBN o identificador. Conserva los libros actuales y une las estanterías con el mismo nombre.</span></span></label>
                <label className="flex items-start gap-3 border border-border rounded-xl p-4 cursor-pointer"><input type="radio" name="import-mode" value="replace" checked={mode === "replace"} onChange={() => changeMode("replace")} className="mt-1" /><span><strong className="block">Reemplazar la biblioteca</strong><span className="text-sm text-muted-foreground">Sustituye tus libros actuales por los del archivo y reemplaza las estanterías personalizadas. Se conserva la estantería predeterminada de tu cuenta. Al elegirlo se prepara una revisión nueva.</span></span></label>
              </fieldset>

              <p className="text-sm text-muted-foreground">Los identificadores de entidades nuevas o de otra cuenta pueden cambiar; sus enlaces antiguos pueden dejar de funcionar. Los ISBN de referencia y las portadas no confirman la edición física.</p>
              {mode === "replace" && <div className="rounded-xl border border-destructive p-4"><p className="font-medium mb-3">El reemplazo elimina los libros actuales que no estén en el archivo. Antes de aplicarlo, BibLib guardará tu colección actual en «Versiones anteriores» para que puedas restaurarla; si ya tienes el máximo de versiones guardadas, el reemplazo no se aplicará. También puedes descargar una copia.</p><Button variant="outline" onClick={() => void handleExport()} disabled={busy}><Download aria-hidden="true" />Descargar copia previa</Button></div>}
              <div className="flex flex-wrap gap-3"><Button onClick={() => { setReplaceAcknowledged(false); setConfirmationOpen(true) }} disabled={busy} variant={mode === "replace" ? "destructive" : "default"}>Continuar y confirmar</Button><Button variant="outline" onClick={cancelImport} disabled={busy}>Cancelar importación</Button></div>
            </div>}
            {isImporting && <p role="status" className="mt-4 flex items-start gap-2 text-sm"><LoaderCircle aria-hidden="true" className="w-4 h-4 animate-spin shrink-0 mt-0.5" />Aplicando la revisión confirmada. Mantén esta página abierta hasta recibir el resultado.</p>}
          </section>

          {result && <section aria-labelledby="result-title" className="rounded-2xl border border-border bg-card p-5 md:p-8"><h2 id="result-title" className="text-2xl font-bold mb-4">Resultado de la importación</h2><ul className="space-y-2"><li>Libros importados: <strong>{result.imported}</strong></li><li>Libros omitidos por estar presentes: <strong>{result.skipped}</strong></li><li>Libros eliminados: <strong>{result.deleted}</strong></li><li>Estanterías de la biblioteca resultante: <strong>{result.shelves}</strong></li><li>Libros importados con portada genérica, pendientes de búsqueda: <strong>{result.coversPending}</strong></li></ul>{result.coversPending > 0 && <p className="text-sm text-muted-foreground mt-4">La colección se ha importado. Las portadas pendientes se buscan en segundo plano, en pasos acotados y respetando los límites de cada catálogo; si alguna no aparece, la importación no se revierte.</p>}<Button asChild variant="outline" className="mt-4"><Link href="/books">Ver mi colección</Link></Button></section>}

          <ImportJobPanel jobId={importJobId} disabled={loading} />

          <SnapshotHistory refreshKey={historyKey} disabled={busy || loading} onNotice={setMessage} onRestored={() => { setResult(null); getLibraryDataAction().then(setData).catch(() => setData(null)) }} />

          <CoverRecoveryJobPanel disabled={busy || loading || !data} onRunningChange={setIsRecovering} onFinish={refresh} />

          <section className="rounded-2xl border border-border bg-card/80 p-5 md:p-6"><h2 className="font-bold mb-3">Tus datos y copias</h2><ul className="list-disc pl-5 text-sm text-muted-foreground space-y-2"><li>Los datos están vinculados a tu cuenta y se guardan en la base de datos.</li><li>La copia JSON conserva fichas, estanterías y estado de lectura; no descarga las imágenes de las portadas.</li><li>Guarda copias periódicas y antes de reemplazar una colección.</li></ul></section>
        </div>
      </main>

      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{mode === "replace" ? "Confirmar reemplazo de la biblioteca" : "Confirmar importación"}</AlertDialogTitle><AlertDialogDescription>{mode === "replace" ? `Se eliminarán ${plan?.counts.deleted ?? 0} libros actuales, se sustituirán ${plan?.counts.overwritten ?? 0} conservando su enlace y se añadirán ${plan?.counts.added ?? 0}. Antes se guardará tu colección actual como versión anterior: podrás restaurarla desde «Versiones anteriores» durante 30 días.` : `Se añadirán ${plan?.counts.added ?? 0} libros y se omitirán ${plan?.counts.skipped ?? 0} ya presentes. Tus libros actuales se conservarán.`} Solo se aplicará si tu biblioteca no ha cambiado desde esta revisión.</AlertDialogDescription></AlertDialogHeader>
          {mode === "replace" && <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={replaceAcknowledged} onChange={(event) => setReplaceAcknowledged(event.target.checked)} className="mt-1" /><span>Entiendo que se reemplazará mi colección actual.</span></label>}
          <AlertDialogFooter><AlertDialogCancel>Volver a la revisión</AlertDialogCancel><AlertDialogAction disabled={busy || !prepared || (mode === "replace" && !replaceAcknowledged)} onClick={() => void handleConfirm()}>{mode === "replace" ? "Sí, reemplazar biblioteca" : "Sí, fusionar biblioteca"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
