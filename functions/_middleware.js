export async function onRequest(context) {
  const url = new URL(context.request.url)
  const method = context.request.method.toUpperCase()

  if (
    url.hostname === 'www.mirofish.best' &&
    !url.pathname.startsWith('/api/') &&
    (method === 'GET' || method === 'HEAD')
  ) {
    url.hostname = 'mirofish.best'
    return Response.redirect(url.toString(), 301)
  }

  return context.next()
}
