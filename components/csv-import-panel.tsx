"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { beginCsvImportAction, discardCsvImportAction, getCsvIssueReportAction, inspectCsvAction, listCsvMappingProfilesAction, listCsvSessionsAction, prepareCsvImportAction, saveCsvMappingProfileAction, setCsvMappingAction } from "@/app/actions/csv-import"
import { confirmImportAction } from "@/app/actions/import-preview"
import { CSV_LIMITS, CSV_TARGET_FIELDS, type CsvDelimiter, type CsvDuplicatePolicy, type CsvImportPreview, type CsvMapping, type CsvMappingProfile, type CsvMappingReceipt, type CsvTargetField, type InspectedCsv } from "@/lib/csv-import/contracts"
import { csvSha256, DEFAULT_CSV_STATUS_EQUIVALENCES } from "@/lib/csv-import/mapping"
import type { ActionResult } from "@/lib/action-result"
import type { Book } from "@/lib/types"

const TARGET_LABELS: Record<CsvTargetField, string> = { title: "Título", authors: "Autores", isbn: "ISBN", publishers: "Editoriales", pages: "Páginas", publishDate: "Fecha de publicación", status: "Estado", shelf: "Estantería", ignore: "Ignorar" }
const STATUS_LABELS: Record<Book["status"], string> = { read: "Leído", reading: "Leyendo", unread: "Sin leer", "to-read": "Por leer" }
const control = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
type StateRule = { source: string; status: Book["status"] }
type OpenSession = Extract<Awaited<ReturnType<typeof listCsvSessionsAction>>, { ok: true }>["value"][number]

