import {
  ensureSchema,
  getCurrentUser,
  getGuestId,
  HttpError,
  jsonResponse,
} from '../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method !== 'GET') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    await ensureSchema(env)

    const user = await getCurrentUser(request, env)
    const guestToken = getGuestId(request)
    const userId = user?.id || ''

    if (!userId && !guestToken) throw new HttpError(401, 'Sign in required.')

    const orders = await env.DB.prepare(
      `SELECT
          o.id,
          o.order_number,
          o.plan_id,
          o.amount_cents,
          o.currency,
          o.payment_status,
          o.customer_email,
          o.guest_id,
          o.user_id,
          o.created_at,
          o.paid_at,
          o.updated_at,
          i.id AS instance_id,
          i.status AS instance_status,
          i.console_url,
          i.error_message,
          i.updated_at AS instance_updated_at
       FROM mf_orders o
       LEFT JOIN mf_instances i ON i.order_id = o.id
       WHERE
         (? != '' AND o.user_id = ?)
         OR (? != '' AND o.guest_id = ? AND (o.user_id IS NULL OR o.user_id = ''))
       ORDER BY o.created_at DESC`,
    )
      .bind(userId, userId, guestToken, guestToken)
      .all()

    const normalizedOrders = (orders.results ?? []).map((order) => ({
      ...order,
      bound_to_account: Boolean(user && order.user_id === user.id),
      can_bind: Boolean(user && guestToken && order.guest_id === guestToken && order.user_id !== user.id),
    }))

    return jsonResponse({ user, guest: !user && Boolean(guestToken), orders: normalizedOrders })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Could not load dashboard.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
