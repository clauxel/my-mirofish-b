(function () {
  var visitorStorageKey = 'mirofish-b-analytics-visitor-id'
  var sessionStorageKey = 'mirofish-b-analytics-session'
  var pendingEventsStorageKey = 'mirofish-b-analytics-pending-events'
  var endpoint = '/api/analytics/events'
  var maxQueuedEvents = 250
  var initialized = false
  var pendingEvents = []
  var currentPage = ''
  var currentSearch = ''
  var viewedSections = new Set()
  var scrollDepths = new Set()

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = Math.random() * 16 | 0
      var value = char === 'x' ? random : (random & 0x3 | 0x8)
      return value.toString(16)
    })
  }

  function sanitizeIdentifier(value, maxLength) {
    var normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_:/?.#-]+/g, '_')
      .replace(/^_+|_+$/g, '')

    return normalized ? normalized.slice(0, maxLength || 96) : null
  }

  function getVisitorId() {
    try {
      var existing = localStorage.getItem(visitorStorageKey)
      if (existing) return existing
      var id = uuid()
      localStorage.setItem(visitorStorageKey, id)
      return id
    } catch {
      return uuid()
    }
  }

  function getSessionState() {
    var now = Date.now()
    try {
      var existing = JSON.parse(sessionStorage.getItem(sessionStorageKey) || 'null')
      if (existing && existing.id && now - Number(existing.startedAt || 0) < 30 * 60 * 1000) {
        return existing
      }
    } catch {}

    var state = {
      id: uuid(),
      startedAt: now,
    }

    try {
      sessionStorage.setItem(sessionStorageKey, JSON.stringify(state))
    } catch {}

    return state
  }

  function getReferrerHost() {
    if (!document.referrer) return ''
    try {
      return new URL(document.referrer).hostname
    } catch {
      return ''
    }
  }

  function getDeviceType() {
    var width = window.innerWidth || 1024
    if (width < 768) return 'mobile'
    if (width < 1024) return 'tablet'
    return 'desktop'
  }

  function getUtm(name) {
    try {
      return new URLSearchParams(window.location.search).get(name) || ''
    } catch {
      return ''
    }
  }

  function persistPendingEvents() {
    try {
      localStorage.setItem(pendingEventsStorageKey, JSON.stringify(pendingEvents.slice(-maxQueuedEvents)))
    } catch {}
  }

  function loadPendingEvents() {
    try {
      var parsed = JSON.parse(localStorage.getItem(pendingEventsStorageKey) || '[]')
      if (Array.isArray(parsed)) pendingEvents = parsed.slice(-maxQueuedEvents)
    } catch {}
  }

  function buildBaseEvent(input) {
    var session = getSessionState()
    var path = window.location.pathname || '/'
    var search = window.location.search || ''

    return {
      id: uuid(),
      visitorId: getVisitorId(),
      sessionId: session.id,
      eventType: sanitizeIdentifier(input.eventType, 32) || 'unknown',
      eventName: sanitizeIdentifier(input.eventName, 64) || 'unknown_event',
      hostname: window.location.hostname || '',
      routePath: path + search,
      pageKey: sanitizeIdentifier(path === '/' ? 'home' : path, 96),
      sectionKey: sanitizeIdentifier(input.sectionKey, 64),
      elementKey: sanitizeIdentifier(input.elementKey, 96),
      referrerHost: getReferrerHost(),
      utmSource: getUtm('utm_source'),
      utmMedium: getUtm('utm_medium'),
      utmCampaign: getUtm('utm_campaign'),
      utmTerm: getUtm('utm_term'),
      utmContent: getUtm('utm_content'),
      deviceType: getDeviceType(),
      browserLanguage: navigator.language || '',
      metadata: input.metadata || {},
      occurredAt: new Date().toISOString(),
    }
  }

  function track(input) {
    pendingEvents = pendingEvents.concat(buildBaseEvent(input)).slice(-maxQueuedEvents)
    persistPendingEvents()
    window.setTimeout(function () {
      flush(false)
    }, 80)
  }

  function describeClick(target) {
    var element = target && target.closest
      ? target.closest('[data-analytics-click], a[href], button, input, textarea, select')
      : null

    if (!element || element.dataset.analyticsIgnore === 'true') return null

    var href = element.getAttribute('href') || ''
    var text = (element.getAttribute('aria-label') || element.textContent || element.name || element.id || '').trim()
    var explicitKey = sanitizeIdentifier(element.dataset.analyticsClick, 96)
    var elementKey = explicitKey || sanitizeIdentifier(text || href || element.tagName, 96)
    var section = element.closest('[data-analytics-section], section[id]')
    var isCta = element.dataset.analyticsCta === 'true' ||
      element.classList.contains('btn-primary') ||
      element.classList.contains('btn-start') ||
      element.classList.contains('btn-cta-primary') ||
      element.classList.contains('btn-cta-outline')

    return {
      eventName: isCta ? 'cta_click' : 'ui_click',
      elementKey: elementKey,
      sectionKey: sanitizeIdentifier(
        section ? (section.dataset.analyticsSection || section.id || section.getAttribute('aria-labelledby')) : '',
        64,
      ),
      metadata: {
        href: href,
        text: text.slice(0, 120),
        tag: element.tagName.toLowerCase(),
      },
    }
  }

  function handleClick(event) {
    var click = describeClick(event.target)
    if (!click) return
    track({
      eventType: 'click',
      eventName: click.eventName,
      elementKey: click.elementKey,
      sectionKey: click.sectionKey,
      metadata: click.metadata,
    })
  }

  function handleScrollDepth() {
    var scrollTop = window.scrollY || document.documentElement.scrollTop || 0
    var height = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    var depth = Math.min(100, Math.round((scrollTop / height) * 100))
    ;[25, 50, 75, 90].forEach(function (threshold) {
      if (depth >= threshold && !scrollDepths.has(threshold)) {
        scrollDepths.add(threshold)
        track({
          eventType: 'scroll',
          eventName: 'scroll_depth',
          metadata: { depth: threshold },
        })
      }
    })
  }

  function observeSections() {
    if (typeof IntersectionObserver !== 'function') return
    var sections = document.querySelectorAll('section[id], [data-analytics-section]')
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        var key = sanitizeIdentifier(entry.target.dataset.analyticsSection || entry.target.id, 64)
        if (!key || viewedSections.has(key)) return
        viewedSections.add(key)
        track({
          eventType: 'section',
          eventName: 'content_view',
          sectionKey: key,
        })
      })
    }, { threshold: 0.35 })

    sections.forEach(function (section) {
      observer.observe(section)
    })
  }

  function sendBatch(events, useBeacon) {
    var body = JSON.stringify({ events: events })
    if (useBeacon && navigator.sendBeacon) {
      return navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))
    }

    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: useBeacon,
    }).then(function (response) {
      return response.ok
    }).catch(function () {
      return false
    })
  }

  function flush(useBeacon) {
    if (!pendingEvents.length) return
    var events = pendingEvents.slice(0, maxQueuedEvents)
    var delivered = sendBatch(events, useBeacon)
    if (delivered === true) {
      pendingEvents = pendingEvents.slice(events.length)
      persistPendingEvents()
      return
    }

    Promise.resolve(delivered).then(function (ok) {
      if (ok) {
        pendingEvents = pendingEvents.slice(events.length)
        persistPendingEvents()
      }
    })
  }

  function syncPage() {
    var path = window.location.pathname || '/'
    var search = window.location.search || ''
    if (currentPage === path && currentSearch === search) return
    currentPage = path
    currentSearch = search
    viewedSections = new Set()
    scrollDepths = new Set()
    track({ eventType: 'page', eventName: 'page_view' })
    window.setTimeout(observeSections, 120)
  }

  function initialize() {
    if (initialized) return
    initialized = true
    loadPendingEvents()
    track({ eventType: 'session', eventName: 'session_started' })
    syncPage()
    document.addEventListener('click', handleClick, true)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true)
    })
    window.addEventListener('pagehide', function () { flush(true) })
    window.addEventListener('scroll', handleScrollDepth, { passive: true })
    window.addEventListener('popstate', syncPage)
    window.MiroFishAnalytics = {
      track: track,
      flush: flush,
      syncPage: syncPage,
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize)
  } else {
    initialize()
  }
})()