function value<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function defaultMapping(headers: string[], delimiter: CsvDelimiter): CsvMapping {
  return { delimiter, header: true, columns: headers.map((_, index) => ({ sourceColumn: `#${index + 1}`, target: "ignore" })), defaultStatus: "unread", defaultShelf: "Predeterminada" }
}
function downloadReport(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url; link.download = "incidencias-importacion.csv"; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function CsvImportPanel({ disabled, onCommitted, onJob }: { disabled?: boolean; onCommitted: () => void; onJob: (jobId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [delimiter, setDelimiter] = useState<CsvDelimiter>(",")
  const [session, setSession] = useState<InspectedCsv | null>(null)
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [states, setStates] = useState<StateRule[]>(DEFAULT_CSV_STATUS_EQUIVALENCES)
  const [receipt, setReceipt] = useState<CsvMappingReceipt | null>(null)
  const [preview, setPreview] = useState<CsvImportPreview | null>(null)
  const [mode, setMode] = useState<"merge" | "replace">("merge")
  const [duplicatePolicy, setDuplicatePolicy] = useState<CsvDuplicatePolicy>("skip-existing")
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [fileName, setFileName] = useState("")
  const [openSessions, setOpenSessions] = useState<OpenSession[]>([])
  const [profiles, setProfiles] = useState<CsvMappingProfile[]>([])
  const [profileName, setProfileName] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [finished, setFinished] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const idempotency = useRef("")
  const locked = busy || disabled
  const reload = async () => {
    const [sessions, saved] = await Promise.all([listCsvSessionsAction(), listCsvMappingProfilesAction()])
    if (sessions.ok) setOpenSessions(sessions.value)
    if (saved.ok) setProfiles(saved.value)
  }
  useEffect(() => {
    let active = true
    void Promise.all([listCsvSessionsAction(), listCsvMappingProfilesAction()]).then(([sessions, saved]) => {
      if (!active) return
      if (sessions.ok) setOpenSessions(sessions.value)
      if (saved.ok) setProfiles(saved.value)
    }).catch(() => { if (active) setError("No se pudieron recuperar los CSV pendientes o los perfiles guardados.") })
    return () => { active = false }
  }, [])

  const work = async (operation: () => Promise<void>) => {
    setBusy(true); setError("")
    try { await operation() } catch (caught) { setError(caught instanceof Error ? caught.message : "No se pudo completar la importación CSV. Conserva el archivo y vuelve a intentarlo.") }
    finally { setBusy(false) }
  }
  const invalidate = () => { setReceipt(null); setPreview(null); setFinished(false) }
  const open = (inspected: InspectedCsv, name: string) => {
    setSession(inspected); setFileName(name); setPreview(null); setReceipt(null); setFinished(false); setSkipInvalid(false)
    const rules = inspected.mapping ?? defaultMapping(inspected.headers, delimiter)
    setMapping(rules)
    setStates(rules.statusMap ? Object.entries(rules.statusMap).map(([source, status]) => ({ source, status })) : DEFAULT_CSV_STATUS_EQUIVALENCES.map((entry) => ({ ...entry })))
    setNotice(inspected.complete ? `CSV recibido: ${inspected.recordCount ?? "recuento pendiente"} registros. Elige el destino de cada columna; todavía no se ha importado ningún libro.` : "La subida está incompleta. Selecciona el mismo archivo para continuar; se conservan los trozos recibidos.")
  }
  const upload = (file: File) => work(async () => {
    if (file.size < 1 || file.size > CSV_LIMITS.maxBytes) throw new Error("Selecciona un CSV UTF-8 de hasta 8 MiB.")
    setPreview(null); setReceipt(null)
    const bytes = new Uint8Array(await file.arrayBuffer())
    let inspected = value(await beginCsvImportAction({ byteLength: bytes.length, sha256: await csvSha256(bytes), delimiter }))
    setSession(inspected); setFileName(file.name); setMapping(null)
    await reload()
    const total = Math.ceil(bytes.length / (256 * 1024))
    for (let ordinal = 0; ordinal < total; ordinal++) {
      setNotice(`Subiendo CSV: ${ordinal + 1} de ${total} trozos…`)
      const chunk = file.slice(ordinal * 256 * 1024, (ordinal + 1) * 256 * 1024)
      inspected = value(await inspectCsvAction({ sessionId: inspected.sessionId, chunk: { ordinal, total, sha256: await csvSha256(new Uint8Array(await chunk.arrayBuffer())), bytes: chunk } }))
    }
    open(inspected, file.name)
    await reload()
  })
  const saveMapping = () => work(async () => {
    if (!session || !mapping) return
    const keys = states.map((state) => state.source.trim().normalize("NFC").toLocaleLowerCase("es"))
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("La tabla de equivalencias tiene valores vacíos o repetidos.")
    const rules = { ...mapping, statusMap: Object.fromEntries(states.map((state) => [state.source, state.status])) }
    const result = value(await setCsvMappingAction({ sessionId: session.sessionId, expectedVersion: session.version, mappingVersion: (session.mappingVersion ?? 0) + 1, mapping: rules }))
    setMapping(rules); setReceipt(result); setPreview(null)
    setSession({ ...session, version: result.version, mapping: rules, mappingVersion: result.mappingVersion })
    setNotice(`Mapeo guardado: ${result.validRows} registros válidos de ${result.totalRows}. Las incidencias bloquean la importación salvo que elijas omitir filas con errores.`)
  })
  const prepare = () => work(async () => {
    if (!session || !receipt) return
    const result = value(await prepareCsvImportAction({ sessionId: session.sessionId, mode, duplicatePolicy: mode === "replace" ? "skip-existing" : duplicatePolicy, invalidRows: skipInvalid ? "skip-invalid" : "block" }))
    setPreview(result); setSession({ ...session, version: result.version }); idempotency.current = crypto.randomUUID()
    setNotice("Revisión CSV preparada. Comprueba las altas, omisiones y eliminaciones antes de confirmar.")
  })
  const confirm = () => work(async () => {
    if (!preview) return
    const result = value(await confirmImportAction({ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: idempotency.current }))
    setConfirmOpen(false); onJob(result.jobId)
    if (result.status === "committed") {
      const imported = result.result?.imported ?? 0
      setNotice(`CSV importado: ${imported} ${imported === 1 ? "ejemplar" : "ejemplares"}; ${result.result?.skipped ?? 0} filas omitidas por estar presentes.`)
      setFinished(true); setPreview(null); onCommitted(); await reload()
    } else setNotice("La importación CSV está en cola. Su progreso y resultado se conservan en el trabajo de importación.")
  })
  const cancel = (sessionId: string) => work(async () => {
    value(await discardCsvImportAction({ sessionId }))
    if (session?.sessionId === sessionId) { setSession(null); setMapping(null); setReceipt(null); setPreview(null) }
    setNotice("Sesión CSV descartada. Tu biblioteca no ha cambiado."); await reload()
  })
  const issues = receipt?.issues ?? session?.issues ?? []
  const issueCount = receipt?.issueCount ?? session?.issueCount ?? issues.length

  return <section aria-labelledby="csv-import-title" aria-busy={busy} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl space-y-5">
    <h2 id="csv-import-title" className="text-2xl font-bold">Importar CSV</h2>
    <p id="csv-limits" className="text-sm text-muted-foreground">CSV UTF-8 con cabecera, hasta 8 MiB y 2000 registros. Los saltos de línea dentro de comillas pertenecen al mismo registro. Elegir un archivo permite revisarlo; no añade libros.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm">Separador del archivo<select className={control} value={delimiter} disabled={locked} onChange={(event) => setDelimiter(event.target.value as CsvDelimiter)}><option value=",">Coma</option><option value=";">Punto y coma</option><option value={"\t"}>Tabulador</option></select></label>
      <input ref={fileInput} id="csv-file" type="file" accept=".csv,text/csv,text/tab-separated-values" aria-label="Archivo CSV de biblioteca" aria-describedby="csv-limits" className="sr-only" disabled={locked} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = "" }} />
      <Button variant="secondary" disabled={locked} onClick={() => fileInput.current?.click()}>Seleccionar archivo CSV</Button>
    </div>
    <p className="text-xs text-muted-foreground">El separador se aplica al seleccionar un archivo.</p>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <div role="alert" className="rounded-xl border border-destructive bg-destructive/10 p-3 text-sm"><p>{error}</p>{session && <Button variant="outline" className="mt-2" disabled={locked} onClick={() => void work(async () => open(value(await inspectCsvAction({ sessionId: session.sessionId })), fileName))}>Recuperar sesión CSV</Button>}</div>}
    {openSessions.length > 0 && <details className="text-sm"><summary className="cursor-pointer">CSV pendientes ({openSessions.length})</summary><ul className="space-y-2 mt-2">{openSessions.map((pending, index) => <li key={pending.sessionId} className="flex flex-wrap gap-2 items-center"><span>Sesión {index + 1}</span><Button variant="outline" disabled={locked} onClick={() => void work(async () => open(value(await inspectCsvAction({ sessionId: pending.sessionId })), "CSV pendiente"))}>Continuar CSV pendiente {index + 1}</Button><Button variant="outline" disabled={locked} onClick={() => void cancel(pending.sessionId)}>Descartar CSV pendiente {index + 1}</Button></li>)}</ul></details>}
    {session?.complete && mapping && !finished && <div className="space-y-5">
      <h3 className="font-semibold break-all">Mapeo: {fileName}</h3>
      {profiles.length > 0 && <label className="block text-sm">Usar perfil guardado<select className={control} disabled={locked} value="" onChange={(event) => { const profile = profiles.find((entry) => entry.id === event.target.value); if (profile) { setMapping(profile.mapping); setStates(Object.entries(profile.mapping.statusMap ?? {}).map(([source, status]) => ({ source, status }))); invalidate() } }}><option value="">Selecciona un perfil privado</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}
      <fieldset disabled={locked} className="space-y-3"><legend className="font-medium mb-2">Destino de las columnas</legend>
        {session.headers.map((header, index) => {
          const column = mapping.columns.find((entry) => entry.sourceColumn === `#${index + 1}` || entry.sourceColumn === header)
          return <div key={index} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-2">
            <label className="text-sm">Columna {index + 1}: {header}<select aria-label={`Destino de ${header || `columna ${index + 1}`}`} className={control} value={column?.target ?? "ignore"} onChange={(event) => { const columns = [...mapping.columns.filter((entry) => entry.sourceColumn !== `#${index + 1}` && entry.sourceColumn !== header), { sourceColumn: `#${index + 1}`, target: event.target.value as CsvTargetField }]; setMapping({ ...mapping, columns }); invalidate() }}>{CSV_TARGET_FIELDS.map((target) => <option key={target} value={target}>{TARGET_LABELS[target]}</option>)}</select></label>
            {(column?.target === "authors" || column?.target === "publishers") && <label className="text-sm">{column.target === "authors" ? "Separador de autores" : "Separador de editoriales"}<input className={control} value={column.separator ?? ""} maxLength={10} placeholder="Vacío: un solo nombre" onChange={(event) => { setMapping({ ...mapping, columns: mapping.columns.map((entry) => entry === column ? { ...entry, separator: event.target.value || undefined } : entry) }); invalidate() }} /></label>}
            <p className="text-xs text-muted-foreground break-all sm:col-span-2">Muestra: {session.sampleRows[0]?.cells[index] || "(vacía)"}</p>
          </div>
        })}
        <p className="text-sm text-muted-foreground">El título es obligatorio y el ISBN, opcional. «Apellido, Nombre» se conserva como un autor salvo que elijas expresamente un separador.</p>
        <label className="block text-sm">Estantería para celdas vacías<input className={control} value={mapping.defaultShelf ?? "Predeterminada"} maxLength={120} onChange={(event) => { setMapping({ ...mapping, defaultShelf: event.target.value }); invalidate() }} /></label>
        <label className="block text-sm">Estado para celdas vacías<select className={control} value={mapping.defaultStatus ?? "unread"} onChange={(event) => { setMapping({ ...mapping, defaultStatus: event.target.value as Book["status"] }); invalidate() }}>{Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
      </fieldset>
      <fieldset disabled={locked} className="space-y-2"><legend className="font-medium mb-2">Equivalencias de estado</legend><p className="text-sm text-muted-foreground">Un valor desconocido bloquea su fila. Añade una equivalencia o corrígelo; nunca se convierte automáticamente en «Leído».</p>
        {states.map((state, index) => <div key={index} className="flex flex-wrap gap-2"><label className="min-w-0 flex-1"><span className="sr-only">Valor de origen {index + 1}</span><input className={control} value={state.source} maxLength={200} onChange={(event) => { setStates(states.map((entry, position) => position === index ? { ...entry, source: event.target.value } : entry)); invalidate() }} /></label><label className="min-w-0 flex-1"><span className="sr-only">Estado de destino {index + 1}</span><select className={control} value={state.status} onChange={(event) => { setStates(states.map((entry, position) => position === index ? { ...entry, status: event.target.value as Book["status"] } : entry)); invalidate() }}>{Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label><Button variant="outline" aria-label={`Quitar equivalencia ${index + 1}`} onClick={() => { setStates(states.filter((_, position) => position !== index)); invalidate() }}>Quitar</Button></div>)}
        <Button variant="outline" disabled={states.length >= 100} onClick={() => { setStates([...states, { source: "", status: "unread" }]); invalidate() }}>Añadir equivalencia</Button>
      </fieldset>
      <Button disabled={locked} onClick={() => void saveMapping()}>Guardar mapeo CSV</Button>
      {issues.length > 0 && <div role="region" aria-label="Incidencias CSV" className="rounded-xl border border-destructive p-3 space-y-2"><p className="font-medium">Hay {issueCount} incidencias que revisar</p><ul className="max-h-64 overflow-auto text-sm space-y-2">{issues.slice(0, 100).map((issue, index) => <li key={index}>Registro {issue.record}, {issue.field}: <strong>{issue.code}</strong> — {issue.message}{issue.privateSample && <span className="block break-all text-muted-foreground">Muestra privada: {issue.privateSample}</span>}</li>)}</ul>{issueCount > 100 && <p className="text-sm">Se muestran las primeras 100 incidencias. El informe incluye todas.</p>}</div>}
      {!receipt && issues.length > 0 && <Button variant="outline" disabled={locked} onClick={() => void work(async () => downloadReport(value(await getCsvIssueReportAction({ sessionId: session.sessionId }))))}>Descargar informe CSV</Button>}
      {receipt && <div className="space-y-4">
        <Button variant="outline" disabled={locked} onClick={() => void work(async () => downloadReport(value(await getCsvIssueReportAction({ sessionId: session.sessionId }))))}>Descargar informe CSV</Button>
        <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Nombre del perfil privado<input className={control} value={profileName} maxLength={80} onChange={(event) => setProfileName(event.target.value)} /></label><Button variant="outline" disabled={locked || !profileName.trim()} onClick={() => void work(async () => { value(await saveCsvMappingProfileAction({ sessionId: session.sessionId, name: profileName })); setNotice("Perfil CSV guardado sin muestras de filas."); setProfileName(""); await reload() })}>Guardar perfil CSV</Button></div>
        <fieldset disabled={locked} className="space-y-3"><legend className="font-medium mb-2">Opciones de importación CSV</legend>
          <label className="block text-sm">Modo de importación CSV<select className={control} value={mode} onChange={(event) => { setMode(event.target.value as "merge" | "replace"); setPreview(null) }}><option value="merge">Fusionar con mi biblioteca</option><option value="replace">Reemplazar mi biblioteca</option></select></label>
          <label className="block text-sm">Libros ya existentes<select className={control} disabled={mode === "replace"} value={duplicatePolicy} onChange={(event) => { setDuplicatePolicy(event.target.value as CsvDuplicatePolicy); setPreview(null) }}><option value="skip-existing">Omitir existente</option><option value="another-copy">Añadir otra copia</option></select></label>
          <p className="text-sm text-muted-foreground">Otra copia conserva la edición que ya tienes y añade un ejemplar con su estado y estantería. No cambia los datos bibliográficos existentes.</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={skipInvalid} onChange={(event) => { setSkipInvalid(event.target.checked); setPreview(null) }} /><span>Importar solo las filas válidas y omitir las filas con errores</span></label>
        </fieldset>
        <Button disabled={locked} onClick={() => void prepare()}>Preparar revisión CSV</Button>
      </div>}
      {preview && <div role="region" aria-label="Revisión CSV" className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold">Revisión CSV</h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">{([["Ejemplares nuevos", preview.plan.counts.added], ["Existentes omitidos", preview.plan.counts.skipped], ["Libros que se eliminarán", preview.plan.counts.deleted], ["Filas con errores omitidas", preview.omittedRows.length]] as const).map(([label, count]) => <div key={label}><dt>{label}</dt><dd className="text-lg font-semibold">{count}</dd></div>)}</dl>
        {preview.omittedRows.length > 0 && <details open><summary>Registros omitidos por errores ({preview.omittedRows.length})</summary><ul className="text-sm max-h-48 overflow-auto">{preview.omittedRows.map((row) => <li key={row.sourceRowKey}>Registro {row.ordinal}: {row.codes.join(", ")}</li>)}</ul></details>}
        <p className="text-sm text-muted-foreground">La confirmación caduca a las {new Date(preview.expiresAt).toLocaleTimeString("es")}. Si tu biblioteca cambia o guardas otro mapeo, vuelve a revisar.</p>
        <Button disabled={locked} variant={mode === "replace" ? "destructive" : "default"} onClick={() => { setAcknowledged(false); setConfirmOpen(true) }}>Continuar y confirmar CSV</Button>
      </div>}
      <Button variant="outline" disabled={locked} onClick={() => void cancel(session.sessionId)}>Cancelar importación CSV</Button>
    </div>}
    {finished && session && <Button variant="outline" disabled={locked} onClick={() => void work(async () => downloadReport(value(await getCsvIssueReportAction({ sessionId: session.sessionId }))))}>Descargar informe CSV</Button>}
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Confirmar importación CSV</AlertDialogTitle><AlertDialogDescription>Se añadirán {preview?.plan.counts.added ?? 0} ejemplares, se omitirán {preview?.plan.counts.skipped ?? 0} existentes y {preview?.omittedRows.length ?? 0} registros con errores. {mode === "replace" ? `Se eliminarán ${preview?.plan.counts.deleted ?? 0} libros actuales y se guardará una versión anterior para poder recuperarlos.` : "Se conservará tu biblioteca actual."} Solo se aplicará si la revisión sigue vigente.</AlertDialogDescription></AlertDialogHeader>{mode === "replace" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>Entiendo que se reemplazará mi biblioteca con este CSV.</span></label>}<AlertDialogFooter><AlertDialogCancel>Volver al mapeo</AlertDialogCancel><AlertDialogAction disabled={locked || !preview || (mode === "replace" && !acknowledged)} onClick={() => void confirm()}>Sí, importar CSV</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
}
