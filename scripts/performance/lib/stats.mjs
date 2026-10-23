// Estadísticos de las mediciones de U-QA-03. Percentil por interpolación lineal sobre la muestra
// ordenada (el método habitual de las hojas de cálculo, «tipo 7»): con pocas muestras p95 se acerca al máximo.

export function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

export const round = (value, digits = 1) => value === null || value === undefined || Number.isNaN(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits

/** Resumen de una lista de números (ms, filas, bytes…). Con lista vacía, solo `n: 0`. */
export function summarize(values, digits = 1) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0 }
  const sum = sorted.reduce((total, v) => total + v, 0)
  return {
    n: sorted.length,
    min: round(sorted[0], digits), p50: round(percentile(sorted, 50), digits), p95: round(percentile(sorted, 95), digits),
    p99: round(percentile(sorted, 99), digits), max: round(sorted.at(-1), digits), mean: round(sum / sorted.length, digits),
  }
}

export const median = (values) => percentile([...values].sort((a, b) => a - b), 50)
