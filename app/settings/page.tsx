"use client"

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react"
import Link from "next/link"
import { Download, Upload, ArrowLeft, AlertCircle, CheckCircle, LoaderCircle } from "lucide-react"
import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { CoverRecoveryPanel } from "@/components/cover-recovery-panel"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { getLibraryDataAction, importLibraryDataAction } from "@/app/actions/library"
import {
  MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES, MAX_IMPORT_SHELVES,
  parseLibraryImport, summarizeLibraryImport, type LibraryImportOptions, type LibraryImportResult, type LibraryExport,
} from "@/lib/library-import"
import { fragmentLibraryExport } from "@/lib/library-export"
import type { LibraryData } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"

type Message = { type: "success" | "error"; text: string }
type Preview = { name: string; library: LibraryData }

export default function SettingsPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [exportParts, setExportParts] = useState<LibraryExport[]>([])
  const [isValidating, setIsValidating] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mode, setMode] = useState<LibraryImportOptions["mode"]>("merge")
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [replaceAcknowledged, setReplaceAcknowledged] = useState(false)
  const [result, setResult] = useState<LibraryImportResult | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = isImporting || isValidating || isExporting || isRecovering
  const summary = preview && data ? summarizeLibraryImport(preview.library, data) : null

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

  const downloadPart = (part: LibraryExport, index: number, total: number) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(part)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    const suffix = total > 1 ? `-parte-${String(index + 1).padStart(String(total).length, "0")}-de-${total}` : ""
    link.download = `biblib-backup-${part.exportedAt.replace(/[:.]/g, "-")}${suffix}.json`
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
      const parts = fragmentLibraryExport(current)
      setExportParts(parts)
      if (parts.length === 1) downloadPart(parts[0], 0, 1)
      setMessage({ type: "success", text: parts.length === 1
        ? `Copia preparada con ${current.books.length} libros y ${current.shelves.length} estanterías. Conserva el archivo descargado para restaurar la colección.`
        : `Copia dividida en ${parts.length} archivos importables. Descarga y conserva todas las partes que aparecen debajo.` })
    } catch {
      setMessage({ type: "error", text: "No se pudo preparar la copia. No se han modificado tus datos; vuelve a intentarlo." })
    } finally {
      setIsExporting(false)
    }
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || busy) return
    setPreview(null)
    setResult(null)
    setMessage(null)
    setMode("merge")
    setReplaceAcknowledged(false)
    setIsValidating(true)
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("El archivo supera el límite de 8 MiB.")
      let input: unknown
      try { input = JSON.parse(await file.text()) } catch { throw new Error("No se pudo leer el JSON. Comprueba que el archivo esté completo y sea válido.") }
      const library = parseLibraryImport(input)
      setData(await getLibraryDataAction())
      setPreview({ name: file.name, library })
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "No se pudo revisar el archivo. No se han modificado tus datos." })
    } finally {
      setIsValidating(false)
    }
  }

  const handleConfirm = async () => {
    if (!preview || busy || (mode === "replace" && !replaceAcknowledged)) return
    setIsImporting(true)
    setMessage(null)
    try {
      const imported = unwrapAction(await importLibraryDataAction(preview.library, { mode }))
      setResult(imported)
      setPreview(null)
      try {
        setData(await getLibraryDataAction())
        setMessage({ type: "success", text: "La importación ha terminado. Revisa el resultado debajo." })
      } catch {
        setData(null)
        setMessage({ type: "success", text: "La importación ha terminado, pero no se pudo actualizar la vista. Recarga los datos para ver la colección actual." })
      }
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "No se pudo completar la importación. Puedes revisar el archivo y reintentar." })
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 py-8 md:py-12 outline-none">
        <div className="mb-8">
          <Button asChild variant="outline" className="mb-4 rounded-xl"><Link href="/"><ArrowLeft aria-hidden="true" />Volver al inicio</Link></Button>
          <h1 className="text-4xl md:text-5xl font-bold heading-vintage mb-2">Ajustes</h1>
          <p className="text-lg text-muted-foreground">Copia, revisa e importa tu biblioteca</p>
        </div>

        {message && <div role={message.type === "error" ? "alert" : "status"} className={`mb-6 p-4 rounded-xl border flex items-start gap-3 ${message.type === "error" ? "border-destructive bg-destructive/10" : "border-border bg-card"}`}>
          {message.type === "success" ? <CheckCircle aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5" /> : <AlertCircle aria-hidden="true" className="w-5 h-5 text-destructive shrink-0 mt-0.5" />}
          <p className="text-foreground">{message.text}</p>
        </div>}
        {!data && !loading && <Button onClick={() => { setLoading(true); void refresh() }} disabled={busy} variant="outline" className="mb-6">Reintentar carga</Button>}

        <div className="space-y-6">
          <section aria-labelledby="export-title" className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
            <h2 id="export-title" className="text-2xl font-bold mb-2">Exportar una copia</h2>
            <p className="text-muted-foreground mb-4">Descarga un JSON con libros, estanterías, estado de lectura, versión del formato y fecha de exportación. Se consultarán los datos actuales antes de descargar. Las colecciones grandes se dividen automáticamente en archivos que respetan los límites de importación.</p>
            {loading ? <p role="status" className="text-sm mb-4">Cargando biblioteca…</p> : data && <p className="text-sm mb-4">Biblioteca actual: {data.books.length} libros en {data.shelves.length} estanterías.</p>}
            <Button onClick={() => void handleExport()} disabled={!data || busy || loading} className="rounded-xl">{isExporting ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}{isExporting ? "Preparando copia…" : "Descargar copia de seguridad"}</Button>
            {exportParts.length > 1 && <div className="mt-5 space-y-3"><p className="text-sm font-medium">Descarga las {exportParts.length} partes. Para restaurar sustituyendo la colección, usa «Reemplazar» solo con la primera y «Fusionar» con todas las demás. Comprueba el resultado de cada importación.</p><ol className="space-y-2 list-decimal pl-5">{exportParts.map((part, index) => <li key={index}><Button type="button" variant="outline" disabled={busy} onClick={() => downloadPart(part, index, exportParts.length)} className="h-auto whitespace-normal text-left">Descargar parte {index + 1} de {exportParts.length} · {part.books.length} libros · {part.shelves.length} estanterías</Button></li>)}</ol><p className="text-xs text-muted-foreground">Las partes comparten fecha e identificadores. Las estanterías con libros en varias partes se unen al fusionar.</p></div>}
          </section>

          <section aria-labelledby="import-title" aria-busy={isImporting || isValidating} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl">
            <h2 id="import-title" className="text-2xl font-bold mb-2">Importar una biblioteca</h2>
            <p className="text-muted-foreground mb-4">Selecciona un JSON para validarlo y revisar su contenido. Elegir el archivo todavía no modifica tu biblioteca.</p>
            <p id="import-limits" className="text-sm text-muted-foreground mb-4">Formato antiguo de BibLib o versión 1. Máximo 8 MiB, {MAX_IMPORT_BOOKS.toLocaleString("es")} libros y {MAX_IMPORT_SHELVES} estanterías.</p>
            <input ref={fileInput} id="import-file" type="file" accept=".json,application/json" onChange={(event) => void handleFile(event)} disabled={busy || !data || loading} className="sr-only" tabIndex={-1} aria-label="Archivo JSON de biblioteca" aria-describedby="import-limits" />
            <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy || !data || loading} variant="secondary" className="rounded-xl">{isValidating ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}{isValidating ? "Validando archivo…" : preview ? "Elegir otro archivo" : "Seleccionar archivo JSON"}</Button>

            {preview && summary && data && <div className="mt-6 space-y-5">
              <div className="rounded-xl border border-border p-4">
                <h3 className="font-semibold break-all">Revisión: {preview.name}</h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  {[['Libros en el archivo', summary.books], ['Estanterías', summary.shelves], ['Libros nuevos', summary.newBooks], ['Ya presentes', summary.duplicates.length], ['Sin portada', summary.missingCovers], ['Sin ISBN verificable', summary.withoutIsbn]].map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold text-lg">{count}</dd></div>)}
                </dl>
                {summary.duplicates.length > 0 && <p className="text-sm mt-3">Ya presentes: {summary.duplicates.slice(0, 5).map((book) => book.title).join("; ")}{summary.duplicates.length > 5 ? "…" : ""}. Al fusionar se conservarán sus datos actuales.</p>}
                {preview.library.books.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Ver libros del archivo</summary><ul className="list-disc pl-5 mt-2 space-y-1 max-h-64 overflow-auto">{preview.library.books.map((book) => <li key={book.id}>{book.title}{book.authors.length > 0 ? ` — ${book.authors.map((author) => author.name).join(", ")}` : ""}</li>)}</ul></details>}
              </div>

              <fieldset disabled={busy} className="space-y-3">
                <legend className="font-semibold mb-2">¿Cómo quieres importar?</legend>
                <label className="flex items-start gap-3 border border-border rounded-xl p-4 cursor-pointer"><input type="radio" name="import-mode" value="merge" checked={mode === "merge"} onChange={() => { setMode("merge"); setReplaceAcknowledged(false) }} className="mt-1" /><span><strong className="block">Fusionar con mi biblioteca</strong><span className="text-sm text-muted-foreground">Añade {summary.newBooks} libros y omite {summary.duplicates.length} ya presentes por ISBN o identificador. Conserva los libros actuales y une las estanterías con el mismo nombre.</span></span></label>
                <label className="flex items-start gap-3 border border-border rounded-xl p-4 cursor-pointer"><input type="radio" name="import-mode" value="replace" checked={mode === "replace"} onChange={() => { setMode("replace"); setReplaceAcknowledged(false) }} className="mt-1" /><span><strong className="block">Reemplazar la biblioteca</strong><span className="text-sm text-muted-foreground">Sustituye los {data.books.length} libros actuales por los {summary.books} del archivo y reemplaza las estanterías personalizadas. Se conserva la estantería predeterminada de tu cuenta.</span></span></label>
              </fieldset>

              <p className="text-sm text-muted-foreground">Los identificadores de entidades nuevas o de otra cuenta pueden cambiar; sus enlaces antiguos pueden dejar de funcionar. Los ISBN de referencia y las portadas no confirman la edición física.</p>
              <p className="text-sm text-muted-foreground">Se buscarán portadas ausentes en Open Library durante un máximo de 20 segundos. La importación continuará con portada genérica si faltan resultados o el servicio no responde.</p>
              {mode === "replace" && <div className="rounded-xl border border-destructive p-4"><p className="font-medium mb-3">El reemplazo elimina los libros actuales que no estén en el archivo. Descarga una copia antes para poder recuperarlos.</p><Button variant="outline" onClick={() => void handleExport()} disabled={busy}><Download aria-hidden="true" />Descargar copia previa</Button></div>}
              <div className="flex flex-wrap gap-3"><Button onClick={() => { setReplaceAcknowledged(false); setConfirmationOpen(true) }} disabled={busy} variant={mode === "replace" ? "destructive" : "default"}>Continuar y confirmar</Button><Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>Cancelar importación</Button></div>
            </div>}
            {isImporting && <p role="status" className="mt-4 flex items-start gap-2 text-sm"><LoaderCircle aria-hidden="true" className="w-4 h-4 animate-spin shrink-0 mt-0.5" />Importando y buscando portadas disponibles. Mantén esta página abierta hasta recibir el resultado; la búsqueda puede terminar con portadas pendientes.</p>}
          </section>

          {result && <section aria-labelledby="result-title" className="rounded-2xl border border-border bg-card p-5 md:p-8"><h2 id="result-title" className="text-2xl font-bold mb-4">Resultado de la importación</h2><ul className="space-y-2"><li>Libros importados: <strong>{result.imported}</strong></li><li>Libros omitidos por estar presentes: <strong>{result.skipped}</strong></li><li>Estanterías de la biblioteca resultante: <strong>{result.shelves}</strong></li><li>Portadas obtenidas de Open Library: <strong>{result.coversFound}</strong></li><li>Libros importados con portada genérica: <strong>{result.coversPending}</strong></li></ul>{result.coversPending > 0 && <p className="text-sm text-muted-foreground mt-4">La colección se ha importado. Puede faltar una portada porque no exista una ficha, falte un ISBN válido o la consulta haya llegado a su límite de tiempo.</p>}<Button asChild variant="outline" className="mt-4"><Link href="/books">Ver mi colección</Link></Button></section>}

          <CoverRecoveryPanel disabled={busy || loading || !data} onRunningChange={setIsRecovering} onFinish={refresh} />

          <section className="rounded-2xl border border-border bg-card/80 p-5 md:p-6"><h2 className="font-bold mb-3">Tus datos y copias</h2><ul className="list-disc pl-5 text-sm text-muted-foreground space-y-2"><li>Los datos están vinculados a tu cuenta y se guardan en la base de datos.</li><li>La copia JSON conserva fichas, estanterías y estado de lectura; no descarga las imágenes de las portadas.</li><li>Guarda copias periódicas y antes de reemplazar una colección.</li></ul></section>
        </div>
      </main>

      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{mode === "replace" ? "Confirmar reemplazo de la biblioteca" : "Confirmar importación"}</AlertDialogTitle><AlertDialogDescription>{mode === "replace" ? `Se sustituirán ${data?.books.length ?? 0} libros actuales por ${summary?.books ?? 0} libros del archivo. Esta operación no tiene deshacer automático; podrás recuperar los datos importando una copia previa.` : `Se añadirán hasta ${summary?.newBooks ?? 0} libros y se omitirán ${summary?.duplicates.length ?? 0} ya presentes. Tus libros actuales se conservarán.`}</AlertDialogDescription></AlertDialogHeader>
          {mode === "replace" && <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={replaceAcknowledged} onChange={(event) => setReplaceAcknowledged(event.target.checked)} className="mt-1" /><span>Entiendo que se reemplazará mi colección actual.</span></label>}
          <AlertDialogFooter><AlertDialogCancel>Volver a la revisión</AlertDialogCancel><AlertDialogAction disabled={busy || (mode === "replace" && !replaceAcknowledged)} onClick={() => void handleConfirm()}>{mode === "replace" ? "Sí, reemplazar biblioteca" : "Sí, fusionar biblioteca"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
