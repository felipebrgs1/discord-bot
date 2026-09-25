interface Env {
  ASSETS: Fetcher
  PRIVATE_API: Fetcher
  PANEL_PASSWORD: string
}

const cookieName = "botdiscord_session"
const sessionSeconds = 7 * 24 * 60 * 60

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return difference === 0
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("token inválido")
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
}

async function signingKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

async function createSession(password: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + sessionSeconds
  const payload = `${expires}.${encode(crypto.getRandomValues(new Uint8Array(16)))}`
  const signature = await crypto.subtle.sign("HMAC", await signingKey(password), new TextEncoder().encode(payload))
  return `${payload}.${encode(new Uint8Array(signature))}`
}

async function hasSession(request: Request, password: string): Promise<boolean> {
  if (!password) return false
  const value = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false
  const expiry = Number(parts[0])
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000 || expiry > Date.now() / 1000 + sessionSeconds) return false
  try {
    return await crypto.subtle.verify("HMAC", await signingKey(password), decode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    return false
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin")
  return !origin || origin === new URL(request.url).origin
}

async function login(request: Request, password: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Origem inválida" }, 403)
  let input: unknown
  try { input = await request.json() } catch { return json({ error: "Dados inválidos" }, 400) }
  const submitted = (input as { password?: unknown } | null)?.password
  if (typeof submitted !== "string" || !password || submitted.length > 1024) return json({ error: "Senha inválida" }, 401)
  const [candidate, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(submitted)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
  ])
  if (!bytesEqual(new Uint8Array(candidate), new Uint8Array(expected))) return json({ error: "Senha inválida" }, 401)
  const token = await createSession(password)
  return json({ authenticated: true }, 200, {
    "Set-Cookie": `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}`,
  })
}

async function proxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete("Authorization")
  headers.delete("Cookie")
  headers.delete("Host")
  const upstream = new Request(`http://127.0.0.1:8080${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.body,
    duplex: "half",
    redirect: "manual",
  } as RequestInit)
  try {
    const response = await env.PRIVATE_API.fetch(upstream)
    const result = new Response(response.body, response)
    result.headers.set("Cache-Control", "no-store")
    return result
  } catch {
    return json({ error: "API indisponível" }, 502)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/auth/login" && request.method === "POST") return login(request, env.PANEL_PASSWORD)
    if (path === "/auth/session" && request.method === "GET") {
      return json({ authenticated: await hasSession(request, env.PANEL_PASSWORD) })
    }
    if (path === "/auth/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Origem inválida" }, 403)
      return json({ authenticated: false }, 200, {
        "Set-Cookie": `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      })
    }
    if (path.startsWith("/auth/")) return json({ error: "Rota não encontrada" }, 404)

    if (path === "/api" || path.startsWith("/api/")) {
      if (!await hasSession(request, env.PANEL_PASSWORD)) return json({ error: "Sessão expirada" }, 401)
      if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
        return json({ error: "Origem inválida" }, 403)
      }
      return proxy(request, env)
    }

    const response = await env.ASSETS.fetch(request)
    const result = new Response(response.body, response)
    result.headers.set("X-Content-Type-Options", "nosniff")
    result.headers.set("X-Frame-Options", "DENY")
    result.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
    return result
  },
}
