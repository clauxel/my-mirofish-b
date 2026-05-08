import {
  ensureSchema,
  getCurrentUser,
  getRuntimeToken,
  HttpError,
  isAdminEmail,
  jsonResponse,
  normalizeRuntimeBaseUrl,
  nowIso,
} from '../../../_shared/mirofish.js'

export async function onRequest(context) {
  const { request, env, params } = context

  if (request.method !== 'DELETE') return jsonResponse({ message: 'Method not allowed.' }, 405)

  try {
    if (!env.DB) throw new HttpError(503, 'Database not available.')
    await ensureSchema(env)

    const user = await getCurrentUser(request, env)
    if (!user) throw new HttpError(401, 'Authentication required.')
    if (!isAdminEmail(env, user.email)) throw new HttpError(403, 'Admin access required.')

    const orderId = params.orderId
    const order = await env.DB.prepare(`SELECT * FROM mf_orders WHERE id = ?`).bind(orderId).first()
    if (!order) throw new HttpError(404, 'Order not found.')
    if (order.user_id !== user.id) throw new HttpError(403, 'You can only delete your own instances.')

    const instance = await env.DB.prepare(
      `SELECT * FROM mf_instances WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(orderId).first()
    if (!instance) throw new HttpError(404, 'No instance found for this order.')
    if (instance.status === 'stopped') throw new HttpError(409, 'Instance is already stopped.')

    await env.DB.prepare(
      `UPDATE mf_instances SET status = 'stopped', error_message = 'Deleted by admin.', updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), instance.id).run()

    const runtimeUrl = normalizeRuntimeBaseUrl(env)
    const runtimeToken = getRuntimeToken(env)
    if (runtimeUrl && runtimeToken) {
      await fetch(`${runtimeUrl}/instances/${instance.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${runtimeToken}` },
      }).catch(() => {})
    }

    return jsonResponse({ message: 'Instance deleted.' })
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Could not delete instance.' },
      error instanceof HttpError ? error.statusCode : 500,
    )
  }
}
