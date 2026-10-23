/** ISBN-13 sintético válido con prefijo 979-0-0000 (sin correspondencia con libros reales), igual que el grupo catalogue. */
export function fakeIsbn(n) {
  const body = `97900009${String(n).padStart(4, "0")}`
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}
