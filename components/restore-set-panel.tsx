"use client"

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react"
import { Files, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  beginRestoreSessionAction, commitRestoreSessionAction, discardRestoreSessionAction, listRestoreSessionsAction,
  prepareRestoreSessionAction, uploadRestorePartAction, validateRestoreSessionAction, type RestoreCommitResult,
} from "@/app/actions/restore-sessions"
import type { ActionError, ActionResult } from "@/lib/action-result"
import { looksLikeManifest, ManifestError, parseBackupSetManifest, RESTORE_LIMITS, type BackupSetManifest } from "@/lib/import-manifest"
import type { PreparedRestore, RestoreSessionView, ValidatedSession } from "@/lib/import-staging"

// U-DAT-04 · Restaurar una copia por partes como una sola operación. Se seleccionan todas las partes
// (y su manifiesto, si existe); el navegador calcula el hash de cada archivo y lo sube en trozos de
// 256 KiB sin interpretarlo. El servidor valida el conjunto, prepara la comparación con la colección
// actual y la publica en una única transacción. Una parte suelta sigue pudiendo importarse arriba.

type Notice = { type: "success" | "error"; text: string; reference?: string }
interface SelectedPart { file: File; sha256: string }
interface Selection { manifest: BackupSetManifest | null; parts: SelectedPart[] }
type Phase = "idle" | "reading" | "loose" | "uploading" | "validating" | "validated" | "preparing" | "prepared" | "committing" | "done"

