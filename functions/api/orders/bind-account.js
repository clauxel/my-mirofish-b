import {
  assertOrderAccess,
  bindGuestOrdersToUser,
  ensureSchema,
  getCurrentUser,
  getGuestId,
  HttpError,
  jsonResponse,
} from '../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method !== 'POST') return jsonResponse({ message: 'Method not allowed.' }, 405)

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    await ensureSchema(env)

    const user = await getCurrentUser(request, env)
    if (!user) throw new HttpError(401, 'Sign in required.')

    const body = await request.json().catch(() => {
      throw new HttpError(400, 'Request body must be valid JSON.')
    })
    const orderId = String(body.orderId ?? '').trim()
    if (!/^[a-f0-9]{32}$/.test(orderId)) throw new HttpError(400, 'Valid order ID is required.')

    const guestToken = String(body.guestToken || getGuestId(request) || '').trim()
    const order = await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`).bind(orderId).first()
    if (!order) throw new HttpError(404, 'Order not found.')
    if (!order.guest_id) {
      return jsonResponse({ message: 'This order is already attached to an account.', order })
    }

    await assertOrderAccess({ env, request, order, guestToken })
    const boundOrders = await bindGuestOrdersToUser(env, { guestToken: order.guest_id, userId: user.id })
    const updatedOrder = await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`).bind(orderId).first()

    return jsonResponse({
      message: boundOrders > 0 ? 'Guest workspace attached to your account.' : 'Workspace is already attached.',
      order: updatedOrder,
      boundOrders,
    })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Could not bind guest workspace.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
