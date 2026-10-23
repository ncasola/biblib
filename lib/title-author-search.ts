import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { mutationResult } from "./action-result"
import { DomainError } from "./domain-errors"
import { normalizeIsbn } from "./isbn"
import { normalizeCandidate } from "./bibliographic-catalog/normalize"
import type { BibliographicCandidate, BibliographicCatalogService, CatalogLookupResult, ProviderOutcome } from "./bibliographic-catalog/types"
import type { Book } from "./types"

export type SearchCandidate = BibliographicCandidate & { candidateKey: string }
export interface CandidatePage {
  queryToken: string
  results: SearchCandidate[]
  nextPage: number | null
  page: number
  providers: ProviderOutcome[]
  status: "found" | "notFound" | "rateLimited" | "unavailable" | "misconfigured"
}
export interface PreparedCandidate {
  reviewKey: string
  candidate: BibliographicCandidate
  isbn: string
  isbnVerified: false
  provisional: boolean
  targetCopyId?: string
  expectedVersion?: string
}

const text = (maximum: number) => z.string().max(maximum).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)).transform((value) => value.normalize("NFC").trim().replace(/\s+/g, " "))
const querySchema = z.object({ title: text(300).optional(), author: text(200).optional(), page: z.number().int().min(1), limit: z.union([z.literal(10), z.literal(20)]), language: z.string().regex(/^[a-z]{2,3}$/i).transform((value) => value.toLowerCase()).optional() }).strict()
const opaque = z.string().min(40).max(40000).regex(/^[A-Za-z0-9_-]+$/)
const editionsSchema = z.object({ queryToken: opaque, workKey: opaque, page: z.number().int().min(1) }).strict()
const prepareSchema = z.object({ candidateKey: opaque, targetCopyId: z.uuid().optional(), expectedVersion: z.uuid().optional() }).strict()
const envelopeSchema = z.object({ version: z.literal(1), kind: z.enum(["query", "candidate"]), expires: z.number(), queryId: z.uuid(), limit: z.union([z.literal(10), z.literal(20)]), candidate: z.unknown().optional() }).strict()
type Envelope = z.infer<typeof envelopeSchema>

function invalid(): never { throw new DomainError("INVALID_INPUT", "La consulta o la selección ha caducado o no es válida. Vuelve a buscar.") }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) invalid()
  return result.data
}

/** Tokens cifrados autenticados por dueño: sin texto/identidad en claro ni estado global entre cuentas. */
export function createSearchTokens(secret: string, owner: string, now: () => number = Date.now) {
  const key = createHash("sha256").update(JSON.stringify(["biblib-title-author-v1", secret, owner])).digest()
  const seal = (value: Envelope): string => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")
  }
  const open = (token: string, kind: Envelope["kind"]): Envelope => {
    parse(opaque, token)
    try {
      const buffer = Buffer.from(token, "base64url")
      const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12))
      decipher.setAuthTag(buffer.subarray(12, 28))
      const value = parse(envelopeSchema, JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8")))
      if (value.kind !== kind || value.expires <= now() || value.expires > now() + 16 * 60000) invalid()
      return value
    } catch { return invalid() }
  }
  return { seal, open }
}

interface Dependencies {
  catalog: BibliographicCatalogService
  authenticate: () => Promise<string>
  enabled: () => boolean
  secret: () => string | undefined
  maxPage?: number
  now?: () => number
  getTarget: (id: string) => Promise<Book | null>
}

