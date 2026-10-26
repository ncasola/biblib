/** El cambio de referencia es el único punto de publicación. Una limpieza fallida se reintenta con la purga. */
export async function replaceAvatar<T>(steps: {
  prepare: () => Promise<string>
  publish: (assetId: string) => Promise<{ previousId: string | null; value: T }>
  discard: (assetId: string) => Promise<unknown>
}): Promise<T> {
  const assetId = await steps.prepare()
  let published: { previousId: string | null; value: T }
  try { published = await steps.publish(assetId) }
  catch (error) { await steps.discard(assetId).catch(() => undefined); throw error }
  if (published.previousId && published.previousId !== assetId) await steps.discard(published.previousId).catch(() => undefined)
  return published.value
}
