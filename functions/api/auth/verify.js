function html() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MiroFish Sign In</title></head><body><p>Magic link sign-in is disabled.</p><p><a href="/auth/">Use email and password instead</a>.</p></body></html>'
}

export async function onRequest() {
  return new Response(html(), {
    status: 410,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
