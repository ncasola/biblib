export const PROXY_SESSION_TIMEOUT_MS = 6_000

interface SessionClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null }; error: { name: string } | null }>
    getSession(): Promise<{ data: { session: { access_token: string } | null } }>
  }
}

type ProxySession =
  | { authenticated: true; userId: string; accessToken: string | null; sessionError: false }
  | { authenticated: false; sessionError: boolean }

/** Un solo plazo para validación y posible renovación, incluido el reintento interno de Supabase. */
export async function readProxySession(
  createClient: (signal: AbortSignal) => SessionClient,
  timeoutMs = PROXY_SESSION_TIMEOUT_MS,
): Promise<ProxySession> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error("No se pudo comprobar la sesión a tiempo."))
      }, timeoutMs)
    })
    const read = async (): Promise<ProxySession> => {
      const client = createClient(controller.signal)
      const { data: { user }, error } = await client.auth.getUser()
      if (error || !user) return { authenticated: false, sessionError: Boolean(error && error.name !== "AuthSessionMissingError") }
      const { data: { session } } = await client.auth.getSession()
      return { authenticated: true, userId: user.id, accessToken: session?.access_token ?? null, sessionError: false }
    }
    return await Promise.race([read(), deadline])
  } catch {
    return { authenticated: false, sessionError: true }
  } finally {
    clearTimeout(timer)
    // También invalida callbacks tardíos de un cliente que no haya atendido la cancelación.
    controller.abort()
  }
}
