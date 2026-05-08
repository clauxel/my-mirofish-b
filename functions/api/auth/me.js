import {
  ensureSchema,
  getCurrentUser,
  jsonResponse,
  serializeUser,
} from '../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method !== 'GET') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  if (!env.DB) {
    return jsonResponse({ user: null })
  }

  await ensureSchema(env)
  const user = await getCurrentUser(request, env)
  return jsonResponse({ user: serializeUser(user) })
}