/** Núcleo inyectable del contrato; las acciones Next solo aportan sesión, flag y dependencias servidor. */
export function createTitleAuthorActions(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const maxPage = deps.maxPage ?? 20
  async function context() {
    const owner = await deps.authenticate()
    if (!deps.enabled()) throw new DomainError("INVALID_INPUT", "La búsqueda por título y autor está desactivada.")
    const secret = deps.secret()
    if (!secret || secret.length < 32) throw new DomainError("PROVIDER_UNAVAILABLE", "La búsqueda bibliográfica no está configurada. Puedes completar la ficha manualmente.")
    if (!Number.isInteger(maxPage) || maxPage < 1 || maxPage > 100) throw new DomainError("INVALID_INPUT", "El límite de páginas bibliográficas no está configurado correctamente.")
    return { owner, tokens: createSearchTokens(secret, owner, now) }
  }
  const pageLimit = (page: number) => { if (page > maxPage) throw new DomainError("INVALID_INPUT", `La búsqueda admite hasta ${maxPage} páginas.`) }
  function pageResult(result: CatalogLookupResult<BibliographicCandidate>, page: number, envelope: Envelope, tokens: ReturnType<typeof createSearchTokens>): CandidatePage {
    const results = result.candidates.map((raw) => {
      // Una obra nunca publica ISBN como si perteneciera al ejemplar ni conserva evidencia inferida.
      const candidate = normalizeCandidate(raw)
      if (candidate.level === "work") candidate.isbns = []
      return { ...candidate, candidateKey: tokens.seal({ ...envelope, kind: "candidate", candidate }) }
    })
    const status = results.length ? "found" : result.status === "notFound" ? "notFound" : result.providers.some((entry) => entry.status === "rateLimited") ? "rateLimited" : result.providers.some((entry) => entry.status === "misconfigured") ? "misconfigured" : "unavailable"
    // Los proveedores no garantizan un total. Página llena permite consultar la siguiente sin inventarlo.
    const full = result.providers.some((entry) => result.candidates.filter((candidate) => candidate.provider === entry.provider).length >= envelope.limit)
    return { queryToken: tokens.seal({ ...envelope, kind: "query", candidate: undefined }), results, page, nextPage: full && page < maxPage ? page + 1 : null, providers: result.providers, status }
  }
  return {
    search: (input: unknown) => mutationResult(async () => {
      const { owner, tokens } = await context()
      const query = parse(querySchema, input)
      pageLimit(query.page)
      if ((`${query.title ?? ""}${query.author ?? ""}`.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) throw new DomainError("INVALID_INPUT", "Introduce al menos tres letras o números en el título o la autoría.")
      const result = await deps.catalog.searchTitleAuthor(query, { userId: owner })
      return pageResult(result, query.page, { version: 1, kind: "query", queryId: randomUUID(), limit: query.limit, expires: now() + 15 * 60000 }, tokens)
    }),
    editions: (input: unknown) => mutationResult(async () => {
      const { owner, tokens } = await context()
      const request = parse(editionsSchema, input)
      pageLimit(request.page)
      const query = tokens.open(request.queryToken, "query")
      const selected = tokens.open(request.workKey, "candidate")
      const candidate = normalizeCandidate(selected.candidate)
      if (query.queryId !== selected.queryId || candidate.level !== "work" || !candidate.recordId || !/^[A-Za-z0-9_-]{1,200}$/.test(candidate.recordId)) invalid()
      const result = await deps.catalog.resolveEditions({ provider: candidate.provider, recordKind: "work", recordId: candidate.recordId, page: request.page, limit: query.limit }, { userId: owner })
      return pageResult(result, request.page, query, tokens)
    }),
    prepare: (input: unknown) => mutationResult(async () => {
      const { tokens } = await context()
      const request = parse(prepareSchema, input)
      if (Boolean(request.targetCopyId) !== Boolean(request.expectedVersion)) invalid()
      const selected = tokens.open(request.candidateKey, "candidate")
      const candidate = normalizeCandidate(selected.candidate)
      if (candidate.provider === "google-books") throw new DomainError("INVALID_INPUT", "Los datos de Google Books solo están disponibles para consulta.")
      if (request.targetCopyId) {
        const target = await deps.getTarget(request.targetCopyId)
        if (!target) throw new DomainError("NOT_FOUND", "La ficha ya no está disponible.")
        if (target.version !== request.expectedVersion) throw new DomainError("CONFLICT", "La ficha ha cambiado. Vuelve a cargarla antes de enlazar.")
      }
      const isbns = candidate.level === "edition" ? [...new Set(candidate.isbns.map(normalizeIsbn).filter((isbn): isbn is string => Boolean(isbn)))] : []
      const provisional = isbns.length !== 1
      if (candidate.level === "work") candidate.isbns = []
      return { reviewKey: randomUUID(), candidate, isbn: provisional ? `manual-${randomUUID()}` : isbns[0], isbnVerified: false as const, provisional, ...(request.targetCopyId ? { targetCopyId: request.targetCopyId, expectedVersion: request.expectedVersion } : {}) } satisfies PreparedCandidate
    }),
  }
}
