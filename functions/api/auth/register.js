import {
  bindGuestOrdersToUser,
  buildSessionCookie,
  createSession,
  getGuestId,
  HttpError,
  jsonResponse,
  registerPasswordUser,
  serializeUser,
} from '../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method !== 'POST') return jsonResponse({ message: 'Method not allowed.' }, 405)

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    const body = await request.json().catch(() => {
      throw new HttpError(400, 'Request body must be valid JSON.')
    })

    const user = await registerPasswordUser(env, {
      name: body.name,
      email: body.email,
      password: body.password,
    })
    const sessionToken = await createSession(env, user.id)
    const guestToken = getGuestId(request)
    const boundOrders = guestToken ? await bindGuestOrdersToUser(env, { guestToken, userId: user.id }) : 0

    return jsonResponse({
      message: boundOrders > 0
        ? 'Account created and guest workspace ownership was attached.'
        : 'Account created. Secure session is active.',
      user: serializeUser(user, env),
      boundOrders,
    }, 201, {
      'Set-Cookie': buildSessionCookie(sessionToken, request),
    })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Could not create account.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
