import { jsonResponse } from '../../_shared/mirofish.js'

export async function onRequest() {
  return jsonResponse({
    message: 'Magic link sign-in is disabled. Use /api/auth/login or /api/auth/register.',
  }, 410)
}
