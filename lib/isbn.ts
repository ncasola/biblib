/** Valida ISBN-10/13 y devuelve su identificador canónico ISBN-13. */
export function normalizeIsbn(value: string): string | null {
  const isbn = value.replace(/[\s-]/g, "").toUpperCase()
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0)
    if (sum % 11 !== 0) return null
    const prefix = `978${isbn.slice(0, 9)}`
    const checksum = (10 - [...prefix].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10
    return `${prefix}${checksum}`
  }
  if (!/^97[89]\d{10}$/.test(isbn)) return null
  return [...isbn].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0 ? isbn : null
}

export function normalizedBookIdentifier(value: string): string {
  return normalizeIsbn(value) ?? value.trim()
}
