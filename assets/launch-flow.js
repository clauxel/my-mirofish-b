(function () {
  const defaultPlanId = 'pro'
  const defaultBillingCycle = 'annual'
  const annualDiscountMultiplier = 0.5
  const currency = 'USD'
  const completedOrderIds = new Set()

  const planCatalog = {
    starter: {
      id: 'starter',
      name: 'Starter',
      monthlyAmountCents: 900,
      subtitle: 'Lightweight exploration',
      custom: false,
      launchMode: 'checkout',
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      monthlyAmountCents: 2900,
      subtitle: 'Hosted checkout for regular teams',
      custom: false,
      launchMode: 'checkout',
      annualDiscountMultiplier,
    },
    enterprise: {
      id: 'enterprise',
      name: 'Enterprise',
      monthlyAmountCents: 5900,
      custom: false,
      subtitle: 'High-scale teams and dedicated support',
      launchMode: 'checkout',
    },
  }

  const state = {
    selectedPlanId: defaultPlanId,
    billingCycle: defaultBillingCycle,
    step: 'plans',
    source: 'hero_cta',
    modalOpen: false,
    popup: null,
    popupMonitor: null,
    checkoutUrl: '',
    legacyUrl: '',
    orderId: '',
    guestToken: '',
    paymentStatus: 'idle',
    paymentMessage: '',
    requestInFlight: false,
  }

  const elements = {}

  function formatMoney(amountCents) {
    const hasDecimals = amountCents % 100 !== 0
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: hasDecimals ? 2 : 0,
    }).format(amountCents / 100)
  }

  function getPlan(planId) {
    return planCatalog[planId] || planCatalog[defaultPlanId]
  }

  function getPricing(planId, billingCycle) {
    const plan = getPlan(planId)
    if (plan.custom) {
      return {
        plan,
        planId: plan.id,
        billingCycle,
        selectionId: plan.id,
        custom: true,
        free: false,
        paid: false,
        displayAmount: 'Custom',
        displayPeriod: '',
        sectionNote: 'Custom deployment terms are shown during checkout.',
        selectionNote: 'Continue to the MiroFish checkout page to review this plan.',
        paymentBilling: 'Custom annual contract',
        discountLabel: 'Custom pricing',
      }
    }

    const monthlyAmountCents = plan.monthlyAmountCents
    const isAnnual = billingCycle === 'annual'
    const annualAmountCents = Math.round(monthlyAmountCents * 12 * (plan.annualDiscountMultiplier || 1))
    const annualMonthlyEquivalentCents = Math.round(annualAmountCents / 12)
    const displayAmountCents = isAnnual && monthlyAmountCents > 0 ? annualMonthlyEquivalentCents : monthlyAmountCents
    const displayAmount = formatMoney(displayAmountCents)
    const displayPeriod = isAnnual && monthlyAmountCents > 0 ? '/ mo billed yearly' : '/ month'
    const savingsPercent =
      plan.annualDiscountMultiplier && plan.annualDiscountMultiplier < 1
        ? Math.round((1 - plan.annualDiscountMultiplier) * 100)
        : 0

    if (monthlyAmountCents === 0) {
      return {
        plan,
        planId: plan.id,
        billingCycle,
        selectionId: plan.id,
        custom: false,
        free: true,
        paid: false,
        amountCents: 0,
        displayAmount,
        displayPeriod: '/ month',
        sectionNote: 'No charge is due for this plan.',
        selectionNote: 'Continue to the MiroFish checkout page to confirm this plan.',
        paymentBilling: 'No payment required',
        discountLabel: 'No payment required',
      }
    }

    const monthlyChargeLabel = `${formatMoney(monthlyAmountCents)} charged monthly`
    const annualChargeLabel = `${formatMoney(annualAmountCents)} charged yearly`
    const annualSectionNote =
      savingsPercent > 0
        ? `${annualChargeLabel}. Save ${savingsPercent}% on every annual renewal.`
        : `${annualChargeLabel}. Billed once per year.`
    const monthlySectionNote =
      savingsPercent > 0
        ? `${monthlyChargeLabel}. Switch to yearly and save ${savingsPercent}%.`
        : `${monthlyChargeLabel}. You can switch billing anytime.`
    const annualSelectionNote = `${annualChargeLabel}. Equivalent to ${formatMoney(annualMonthlyEquivalentCents)} per month.`
    const monthlySelectionNote =
      savingsPercent > 0
        ? `${monthlyChargeLabel}. Upgrade to yearly any time for ${savingsPercent}% savings.`
        : `${monthlyChargeLabel}. Continue to the MiroFish checkout page.`
    return {
      plan,
      planId: plan.id,
      billingCycle,
      selectionId: `${plan.id}:${billingCycle}`,
      custom: false,
      free: false,
      paid: true,
      amountCents: isAnnual ? annualAmountCents : monthlyAmountCents,
      displayAmount,
      displayPeriod,
      sectionNote: isAnnual ? annualSectionNote : monthlySectionNote,
      selectionNote: isAnnual ? annualSelectionNote : monthlySelectionNote,
      paymentBilling: isAnnual ? annualChargeLabel : monthlyChargeLabel,
      discountLabel: isAnnual && savingsPercent > 0 ? `${savingsPercent}% off yearly pricing` : isAnnual ? 'Annual billing' : 'Monthly billing',
    }
  }

  function getContinueLabel(pricing) {
    return 'Continue to Payment'
  }

  function getSelectionTitle(pricing) {
    if (pricing.custom) return 'Enterprise'
    return `${pricing.plan.name} · ${pricing.billingCycle === 'annual' ? 'Yearly' : 'Monthly'}`
  }

  function getPaymentProviderLabel() {
    switch (state.paymentStatus) {
      case 'fallback':
        return 'Legacy hosted payment popup'
      case 'ready':
      case 'blocked':
      case 'closed':
      case 'loading':
      case 'error':
      default:
        return 'Secure hosted payment popup'
    }
  }

  function safeTrack(eventName, metadata) {
    if (!window.MiroFishAnalytics || typeof window.MiroFishAnalytics.track !== 'function') {
      return
    }

    const eventType =
      eventName === 'plan_selected'
        ? 'plan'
        : eventName === 'checkout_started' ||
            eventName === 'checkout_redirected' ||
            eventName === 'checkout_start_failed' ||
            eventName === 'payment_completed'
          ? 'checkout'
          : 'click'

    try {
      window.MiroFishAnalytics.track({
        eventType,
        eventName,
        sectionKey: 'pricing',
        elementKey: metadata && metadata.elementKey ? metadata.elementKey : eventName,
        metadata: metadata || {},
      })
    } catch {}
  }

  function setStep(step) {
    state.step = step
    elements.steps.forEach(function (stepElement) {
      const isActive = stepElement.getAttribute('data-launch-step') === step
      stepElement.hidden = !isActive
    })
  }

  function showModal() {
    if (!elements.overlay) return
    state.modalOpen = true
    document.body.classList.add('launch-modal-open')
    elements.overlay.hidden = false
  }

  function clearPopupMonitor() {
    if (state.popupMonitor) {
      window.clearInterval(state.popupMonitor)
      state.popupMonitor = null
    }
  }

  function closeModal() {
    if (!elements.overlay) return
    state.modalOpen = false
    document.body.classList.remove('launch-modal-open')
    elements.overlay.hidden = true
    clearPopupMonitor()
    if (state.paymentStatus !== 'success') {
      state.paymentStatus = 'idle'
      state.paymentMessage = ''
      state.checkoutUrl = ''
      state.legacyUrl = ''
      state.orderId = ''
      state.guestToken = ''
      state.requestInFlight = false
    }
    setStep('plans')
    render()
  }

  function openPricingModal(options) {
    state.selectedPlanId = options.planId || defaultPlanId
    state.billingCycle = options.billingCycle || defaultBillingCycle
    state.source = options.source || 'hero_cta'
    state.paymentStatus = 'idle'
    state.paymentMessage = ''
    state.checkoutUrl = ''
    state.legacyUrl = ''
    state.orderId = ''
    state.guestToken = ''
    state.requestInFlight = false
    setStep('plans')
    showModal()
    render()

    const pricing = getPricing(state.selectedPlanId, state.billingCycle)
    safeTrack('launch_clicked', {
      source: state.source,
      planId: pricing.selectionId,
      billingCycle: state.billingCycle,
      elementKey: `launch_${state.source}`,
    })
  }

  function removeCheckoutQueryParams() {
    const url = new URL(window.location.href)
    let changed = false
    ;['checkout', 'order', 'claim', 'guest_token', 'guest', 'plan', 'provider', 'checkout_id', 'signature'].forEach(function (key) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    })
    if (changed) {
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash)
    }
  }

  function openCenteredPopup(name, width, height) {
    const popupWidth = width || 540
    const popupHeight = height || 780
    const left = Math.max(0, Math.round((window.screen.width - popupWidth) / 2))
    const top = Math.max(0, Math.round((window.screen.height - popupHeight) / 2))
    const features = [
      'popup=yes',
      'resizable=yes',
      'scrollbars=yes',
      `width=${popupWidth}`,
      `height=${popupHeight}`,
      `left=${left}`,
      `top=${top}`,
    ].join(',')

    const popup = window.open('about:blank', name, features)
    if (popup) {
      popup.focus()
    }
    return popup
  }

  function formatSelectionTitle(pricing) {
    if (pricing.custom) return 'Enterprise'
    return `${pricing.plan.name} - ${pricing.billingCycle === 'annual' ? 'Yearly' : 'Monthly'}`
  }

  function writePopupLoading(popup, pricing) {
    if (!popup || popup.closed) return

    const safeTitle = formatSelectionTitle(pricing)
    const safeSubtitle = 'Preparing your secure checkout...'
    popup.document.open()
    popup.document.write(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MiroFish Checkout</title><style>' +
        "body{margin:0;font-family:Inter,Arial,sans-serif;background:#0d1b2e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}main{max-width:360px;text-align:center;}h1{font-size:28px;line-height:1.1;margin:0 0 12px;}p{margin:0;color:rgba(255,255,255,.74);line-height:1.6;}strong{display:block;margin-bottom:10px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#00e5ff;}" +
        '</style></head><body><main><strong>MiroFish</strong><h1>' +
        safeTitle +
        '</h1><p>' +
        safeSubtitle +
        '</p></main></body></html>',
    )
    popup.document.close()
  }

  function ensurePopupMonitor() {
    clearPopupMonitor()
    state.popupMonitor = window.setInterval(function () {
      if (!state.popup || state.popup.closed) {
        clearPopupMonitor()
        state.popup = null
        if (state.step === 'payment' && state.paymentStatus !== 'success' && state.paymentStatus !== 'error') {
          state.paymentStatus = 'closed'
          state.paymentMessage = 'The payment popup was closed before checkout finished. You can reopen it at any time.'
          render()
        }
      }
    }, 600)
  }

  function navigatePopup(popup, url) {
    if (!url) return false

    const activePopup = popup || openCenteredPopup('mirofish-checkout-popup', 540, 780)
    if (!activePopup) return false

    try {
      activePopup.location.href = url
      activePopup.focus()
      state.popup = activePopup
      ensurePopupMonitor()
      return true
    } catch {
      return false
    }
  }

  function buildSiteCheckoutUrl(pricing) {
    const url = new URL('/checkout/', window.location.origin)
    url.searchParams.set('plan', pricing.plan.id)
    url.searchParams.set('billing', pricing.billingCycle)
    url.searchParams.set('source', state.source || 'pricing')
    return url.toString()
  }

  function goToSiteCheckout(pricing) {
    safeTrack('plan_selected', {
      source: state.source,
      planId: pricing.selectionId,
      billingCycle: pricing.billingCycle,
      amountCents: pricing.amountCents,
      elementKey: `plan_${pricing.plan.id}`,
    })
    window.location.href = buildSiteCheckoutUrl(pricing)
  }

  async function requestCheckoutSession(pricing) {
    const response = await fetch('/api/launch-checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        planId: pricing.selectionId,
        source: state.source,
      }),
      credentials: 'same-origin',
    })

    const rawText = await response.text()
    const payload = rawText ? JSON.parse(rawText) : {}

    if (!response.ok) {
      throw new Error(payload && payload.message ? payload.message : 'Checkout could not be started.')
    }

    return payload
  }

  function scrollPricingGridIntoView(behavior) {
    const pricingSection = document.getElementById('pricing')
    if (!pricingSection) return

    const pricingMenu = pricingSection.querySelector('.section-title') || pricingSection
    const navHeight = document.querySelector('.nav')?.offsetHeight || 64
    const menuTop = pricingMenu.getBoundingClientRect().top + window.scrollY
    const scrollTop = Math.max(0, menuTop - navHeight - 14)
    if (behavior === 'smooth') {
      window.scrollTo({ top: scrollTop, behavior: 'smooth' })
      return
    }

    const root = document.documentElement
    const previousScrollBehavior = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'
    window.scrollTo(0, scrollTop)
    root.style.scrollBehavior = previousScrollBehavior
  }

  function scrollToPricingMenu(options) {
    state.selectedPlanId = options.planId || defaultPlanId
    state.billingCycle = options.billingCycle || defaultBillingCycle
    state.source = options.source || 'pricing_jump'
    state.paymentStatus = 'idle'
    state.paymentMessage = ''
    state.checkoutUrl = ''
    state.legacyUrl = ''
    state.orderId = ''
    state.guestToken = ''
    state.requestInFlight = false
    forceClosedInitialState()
    render()

    scrollPricingGridIntoView('auto')
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, '#pricing')
    }

    const pricing = getPricing(state.selectedPlanId, state.billingCycle)
    safeTrack('launch_clicked', {
      source: state.source,
      planId: pricing.selectionId,
      billingCycle: state.billingCycle,
      elementKey: `launch_${state.source}`,
    })
  }

  async function startCheckoutFlow() {
    const pricing = getPricing(state.selectedPlanId, state.billingCycle)
    if (state.requestInFlight) {
      return
    }

    state.requestInFlight = true
    state.paymentStatus = 'loading'
    state.paymentMessage = 'Preparing your checkout session. A secure payment popup should appear over this page in a moment.'
    state.checkoutUrl = ''
    state.legacyUrl = ''
    state.orderId = ''
    state.guestToken = ''
    setStep('payment')
    render()

    const popup = openCenteredPopup('mirofish-checkout-popup', 540, 780)
    if (popup) {
      state.popup = popup
      writePopupLoading(popup, pricing)
      ensurePopupMonitor()
    }

    safeTrack('plan_selected', {
      source: state.source,
      planId: pricing.selectionId,
      billingCycle: pricing.billingCycle,
      amountCents: pricing.amountCents,
      elementKey: `plan_${pricing.plan.id}`,
    })
    safeTrack('checkout_started', {
      source: state.source,
      planId: pricing.selectionId,
      billingCycle: pricing.billingCycle,
      amountCents: pricing.amountCents,
      elementKey: 'checkout_started',
    })

    try {
      const payload = await requestCheckoutSession(pricing)
      state.orderId = payload.orderId || ''
      state.guestToken = payload.guestToken || ''
      state.checkoutUrl = payload.checkoutUrl || ''

      const opened = navigatePopup(popup, state.checkoutUrl)
      state.paymentStatus = opened ? 'ready' : 'blocked'
      state.paymentMessage = opened
        ? 'Your secure payment popup is open. Finish payment there and MiroFish will close the popup automatically when checkout returns.'
        : 'Your browser blocked the popup. Use the button below to reopen secure payment.'

      safeTrack('checkout_redirected', {
        source: state.source,
        planId: pricing.selectionId,
        billingCycle: pricing.billingCycle,
        orderId: state.orderId,
        paymentProvider: payload.paymentProvider || 'creem',
        popupMode: opened ? 'auto' : 'manual',
        elementKey: 'checkout_redirected',
      })
    } catch (error) {
      state.legacyUrl = ''
      state.paymentStatus = 'error'
      state.paymentMessage = 'Checkout is not configured on this deployment yet. Please stay on this MiroFish page and try again later.'

      safeTrack('checkout_start_failed', {
        source: state.source,
        planId: pricing.selectionId,
        billingCycle: pricing.billingCycle,
        message: error instanceof Error ? error.message : 'Checkout start failed.',
        elementKey: 'checkout_start_failed',
      })
    } finally {
      state.requestInFlight = false
      render()
    }
  }

  function handleCheckoutMessage(event) {
    if (event.origin !== window.location.origin) return
    if (!event.data || event.data.type !== 'mirofish-checkout-result') return

    if (event.data.status === 'success') {
      const orderId = String(event.data.orderId || '')
      const guestToken = String(event.data.guestToken || '')
      const alreadyCompleted = orderId ? completedOrderIds.has(orderId) : false
      if (orderId) {
        completedOrderIds.add(orderId)
      }
      state.orderId = orderId
      state.guestToken = guestToken
      state.paymentStatus = 'success'
      state.paymentMessage = ''
      state.checkoutUrl = ''
      state.legacyUrl = ''
      state.requestInFlight = false
      state.popup = null
      try {
        window.localStorage.setItem('mirofish:lastWorkspace', JSON.stringify({
          orderId,
          guestToken,
          consolePath: guestToken ? `/console?order=${encodeURIComponent(orderId)}&guest_token=${encodeURIComponent(guestToken)}` : `/console?order=${encodeURIComponent(orderId)}`,
          savedAt: new Date().toISOString(),
        }))
      } catch {}
      clearPopupMonitor()
      setStep('success')
      showModal()
      render()

      if (!alreadyCompleted) {
        safeTrack('payment_completed', {
          source: state.source,
          planId: String(event.data.planId || getPricing(state.selectedPlanId, state.billingCycle).selectionId),
          billingCycle: state.billingCycle,
          orderId,
          elementKey: 'payment_completed',
        })
      }
    }
  }

  function handlePopupReturn() {
    const params = new URLSearchParams(window.location.search)
    const checkoutStatus = params.get('checkout')
    if (!checkoutStatus) return false

    const payload = {
      type: 'mirofish-checkout-result',
      status: checkoutStatus,
      orderId: params.get('order') || '',
      guestToken: params.get('guest_token') || params.get('guest') || '',
      planId: params.get('plan') || '',
    }

    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage(payload, window.location.origin)
        if (checkoutStatus === 'success') {
          window.close()
          return true
        }
      } catch {}
    }

    if (checkoutStatus === 'success') {
      state.selectedPlanId = payload.planId ? String(payload.planId).split(':')[0] : state.selectedPlanId
      state.billingCycle = payload.planId && String(payload.planId).endsWith(':monthly') ? 'monthly' : 'annual'
      state.orderId = payload.orderId
      state.guestToken = payload.guestToken
      state.paymentStatus = 'success'
      setStep('success')
      showModal()
      render()

      if (!completedOrderIds.has(payload.orderId)) {
        completedOrderIds.add(payload.orderId)
        safeTrack('payment_completed', {
          source: 'direct_return',
          planId: payload.planId || getPricing(state.selectedPlanId, state.billingCycle).selectionId,
          billingCycle: state.billingCycle,
          orderId: payload.orderId,
          elementKey: 'payment_completed',
        })
      }
    }

    removeCheckoutQueryParams()
    return true
  }

  function renderPriceGroup(amountTargets, periodTargets, noteTargets, pricing) {
    amountTargets.forEach(function (node) {
      node.textContent = pricing.displayAmount
        .replace('$', '')
        .replace(/\.00$/, '')
    })
    periodTargets.forEach(function (node) {
      node.textContent = pricing.displayPeriod
    })
    noteTargets.forEach(function (node) {
      node.textContent = pricing.sectionNote
    })
  }

  function render() {
    const pricing = getPricing(state.selectedPlanId, state.billingCycle)

    elements.billingButtons.forEach(function (button) {
      const isActive = button.getAttribute('data-billing-option') === state.billingCycle
      button.classList.toggle('is-active', isActive)
      button.setAttribute('aria-pressed', String(isActive))
    })

    Object.keys(planCatalog).forEach(function (planId) {
      const planPricing = getPricing(planId, state.billingCycle)
      renderPriceGroup(
        elements.sectionPriceAmount[planId] || [],
        elements.sectionPricePeriod[planId] || [],
        elements.sectionPriceNote[planId] || [],
        planPricing,
      )
      renderPriceGroup(
        elements.modalPriceAmount[planId] || [],
        elements.modalPricePeriod[planId] || [],
        elements.modalPriceNote[planId] || [],
        planPricing,
      )

      ;(elements.pricingCards[planId] || []).forEach(function (card) {
        card.classList.toggle('is-selected', planId === state.selectedPlanId)
      })
      ;(elements.modalPlanCards[planId] || []).forEach(function (card) {
        card.classList.toggle('is-selected', planId === state.selectedPlanId)
      })
    })

    if (elements.selectionTitle) {
      elements.selectionTitle.textContent = formatSelectionTitle(pricing)
    }
    if (elements.selectionNote) {
      elements.selectionNote.textContent = pricing.selectionNote
    }
    if (elements.continueButton) {
      elements.continueButton.textContent = getContinueLabel(pricing)
    }
    if (elements.paymentHeadline) {
      elements.paymentHeadline.textContent = pricing.free
        ? 'No payment step is required for the Starter demo.'
        : 'We are preparing a secure payment popup for the plan you selected.'
    }
    if (elements.paymentPlan) {
      elements.paymentPlan.textContent = formatSelectionTitle(pricing)
    }
    if (elements.paymentBilling) {
      elements.paymentBilling.textContent = pricing.paymentBilling
    }
    if (elements.paymentDiscount) {
      elements.paymentDiscount.textContent = pricing.discountLabel
    }
    if (elements.paymentProvider) {
      elements.paymentProvider.textContent = getPaymentProviderLabel()
    }
    if (elements.paymentStatus) {
      elements.paymentStatus.textContent = state.paymentMessage || 'Preparing your checkout session.'
    }

    if (elements.paymentLink) {
      const href = state.checkoutUrl || state.legacyUrl
      if (href) {
        elements.paymentLink.hidden = false
        elements.paymentLink.href = href
        elements.paymentLink.textContent =
          state.paymentStatus === 'ready'
            ? 'Reopen secure payment'
            : state.paymentStatus === 'fallback'
              ? 'Open legacy payment popup'
              : 'Open secure payment'
      } else {
        elements.paymentLink.hidden = true
        elements.paymentLink.removeAttribute('href')
      }
    }

    if (elements.successPlan) {
      elements.successPlan.textContent = formatSelectionTitle(pricing)
    }
    if (elements.successOrder) {
      elements.successOrder.textContent = state.orderId || 'Pending confirmation'
    }
  }

  function collectByPlanAttribute(selector, attributeName) {
    const map = {}
    document.querySelectorAll(selector).forEach(function (node) {
      const key = node.getAttribute(attributeName)
      if (!key) return
      if (!map[key]) {
        map[key] = []
      }
      map[key].push(node)
    })
    return map
  }

  function initializeElements() {
    elements.overlay = document.getElementById('launch-modal')
    if (!elements.overlay) return false

    elements.steps = Array.from(document.querySelectorAll('[data-launch-step]'))
    elements.billingButtons = Array.from(document.querySelectorAll('[data-billing-option]'))
    elements.sectionPriceAmount = collectByPlanAttribute('[data-plan-price-amount]', 'data-plan-price-amount')
    elements.sectionPricePeriod = collectByPlanAttribute('[data-plan-price-period]', 'data-plan-price-period')
    elements.sectionPriceNote = collectByPlanAttribute('[data-plan-price-note]', 'data-plan-price-note')
    elements.modalPriceAmount = collectByPlanAttribute('[data-modal-price-amount]', 'data-modal-price-amount')
    elements.modalPricePeriod = collectByPlanAttribute('[data-modal-price-period]', 'data-modal-price-period')
    elements.modalPriceNote = collectByPlanAttribute('[data-modal-price-note]', 'data-modal-price-note')
    elements.pricingCards = collectByPlanAttribute('[data-pricing-plan]', 'data-pricing-plan')
    elements.modalPlanCards = collectByPlanAttribute('[data-modal-plan]', 'data-modal-plan')
    elements.selectionTitle = document.querySelector('[data-selection-title]')
    elements.selectionNote = document.querySelector('[data-selection-note]')
    elements.continueButton = document.querySelector('[data-launch-continue]')
    elements.paymentHeadline = document.querySelector('[data-payment-headline]')
    elements.paymentPlan = document.querySelector('[data-payment-plan]')
    elements.paymentBilling = document.querySelector('[data-payment-billing]')
    elements.paymentDiscount = document.querySelector('[data-payment-discount]')
    elements.paymentProvider = document.querySelector('[data-payment-provider]')
    elements.paymentStatus = document.querySelector('[data-payment-status]')
    elements.paymentLink = document.querySelector('[data-payment-link]')
    elements.successPlan = document.querySelector('[data-success-plan]')
    elements.successOrder = document.querySelector('[data-success-order]')
    return true
  }

  function forceClosedInitialState() {
    if (!elements.overlay) return
    state.modalOpen = false
    state.step = 'plans'
    state.paymentStatus = 'idle'
    state.paymentMessage = ''
    state.checkoutUrl = ''
    state.legacyUrl = ''
    state.orderId = ''
    state.guestToken = ''
    state.requestInFlight = false
    clearPopupMonitor()
    state.popup = null
    document.body.classList.remove('launch-modal-open')
    elements.overlay.hidden = true
    setStep('plans')
  }

  function attachEvents() {
    document.querySelectorAll('[data-pricing-jump]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault()
        scrollToPricingMenu({
          source: button.getAttribute('data-pricing-source') || 'pricing_jump',
          planId: button.getAttribute('data-pricing-plan-target') || defaultPlanId,
          billingCycle: button.getAttribute('data-pricing-billing') || defaultBillingCycle,
        })
      })
    })

    document.querySelectorAll('[data-launch-open]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault()
        const planId = button.getAttribute('data-launch-plan') || defaultPlanId
        const billingCycle = button.getAttribute('data-launch-billing') || state.billingCycle || defaultBillingCycle
        scrollToPricingMenu({
          source: button.getAttribute('data-launch-source') || 'cta',
          planId,
          billingCycle,
        })
      })
    })

    document.querySelectorAll('[data-launch-close]').forEach(function (button) {
      button.addEventListener('click', function () {
        closeModal()
      })
    })

    elements.overlay.addEventListener('click', function (event) {
      if (event.target === elements.overlay) {
        closeModal()
      }
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.modalOpen) {
        closeModal()
      }
    })

    elements.billingButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        state.billingCycle = button.getAttribute('data-billing-option') === 'monthly' ? 'monthly' : 'annual'
        render()
      })
    })

    document.querySelectorAll('[data-modal-plan]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.selectedPlanId = button.getAttribute('data-modal-plan') || defaultPlanId
        render()
      })
    })

    document.querySelectorAll('[data-pricing-plan]').forEach(function (card) {
      card.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('button, a')) {
          return
        }
        state.selectedPlanId = card.getAttribute('data-pricing-plan') || defaultPlanId
        render()
      })
    })

    document.querySelectorAll('[data-pricing-action]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault()
        state.selectedPlanId = button.getAttribute('data-pricing-action') || defaultPlanId
        state.source = `pricing_${state.selectedPlanId}`
        render()
        goToSiteCheckout(getPricing(state.selectedPlanId, state.billingCycle))
      })
    })

    if (elements.continueButton) {
      elements.continueButton.addEventListener('click', function () {
        goToSiteCheckout(getPricing(state.selectedPlanId, state.billingCycle))
      })
    }

    const backButton = document.querySelector('[data-launch-back]')
    if (backButton) {
      backButton.addEventListener('click', function () {
        state.paymentStatus = 'idle'
        state.paymentMessage = ''
        state.requestInFlight = false
        setStep('plans')
        render()
      })
    }

    if (elements.paymentLink) {
      elements.paymentLink.addEventListener('click', function () {
        const href = state.checkoutUrl || state.legacyUrl
        if (!href) return
        safeTrack('checkout_redirected', {
          source: state.source,
          planId: getPricing(state.selectedPlanId, state.billingCycle).selectionId,
          billingCycle: state.billingCycle,
          popupMode: 'manual_reopen',
          elementKey: 'checkout_redirected',
        })
      })
    }

    window.addEventListener('message', handleCheckoutMessage)
    window.addEventListener('hashchange', function () {
      if (window.location.hash === '#pricing') {
        window.setTimeout(function () {
          scrollPricingGridIntoView('auto')
        }, 0)
      }
    })
    window.addEventListener('pageshow', function () {
      const hasCheckoutReturn = new URLSearchParams(window.location.search).has('checkout')
      if (!hasCheckoutReturn) {
        forceClosedInitialState()
        render()
      }
    })
  }

  if (!initializeElements()) {
    return
  }

  forceClosedInitialState()
  attachEvents()
  const restoredFromCheckout = handlePopupReturn()
  if (!restoredFromCheckout) {
    forceClosedInitialState()
  }
  render()
  if (window.location.hash === '#pricing') {
    window.setTimeout(function () {
      scrollPricingGridIntoView('auto')
    }, 0)
  }
})()
