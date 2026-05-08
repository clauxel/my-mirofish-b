import {
  buildGuestCookie,
  ensureSchema,
  getCheckoutId,
  getCheckoutUrl,
  getCurrentUser,
  getGuestId,
  getOrCreateGuestId,
  getRequestOrigin,
  HttpError,
  isAdminEmail,
  jsonResponse,
  requestJson,
} from '../_shared/mirofish.js'

const annualDiscountMultiplier = 0.5

const planCatalog = {
  starter: { id: 'starter', name: 'Starter', currency: 'USD', monthlyAmountCents: 900, mode: 'checkout' },
  pro: { id: 'pro', name: 'Pro', currency: 'USD', monthlyAmountCents: 2900, annualDiscountMultiplier, mode: 'checkout' },
  enterprise: { id: 'enterprise', name: 'Enterprise', currency: 'USD', monthlyAmountCents: 5900, mode: 'checkout' },
}

function formatMoney(amountCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
  }).format(amountCents / 100)
}

function normalizeKey(value) {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function getDefaultSuccessUrl(request, env) {
  const configured = String(env.CREEM_DEFAULT_SUCCESS_URL ?? '').trim()
  if (configured) return configured
  return `${getRequestOrigin(request, env)}/`
}

function buildCheckoutSuccessUrl({ request, env, order, planSelection }) {
  const origin = getRequestOrigin(request, env)
  const successUrl = new URL(`${origin}/checkout`)
  successUrl.searchParams.set('checkout', 'success')
  successUrl.searchParams.set('order', order.id)
  if (order.guestToken) successUrl.searchParams.set('guest_token', order.guestToken)
  successUrl.searchParams.set('plan', planSelection.selectionId)
  successUrl.searchParams.set('provider', 'creem')
  return successUrl
}

function resolvePlanSelection(planSelectionId) {
  const [rawPlanId, rawBillingCycle] = String(planSelectionId || 'pro:annual').trim().split(':')
  const plan = planCatalog[rawPlanId]
  if (!plan) throw new HttpError(400, 'Unknown plan selection.')
  if (plan.mode === 'contact') throw new HttpError(400, 'This plan is not available for hosted checkout.')

  const billingCycle = rawBillingCycle === 'monthly' ? 'monthly' : 'annual'
  if (plan.mode === 'free') {
    return { plan, planId: plan.id, billingCycle, selectionId: plan.id, amountCents: 0, amountLabel: '$0', currency: plan.currency }
  }

  const amountCents =
    billingCycle === 'annual'
      ? Math.round(plan.monthlyAmountCents * 12 * (plan.annualDiscountMultiplier || 1))
      : plan.monthlyAmountCents

  return {
    plan,
    planId: plan.id,
    billingCycle,
    selectionId: `${plan.id}:${billingCycle}`,
    amountCents,
    amountLabel: formatMoney(amountCents, plan.currency),
    currency: plan.currency,
  }
}

function getConfiguredCreemProductId(planSelection, env) {
  const keys = [
    `CREEM_PRODUCT_ID_MIROFISH_${normalizeKey(planSelection.selectionId)}`,
    `CREEM_PRODUCT_ID_MIROFISH_${normalizeKey(planSelection.planId)}`,
    `CREEM_PRODUCT_ID_${normalizeKey(planSelection.selectionId)}`,
    `CREEM_PRODUCT_ID_${normalizeKey(planSelection.planId)}`,
    'CREEM_PRODUCT_ID',
  ]
  for (const key of keys) {
    const value = String(env[key] ?? '').trim()
    if (value) return value
  }
  return null
}

async function resolveSecretValue(value) {
  if (value && typeof value.get === 'function') return String(await value.get()).trim()
  return String(value ?? '').trim()
}

async function getCreemSettings(env) {
  const mode = String(env.CREEM_ENV ?? env.CREEM_MODE ?? '').trim().toLowerCase()
  const testApiKey = await resolveSecretValue(env.API_TEST_KEY ?? env.CREEM_TEST_KEY)
  const liveApiKey = await resolveSecretValue(env.API_PROD_KEY ?? env.CREEM_API_KEY ?? env.CREEM_KEY)
  const isTestMode =
    mode === 'test' ? true : mode === 'live' || mode === 'production' ? false : Boolean(testApiKey)
  const apiKey = isTestMode ? testApiKey : liveApiKey || testApiKey
  const baseUrl = env.CREEM_BASE_URL ?? (isTestMode ? 'https://test-api.creem.io' : 'https://api.creem.io')
  return { apiKey, baseUrl, isTestMode }
}

async function createCreemCheckout({ order, planSelection, source, request, env, user }) {
  const { apiKey, baseUrl } = await getCreemSettings(env)
  if (!apiKey) throw new HttpError(503, 'Creem payment is not configured on this deployment.')

  const headers = { 'x-api-key': apiKey }
  let productId = getConfiguredCreemProductId(planSelection, env)

  if (!productId) {
    const product = await requestJson(`${baseUrl}/v1/products`, {
      method: 'POST',
      headers,
      body: {
        name: `MiroFish ${planSelection.plan.name} ${planSelection.billingCycle === 'annual' ? 'Annual' : 'Monthly'}`,
        description: `${planSelection.plan.name} plan for MiroFish hosted prediction workflows`,
        price: order.amountCents,
        currency: order.currency,
        billing_type: 'onetime',
        tax_mode: 'inclusive',
        tax_category: 'saas',
        default_success_url: getDefaultSuccessUrl(request, env),
      },
    })
    productId = product.id
    if (!productId) throw new HttpError(502, 'Creem product did not return an id.')
  }

  const successUrl = buildCheckoutSuccessUrl({ request, env, order, planSelection })
  const checkout = await requestJson(`${baseUrl}/v1/checkouts`, {
    method: 'POST',
    headers,
    body: {
      product_id: productId,
      request_id: order.id,
      success_url: successUrl.toString(),
      customer: user?.email ? { email: user.email } : undefined,
      metadata: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        planId: planSelection.selectionId,
        source: source || 'site',
      },
    },
  })

  const checkoutUrl = getCheckoutUrl(checkout)
  if (!checkoutUrl) throw new HttpError(502, 'Creem checkout did not return a hosted checkout URL.')

  return { checkoutUrl, creemCheckoutId: getCheckoutId(checkout), paymentProvider: 'creem' }
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ message: 'Method not allowed.' }, 405)
  }

  try {
    if (!env.DB) {
      throw new HttpError(503, 'Database not available.')
    }
    await ensureSchema(env)

    const body = await request.json().catch(() => {
      throw new HttpError(400, 'Request body must be valid JSON.')
    })
    const planSelection = resolvePlanSelection(body.planId)
    const user = await getCurrentUser(request, env)
    const existingGuestId = getGuestId(request)
    const guestId = user ? null : getOrCreateGuestId(request)

    const orderId = crypto.randomUUID().replace(/-/g, '')
    const adminOverride = isAdminEmail(env, user?.email)
    const finalAmountCents = adminOverride ? 100 : planSelection.amountCents
    const finalAmountLabel = adminOverride ? '$1' : planSelection.amountLabel
    const order = {
      id: orderId,
      orderNumber: `MF-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 6).toUpperCase()}`,
      amountCents: finalAmountCents,
      amountLabel: finalAmountLabel,
      currency: planSelection.currency,
      guestToken: guestId,
    }

    const checkout = await createCreemCheckout({ order, planSelection, source: String(body.source ?? ''), request, env, user })

    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT OR IGNORE INTO mf_orders (
        id, order_number, user_id, guest_id, plan_id, amount_cents, currency, creem_checkout_id,
        payment_status, customer_email, claim_token_hash, claim_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
      .bind(
        order.id,
        order.orderNumber,
        user?.id ?? null,
        guestId,
        planSelection.selectionId,
        order.amountCents,
        order.currency,
        checkout.creemCheckoutId ?? null,
        user?.email ?? null,
        null,
        null,
        now,
        now,
      )
      .run()

    const headers = {}
    if (guestId && !existingGuestId) {
      headers['Set-Cookie'] = buildGuestCookie(guestId, request)
    }

    return jsonResponse({
      message: 'Checkout is ready.',
      orderId: order.id,
      guestToken: guestId || '',
      consolePath: guestId
        ? `/console?order=${encodeURIComponent(order.id)}&guest_token=${encodeURIComponent(guestId)}`
        : `/console?order=${encodeURIComponent(order.id)}`,
      orderNumber: order.orderNumber,
      planId: planSelection.selectionId,
      amountCents: order.amountCents,
      amountLabel: order.amountLabel,
      currency: order.currency,
      checkoutUrl: checkout.checkoutUrl,
      paymentProvider: checkout.paymentProvider || 'creem',
      creemCheckoutId: checkout.creemCheckoutId ?? null,
    }, 200, headers)
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Checkout could not be started.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
