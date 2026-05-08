import {
  assertOrderAccess,
  ensureSchema,
  findOrderByClaim,
  HttpError,
  jsonResponse,
  reconcileOrderPayment,
} from '../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (request.method !== 'GET') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    await ensureSchema(env)

    const url = new URL(request.url)
    const orderId = url.searchParams.get('order') ?? ''
    const claimToken = url.searchParams.get('claim') ?? ''
    const guestToken = url.searchParams.get('guest_token') ?? url.searchParams.get('guest') ?? ''

    if (!orderId && !claimToken) {
      throw new HttpError(400, 'Order or claim token is required.')
    }

    let order = null
    if (claimToken) {
      order = await findOrderByClaim(env, claimToken)
    }
    if (!order && orderId) {
      if (!/^[a-f0-9]{32}$/.test(orderId)) throw new HttpError(400, 'Valid order ID is required.')
      order = await env.DB.prepare(
        `SELECT * FROM mf_orders WHERE id = ?`,
      )
        .bind(orderId)
        .first()
    }

    if (!order) {
      return jsonResponse({ order: null, instance: null })
    }

    await assertOrderAccess({ env, request, order, claimToken, guestToken })

    const result = await reconcileOrderPayment(env, order)
    return jsonResponse({ order: result.order, instance: result.instance ?? null })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Could not load console data.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