const MANIFEST_MAX_BYTES = 1024 * 1024
const newIdempotencyKey = () => crypto.randomUUID()
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString("es", { maximumFractionDigits: 1 })} MiB`
const time = (iso: string) => new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
const longDate = (iso: string) => new Date(iso).toLocaleString("es", { dateStyle: "long", timeStyle: "short" })

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

class PanelError extends Error {
  constructor(readonly error: ActionError | { code?: undefined; message: string; correlationId?: undefined }) { super(error.message) }
}

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new PanelError(result.error)
  return result.value
}

/** Separa el manifiesto (reconocido por su comienzo, sin leer partes grandes) de las partes y calcula sus hashes. */
async function readSelection(files: File[]): Promise<Selection> {
  let manifest: BackupSetManifest | null = null
  const parts: SelectedPart[] = []
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }))) {
    if (file.size <= MANIFEST_MAX_BYTES && looksLikeManifest(await file.slice(0, 256).text())) {
      if (manifest) throw new PanelError({ message: "Has seleccionado más de un manifiesto. Elige solo el de la copia que quieres restaurar." })
      try { manifest = parseBackupSetManifest(JSON.parse(await file.text())) } catch (error) {
        throw new PanelError({ message: error instanceof ManifestError ? error.message : "El manifiesto no es un JSON válido." })
      }
      continue
    }
    if (file.size > RESTORE_LIMITS.maxPartBytes) throw new PanelError({ message: `«${file.name}» supera el límite de 8 MiB por parte.` })
    if (file.size === 0) throw new PanelError({ message: `«${file.name}» está vacío.` })
    parts.push({ file, sha256: await sha256Hex(await file.arrayBuffer()) })
  }
  if (!parts.length) throw new PanelError({ message: "Selecciona las partes de la copia y, si lo tienes, su manifiesto." })
  if (!manifest) return { manifest, parts }
  const bySha = new Map(parts.map((part) => [part.sha256, part]))
  const foreign = parts.filter((part) => !manifest!.parts.some((entry) => entry.sha256 === part.sha256)).map((part) => `«${part.file.name}»`)
  if (foreign.length) throw new PanelError({ message: `${foreign.join(", ")} no ${foreign.length === 1 ? "pertenece" : "pertenecen"} al conjunto del manifiesto: ${foreign.length === 1 ? "está dañado o es" : "están dañados o son"} de otra copia.` })
  const missing = manifest.parts.filter((entry) => !bySha.has(entry.sha256)).map((entry) => entry.index + 1)
  if (missing.length) throw new PanelError({ message: `Faltan ${missing.length === 1 ? "la parte" : "las partes"} ${missing.join(", ")} de ${manifest.parts.length}. Selecciónalas junto con las demás.` })
  return { manifest, parts: manifest.parts.map((entry) => bySha.get(entry.sha256)!) }
}

const sameFiles = (session: RestoreSessionView, selection: Selection) =>
  session.source === (selection.manifest ? "manifest" : "loose") && session.parts.length === selection.parts.length
  && session.parts.every((part, index) => part.sha256 === selection.parts[index].sha256)
  && (!selection.manifest || session.exportSetId === selection.manifest.exportSetId)

export function RestoreSetPanel({ disabled, onNotice, onCommitted }: { disabled: boolean; onNotice: (notice: Notice) => void; onCommitted: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [selection, setSelection] = useState<Selection | null>(null)
  const [session, setSession] = useState<RestoreSessionView | null>(null)
  const [validated, setValidated] = useState<ValidatedSession | null>(null)
  const [prepared, setPrepared] = useState<PreparedRestore | null>(null)
  const [result, setResult] = useState<RestoreCommitResult | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState(0)
  const [looseAcknowledged, setLooseAcknowledged] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [open, setOpen] = useState<RestoreSessionView[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  // Una clave por revisión preparada: reintentar tras perder la respuesta recupera el mismo resultado.
  const commitKey = useRef("")
  const working = ["reading", "uploading", "validating", "preparing", "committing"].includes(phase)
  const busy = disabled || working

  const loadOpen = useCallback(() => listRestoreSessionsAction().then((response) => { if (response.ok) setOpen(response.value) }).catch(() => { /* Se consultará de nuevo al empezar. */ }), [])
  useEffect(() => { void loadOpen() }, [loadOpen])

  const fail = (error: unknown, fallback: string) => {
    const detail = error instanceof PanelError ? error.error : null
    onNotice({ type: "error", text: detail?.message ?? fallback, reference: detail?.correlationId })
    return detail
  }

  const reset = () => {
    setSelection(null); setSession(null); setValidated(null); setPrepared(null); setResult(null); setStale(null)
    setUploaded(0); setLooseAcknowledged(false); setAcknowledged(false); setPhase("idle")
  }

  const prepare = async (sessionId: string) => {
    setPhase("preparing")
    setStale(null)
    try {
      const value = unwrap(await prepareRestoreSessionAction({ sessionId }))
      commitKey.current = newIdempotencyKey()
      setPrepared(value)
      setPhase("prepared")
    } catch (error) {
      fail(error, "No se pudo comparar la copia con tu biblioteca. No se ha modificado nada; vuelve a intentarlo.")
      setPhase("validated")
    }
  }

  /** Sube los trozos que falten (repetir uno ya recibido no cambia nada) y valida el conjunto en el servidor. */
  const upload = async (current: Selection) => {
    setPhase("uploading")
    try {
      const reusable = open.find((candidate) => candidate.state === "receiving" && sameFiles(candidate, current))
      const started = reusable ?? unwrap(await beginRestoreSessionAction(current.manifest
        ? { manifest: current.manifest }
        : { parts: current.parts.map((part) => ({ byteLength: part.file.size, sha256: part.sha256 })) }))
      setSession(started)
      let done = started.parts.filter((part) => part.receivedChunks === part.totalChunks).reduce((total, part) => total + part.byteLength, 0)
      setUploaded(done)
      for (const part of started.parts) {
        if (part.receivedChunks === part.totalChunks) continue
        const file = current.parts[part.index].file
        for (let ordinal = 0; ordinal < part.totalChunks; ordinal++) {
          const chunk = file.slice(ordinal * RESTORE_LIMITS.chunkBytes, Math.min(file.size, (ordinal + 1) * RESTORE_LIMITS.chunkBytes))
          const receipt = unwrap(await uploadRestorePartAction({ sessionId: started.sessionId, partId: part.partId, ordinal, total: part.totalChunks, sha256: await sha256Hex(await chunk.arrayBuffer()), chunk }))
          done = receipt.receivedBytes
          setUploaded(done)
        }
      }
      setPhase("validating")
      const value = unwrap(await validateRestoreSessionAction({ sessionId: started.sessionId }))
      setValidated(value)
      setSession(value.session)
      setPhase("validated")
      void loadOpen()
    } catch (error) {
      const detail = fail(error, "Se interrumpió la subida. Las partes recibidas se conservan: vuelve a seleccionar los mismos archivos para continuar.")
      if (detail?.code === "MANIFEST_MISMATCH" || detail?.code === "LIMIT_EXCEEDED" || detail?.code === "INVALID_INPUT") reset()
      else setPhase("idle")
      void loadOpen()
    }
  }

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ""
    if (!files.length || busy) return
    reset()
    setPhase("reading")
    let current: Selection
    try { current = await readSelection(files) } catch (error) {
      fail(error, "No se pudieron leer los archivos seleccionados. No se ha modificado nada.")
      setPhase("idle")
      return
    }
    setSelection(current)
    if (current.manifest) await upload(current)
    else setPhase("loose")
  }

  const commit = async () => {
    if (!prepared || busy || !acknowledged) return
    setConfirmOpen(false)
    setPhase("committing")
    try {
      const response = await commitRestoreSessionAction({ sessionId: prepared.sessionId, previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: commitKey.current })
      if (!response.ok) {
        const { error } = response
        if (error.code === "REVISION_CONFLICT" || error.code === "PREVIEW_EXPIRED" || error.code === "IDEMPOTENCY_CONFLICT") {
          // Nunca se reintenta con la revisión antigua: las partes se conservan y hay que volver a revisar.
          setStale(error.message)
          setPrepared(null)
          setPhase("validated")
        } else {
          onNotice({ type: "error", text: error.message, reference: error.correlationId })
          setPhase("prepared")
        }
        return
      }
      setResult(response.value)
      setPrepared(null)
      setPhase("done")
      onCommitted()
      void loadOpen()
      onNotice({ type: "success", text: `${response.value.replayed ? "Esta restauración ya se había publicado. " : "Copia restaurada en una sola operación. "}Tu biblioteca tiene ahora ${response.value.result.imported} libros en ${response.value.result.shelves} estanterías. La colección anterior se ha guardado en «Versiones anteriores».` })
    } catch {
      // Respuesta perdida: la misma clave permite reintentar sin publicar dos veces.
      onNotice({ type: "error", text: "No se recibió la respuesta de la restauración. Puedes volver a confirmarla: si ya se publicó, verás el mismo resultado sin repetirla." })
      setPhase("prepared")
    }
  }

  const discard = async (sessionId: string) => {
    if (busy) return
    try {
      unwrap(await discardRestoreSessionAction({ sessionId }))
      onNotice({ type: "success", text: "Restauración descartada. Tu biblioteca no ha cambiado." })
      if (session?.sessionId === sessionId) reset()
    } catch (error) { fail(error, "No se pudo descartar la restauración. Vuelve a intentarlo.") }
    void loadOpen()
  }

  const plan = prepared?.plan
  const total = selection?.parts.reduce((sum, part) => sum + part.file.size, 0) ?? 0
  const pending = open.filter((candidate) => candidate.sessionId !== session?.sessionId)
  return (
    <section aria-labelledby="restore-set-title" aria-busy={working} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
      <h2 id="restore-set-title" className="text-2xl font-bold mb-2 flex items-center gap-2"><Files aria-hidden="true" className="w-6 h-6" />Restaurar una copia por partes</h2>
      <p className="text-muted-foreground mb-3">Selecciona a la vez todas las partes de una copia y su manifiesto («…-conjunto.json»). BibLib comprueba que están completas, que son de la misma copia y que no se han modificado, y sustituye tu colección por la copia en una sola operación: nunca queda a medias.</p>
      <p id="restore-set-limits" className="text-sm text-muted-foreground mb-4">Hasta {RESTORE_LIMITS.maxBooks.toLocaleString("es")} libros, {RESTORE_LIMITS.maxShelves.toLocaleString("es")} estanterías y 80 MiB por copia. Seleccionar los archivos no modifica tu biblioteca.</p>
      <input ref={fileInput} id="restore-set-files" type="file" multiple accept=".json,application/json" onChange={(event) => void handleFiles(event)} disabled={busy} className="sr-only" tabIndex={-1} aria-label="Partes de la copia y manifiesto" aria-describedby="restore-set-limits" />
      <Button type="button" variant="secondary" className="rounded-xl" onClick={() => fileInput.current?.click()} disabled={busy}>{phase === "reading" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Files aria-hidden="true" />}{phase === "reading" ? "Comprobando archivos…" : "Seleccionar las partes de la copia"}</Button>

      {pending.length > 0 && phase === "idle" && <div className="mt-4 rounded-xl border border-border p-4 space-y-2 text-sm">
        <p className="font-medium">Restauraciones a medias</p>
        <ul className="space-y-2">{pending.map((candidate) => <li key={candidate.sessionId} className="flex flex-wrap items-center justify-between gap-2">
          <span>{candidate.partCount} {candidate.partCount === 1 ? "parte" : "partes"} · {mib(candidate.receivedBytes)} de {mib(candidate.totalBytes)} recibidos · caduca el {longDate(candidate.expiresAt)}. Vuelve a seleccionar los mismos archivos para continuar.</span>
          <Button size="sm" variant="outline" onClick={() => void discard(candidate.sessionId)} disabled={busy} aria-label={`Descartar la restauración que caduca el ${longDate(candidate.expiresAt)}`}><Trash2 aria-hidden="true" />Descartar</Button>
        </li>)}</ul>
      </div>}

      <div className="mt-4 space-y-4">
        {phase === "loose" && selection && <div className="rounded-xl border border-border p-4 space-y-3">
          <p className="font-medium">{selection.parts.length === 1 ? "Esta parte no trae manifiesto" : `Estas ${selection.parts.length} partes no traen manifiesto`}</p>
          <p className="text-sm">{selection.parts.length === 1
            ? "BibLib la inspeccionará y generará el manifiesto en el servidor antes de restaurarla."
            : "BibLib las inspeccionará, comprobará que encajan entre sí y generará el manifiesto en el servidor. Que tengan la misma fecha no demuestra que pertenezcan a la misma copia."}</p>
          <ol className="list-decimal pl-5 text-sm">{selection.parts.map((part) => <li key={part.sha256} className="break-all">{part.file.name} · {mib(part.file.size)}</li>)}</ol>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={looseAcknowledged} onChange={(event) => setLooseAcknowledged(event.target.checked)} className="mt-1" /><span>Confirmo que estas partes son de la misma copia, en este orden.</span></label>
          <div className="flex flex-wrap gap-3"><Button onClick={() => void upload(selection)} disabled={busy || !looseAcknowledged}>Subir y comprobar las partes</Button><Button variant="outline" onClick={reset} disabled={busy}>Cancelar</Button></div>
        </div>}

        {(phase === "uploading" || phase === "validating") && selection && <div role="status" className="space-y-2 text-sm">
          <p className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="w-4 h-4 animate-spin" />{phase === "uploading" ? `Subiendo ${selection.parts.length} ${selection.parts.length === 1 ? "parte" : "partes"}: ${mib(uploaded)} de ${mib(total)}.` : "Comprobando el conjunto en el servidor…"}</p>
          <progress className="w-full" max={total || 1} value={phase === "validating" ? total : uploaded} aria-label="Progreso de la subida" />
          <p className="text-muted-foreground">Puedes cerrar la página: las partes recibidas se conservan 7 días y la subida continúa al volver a seleccionar los mismos archivos.</p>
        </div>}

        {validated && session && (phase === "validated" || phase === "preparing") && <div className="rounded-xl border border-border p-4 space-y-3">
          <p className="font-medium">Conjunto completo y verificado</p>
          <p className="text-sm">{session.partCount} {session.partCount === 1 ? "parte" : "partes"} con {validated.session.totals?.books ?? 0} libros y {validated.session.totals?.shelves ?? 0} estanterías, en formato {validated.manifest.payloadFormatVersion}. Todos los hashes coinciden con el manifiesto.</p>
          {validated.warnings.map((warning) => <p key={warning} className="text-sm rounded-lg border border-border p-2">{warning}</p>)}
          {stale && <div role="alert" className="rounded-xl border border-destructive bg-destructive/10 p-3 space-y-2"><p className="font-medium">La revisión ya no es válida</p><p className="text-sm">{stale}</p></div>}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void prepare(session.sessionId)} disabled={busy}>{phase === "preparing" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : stale ? <RefreshCw aria-hidden="true" /> : null}{stale ? "Volver a revisar con los datos actuales" : "Revisar qué cambiará"}</Button>
            <Button variant="outline" onClick={() => void discard(session.sessionId)} disabled={busy}><Trash2 aria-hidden="true" />Descartar</Button>
          </div>
        </div>}

        {prepared && plan && (phase === "prepared" || phase === "committing") && <div className="rounded-xl border border-border p-4 space-y-4" aria-labelledby="restore-set-preview-title">
          <h3 id="restore-set-preview-title" className="font-semibold">Restaurar la copia completa</h3>
          <p className="text-xs text-muted-foreground">Comparación con tu biblioteca actual. Caduca a las {time(prepared.expiresAt)}; si cambias algo en otra pestaña antes de confirmar, tendrás que volver a revisarla (las partes se conservan).</p>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {([
              ["Libros en la copia", prepared.totals.books],
              ["Estanterías en la copia", prepared.totals.shelves],
              ["Libros que se añaden", plan.counts.added],
              ["Se sustituyen conservando su enlace", plan.counts.overwritten],
              ["Libros actuales que desaparecen", plan.counts.deleted],
              ["Con identificador nuevo", plan.counts.reassigned],
            ] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold text-lg">{value}</dd></div>)}
          </dl>
          <p className="text-sm">Tras restaurar tendrás {plan.counts.booksAfter} libros en {plan.counts.shelvesAfter} estanterías. Se conserva tu estantería predeterminada.</p>
          {prepared.changes.removedTotal > 0 && <details className="text-sm" open={prepared.changes.removedTotal <= 10}><summary className="cursor-pointer font-medium">Libros actuales que desaparecen ({prepared.changes.removedTotal})</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{prepared.changes.removed.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}</ul>{prepared.changes.removedTotal > prepared.changes.removed.length && <p className="mt-1 text-muted-foreground">Y {prepared.changes.removedTotal - prepared.changes.removed.length} más.</p>}</details>}
          <p className="text-sm text-muted-foreground">Antes de restaurar se guardará tu colección actual en «Versiones anteriores». Si la publicación no cabe en el tiempo previsto o falla, no se aplica nada.</p>
          <div className="flex flex-wrap gap-3"><Button variant="destructive" onClick={() => { setAcknowledged(false); setConfirmOpen(true) }} disabled={busy}>{phase === "committing" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />}Restaurar la copia</Button><Button variant="outline" onClick={() => void discard(prepared.sessionId)} disabled={busy}><Trash2 aria-hidden="true" />Descartar</Button></div>
        </div>}

        {result && phase === "done" && <div role="status" className="rounded-xl border border-border p-4 space-y-2 text-sm">
          <p className="font-medium">Copia restaurada</p>
          <ul className="space-y-1"><li>Libros restaurados: <strong>{result.result.imported}</strong></li><li>Libros eliminados: <strong>{result.result.deleted}</strong></li><li>Estanterías de la biblioteca resultante: <strong>{result.result.shelves}</strong></li><li>Con identificador nuevo: <strong>{result.result.reassigned}</strong></li></ul>
          <Button variant="outline" size="sm" onClick={reset}>Restaurar otra copia</Button>
        </div>}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Confirmar la restauración de la copia</AlertDialogTitle><AlertDialogDescription>Se sustituirá tu colección por la copia: desaparecerán {plan?.counts.deleted ?? 0} libros actuales y quedarán {plan?.counts.booksAfter ?? 0}. Antes se guardará tu colección actual como versión anterior. Solo se aplicará si tu biblioteca no ha cambiado desde esta revisión.</AlertDialogDescription></AlertDialogHeader>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" /><span>Entiendo que se sustituirá mi colección actual por esta copia.</span></label>
          <AlertDialogFooter><AlertDialogCancel>Volver a la revisión</AlertDialogCancel><AlertDialogAction disabled={busy || !acknowledged} onClick={() => void commit()}>Sí, restaurar la copia</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
