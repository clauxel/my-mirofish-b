import {
  buildExpiredSessionCookie,
  getCookie,
  hashSecret,
  jsonResponse,
} from '../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method !== 'POST') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  if (env.DB) {
    const token = getCookie(request, 'mf_session')
    if (token) {
      const tokenHash = await hashSecret(token, env)
      await env.DB.prepare(`DELETE FROM mf_sessions WHERE token_hash = ?`).bind(tokenHash).run().catch(() => {})
    }
  }

  return jsonResponse({ message: 'Signed out.' }, 200, {
    'Set-Cookie': buildExpiredSessionCookie(request),
  })
}
