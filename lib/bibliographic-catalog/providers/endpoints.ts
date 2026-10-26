// Únicos nombres de host de Open Library y BNE fuera del código de red de los adaptadores. Todo lo demás
// (cuota, derechos, normalización, procedencia) los importa de aquí; la prueba estática de U-BIB-05 falla
// si `openlibrary.org` o `catalogo.bne.es` aparecen en otro sitio del código fuente.

export const OPEN_LIBRARY_HOST = "openlibrary.org"
export const OPEN_LIBRARY_COVERS_HOST = `covers.${OPEN_LIBRARY_HOST}`
export const OPEN_LIBRARY_LICENSING_URL = `https://${OPEN_LIBRARY_HOST}/developers/licensing`

/** Dominio de BNE que cubre la cuota; el catálogo SRU y las fichas viven en un subdominio. */
export const BNE_DOMAIN = "bne.es"
export const BNE_CATALOGUE_HOST = `catalogo.${BNE_DOMAIN}`
export const BNE_LEGAL_NOTICE_URL = `https://www.${BNE_DOMAIN}/es/aviso-legal`

/** Ficha pública de un registro BNE (atribución; no es un endpoint de consulta). */
export function bneRecordUrl(recordId: string): string {
  return `https://${BNE_CATALOGUE_HOST}/discovery/fulldisplay?docid=alma${encodeURIComponent(recordId)}&context=L&vid=34BNE_INST:CATALOGO`
}

/** Las respuestas de Open Library todavía traen `http://`: las URL de fuente y de portada se guardan en HTTPS. */
export function upgradeOpenLibraryUrl(value: string | undefined): string | undefined {
  return value?.replace(`http://${OPEN_LIBRARY_COVERS_HOST}/`, `https://${OPEN_LIBRARY_COVERS_HOST}/`).replace(`http://${OPEN_LIBRARY_HOST}/`, `https://${OPEN_LIBRARY_HOST}/`)
}
