import {
  ensureSchema,
  jsonResponse,
  provisionPaidOrder,
} from '../../_shared/mirofish.js'

async function verifyCreemSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true
  if (!signatureHeader) return false

  const parts = {}
  for (const segment of String(signatureHeader).split(',')) {
    const idx = segment.indexOf('=')
    if (idx > 0) parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
  }

  const timestamp = parts.t
  const v1 = parts.v1
  if (!timestamp || !v1) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`))
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  if (expected.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i)
  }
  return diff === 0
}

function firstString(candidates) {
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }
  return ''
}

function getWebhookObject(payload) {
  return payload?.object ?? payload?.data ?? payload?.checkout ?? payload
}

function resolveOrderId(payload) {
  const obj = getWebhookObject(payload)
  return firstString([
    obj?.request_id,
    obj?.requestId,
    obj?.metadata?.orderId,
    obj?.metadata?.order_id,
    obj?.order?.request_id,
    payload?.metadata?.orderId,
    payload?.metadata?.order_id,
    payload?.request_id,
  ])
}

function resolveCheckoutId(payload) {
  const obj = getWebhookObject(payload)
  return firstString([obj?.id, obj?.checkout_id, obj?.checkoutId, payload?.checkout_id])
}

function resolveCustomer(payload) {
  const obj = getWebhookObject(payload)
  const customer = obj?.customer ?? obj?.order?.customer ?? {}
  return {
    email: firstString([customer?.email, obj?.customer_email, obj?.customerEmail, obj?.email]).toLowerCase(),
    id: firstString([customer?.id, obj?.customer_id, obj?.customerId, obj?.order?.customer_id]),
  }
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method !== 'POST') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  const rawBody = await request.text()
  const signatureHeader = request.headers.get('creem-signature') ?? ''
  const webhookSecret = env.CREEM_WEBHOOK_SECRET ?? ''

  const valid = await verifyCreemSignature(rawBody, signatureHeader, webhookSecret)
  if (!valid) {
    return jsonResponse({ message: 'Webhook signature invalid.' }, 401)
  }

  let payload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return jsonResponse({ message: 'Invalid JSON payload.' }, 400)
  }

  const eventType = String(payload?.eventType ?? payload?.event_type ?? payload?.type ?? '').toLowerCase()

  if (eventType === 'checkout.completed' && env.DB) {
    await ensureSchema(env)
    const orderId = resolveOrderId(payload)
    const checkoutId = resolveCheckoutId(payload)
    const customer = resolveCustomer(payload)

    if (orderId) {
      const order = await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`)
        .bind(orderId)
        .first()

      if (order) {
        await provisionPaidOrder(env, order, {
          checkoutId,
          customerEmail: customer.email,
          customerId: customer.id,
        })
      }
    }
  }

  return jsonResponse({ received: true })
}
