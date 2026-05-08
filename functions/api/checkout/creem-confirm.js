import {
  confirmCreemCheckoutAndProvision,
  HttpError,
  jsonResponse,
} from '../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    const body = await request.json().catch(() => {
      throw new HttpError(400, 'Request body must be valid JSON.')
    })

    const redirectParams = body.redirectParams && typeof body.redirectParams === 'object'
      ? body.redirectParams
      : {}

    const { order, instance } = await confirmCreemCheckoutAndProvision({
      env,
      request,
      orderId: String(body.orderId ?? redirectParams.order ?? redirectParams.request_id ?? '').trim(),
      claimToken: String(body.claimToken ?? redirectParams.claim ?? '').trim(),
      guestToken: String(body.guestToken ?? redirectParams.guest_token ?? redirectParams.guest ?? '').trim(),
      checkoutId: String(body.checkoutId ?? redirectParams.checkout_id ?? redirectParams.checkoutId ?? '').trim(),
      redirectParams,
    })

    return jsonResponse({
      message: 'Payment confirmed. Your MiroFish workspace is being prepared.',
      order,
      instance,
    })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Payment could not be confirmed.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
