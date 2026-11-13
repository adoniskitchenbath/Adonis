/**
 * Meta Conversions API: server-side "Lead" events for the kitchens landing page.
 *
 * Trigger: Netlify's `formSubmitted` platform event. It fires only after Netlify
 * Forms has accepted a submission and it has passed spam filtering, and it is
 * signed by Netlify, so it cannot be called directly by a browser.
 *
 * Nothing here runs in the request path of the form itself. A failure in this
 * function can never block, delay or alter the visitor's form submission or the
 * Netlify notification emails.
 */
import type { FormSubmittedEvent } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

// Graph API version. Override with META_GRAPH_API_VERSION (for example "v25.0")
// when Meta releases a newer version, without a code change.
const DEFAULT_GRAPH_API_VERSION = 'v24.0'

// Only submissions from this landing page are sent to Meta.
const TRACKED_LANDING_PAGE = 'kitchens'
const TRACKED_FORM_NAMES = new Set(['kitchen and bathroom-consultation'])

const DEFAULT_SOURCE_URL = 'https://landing.adoniskitchenbath.com/kitchens/'
const ALLOWED_SOURCE_HOSTS = ['landing.adoniskitchenbath.com']
const ALLOWED_SOURCE_HOST_SUFFIX = '--eloquent-speculoos-83d106.netlify.app'
const NETLIFY_DEFAULT_HOST = 'eloquent-speculoos-83d106.netlify.app'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FBP_RE = /^fb\.[0-9]\.[0-9]{10,16}\.[0-9]{1,30}$/
const FBC_RE = /^fb\.[0-9]\.[0-9]{10,16}\.[A-Za-z0-9_\-.]{1,400}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const DEDUPE_STORE = 'meta-capi-leads'
const META_TIMEOUT_MS = 8000

type UserData = {
  em?: string[]
  ph?: string[]
  client_ip_address?: string
  client_user_agent?: string
  fbp?: string
  fbc?: string
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const field = (data: Record<string, string>, key: string, maxLength = 500): string => {
  const value = data[key]
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxLength ? '' : trimmed
}

const normalizeEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase()
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null
}

// Meta expects digits only, including the country code. Numbers on this page are
// US numbers, so 10-digit numbers get the "1" country code prepended.
const normalizePhone = (raw: string): string | null => {
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 10) digits = `1${digits}`
  if (digits.length === 11 && !digits.startsWith('1')) return null
  return digits.length >= 11 && digits.length <= 15 ? digits : null
}

const sourceUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    const host = url.hostname
    const allowed =
      ALLOWED_SOURCE_HOSTS.includes(host) || host === NETLIFY_DEFAULT_HOST || host.endsWith(ALLOWED_SOURCE_HOST_SUFFIX)
    // Only origin + path: query strings can contain click IDs and other identifiers
    // that are already sent through the dedicated fbc field.
    return url.protocol === 'https:' && allowed ? `${url.origin}${url.pathname}` : DEFAULT_SOURCE_URL
  } catch {
    return DEFAULT_SOURCE_URL
  }
}

const buildUserData = (data: Record<string, string>, sendPhone: boolean): UserData => {
  const userData: UserData = {}

  const email = normalizeEmail(field(data, 'email', 254))
  if (email) userData.em = [sha256(email)]

  if (sendPhone) {
    const phone = normalizePhone(field(data, 'phone', 40))
    if (phone) userData.ph = [sha256(phone)]
  }

  // Netlify records the submitter's IP and user agent on every submission.
  const ip = field(data, 'ip', 64)
  if (ip && isIP(ip)) userData.client_ip_address = ip

  const userAgent = field(data, 'user_agent', 512) || field(data, 'meta_ua', 512)
  if (userAgent) userData.client_user_agent = userAgent

  const fbp = field(data, 'meta_fbp', 100)
  if (FBP_RE.test(fbp)) userData.fbp = fbp

  const fbc = field(data, 'meta_fbc', 500)
  if (FBC_RE.test(fbc)) userData.fbc = fbc

  return userData
}

/**
 * Claims the event ID so that a repeated delivery of the same submission (or a
 * resubmission that reuses the same ID) is only ever sent to Meta once.
 * Returns false if the ID was already claimed.
 */
const claimEventId = async (eventId: string): Promise<boolean> => {
  try {
    const store = getStore({ name: DEDUPE_STORE, consistency: 'strong' })
    const result = await store.set(eventId, new Date().toISOString(), { onlyIfNew: true })
    return result.modified
  } catch (error) {
    // If storage is unavailable, still send: Meta also deduplicates by event_id.
    console.warn('[meta-capi] Dedupe store unavailable, continuing:', (error as Error).message)
    return true
  }
}

const releaseEventId = async (eventId: string) => {
  try {
    await getStore({ name: DEDUPE_STORE, consistency: 'strong' }).delete(eventId)
  } catch {
    // Ignore: worst case a later retry of this ID is skipped.
  }
}

const sendLeadToMeta = async (data: Record<string, string>) => {
  // Only the kitchens landing page form carries tracking fields.
  const formName = field(data, 'form-name') || field(data, 'form_name')
  if (formName && !TRACKED_FORM_NAMES.has(formName)) return
  if (field(data, 'landing_page') !== TRACKED_LANDING_PAGE) return

  const eventId = field(data, 'meta_event_id', 64)
  if (!eventId) return // Browser had no JS, or the visitor opted out.
  if (!UUID_RE.test(eventId)) {
    console.warn('[meta-capi] Skipping submission with malformed event ID')
    return
  }

  // Respect the visitor's advertising choice made on the page at submission time.
  if (field(data, 'meta_consent') !== 'granted') {
    console.log(`[meta-capi] Skipping ${eventId}: no advertising consent`)
    return
  }

  const pixelId = Netlify.env.get('META_PIXEL_ID')?.trim()
  const accessToken = Netlify.env.get('META_CAPI_ACCESS_TOKEN')?.trim()
  if (!pixelId || !/^[0-9]{5,20}$/.test(pixelId) || !accessToken) {
    console.error('[meta-capi] META_PIXEL_ID or META_CAPI_ACCESS_TOKEN is missing or invalid; event not sent')
    return
  }

  const sendPhone = Netlify.env.get('META_CAPI_SEND_PHONE')?.trim().toLowerCase() === 'true'
  const userData = buildUserData(data, sendPhone)
  if (!userData.em && !userData.ph && !userData.client_ip_address && !userData.fbp && !userData.fbc) {
    console.warn(`[meta-capi] Skipping ${eventId}: no usable matching data`)
    return
  }

  if (!(await claimEventId(eventId))) {
    console.log(`[meta-capi] Skipping ${eventId}: already processed`)
    return
  }

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: sourceUrl(field(data, 'landing_url', 2000)),
        user_data: userData,
      },
    ],
    access_token: accessToken, // Sent in the POST body, never in a URL or log.
  }

  const testEventCode = Netlify.env.get('META_CAPI_TEST_EVENT_CODE')?.trim()
  if (testEventCode) {
    body.test_event_code = testEventCode
    console.warn('[meta-capi] META_CAPI_TEST_EVENT_CODE is set: events go to Test Events. Remove it after testing.')
  }

  const version = Netlify.env.get('META_GRAPH_API_VERSION')?.trim() || DEFAULT_GRAPH_API_VERSION
  const apiVersion = /^v[0-9]{2,3}\.0$/.test(version) ? version : DEFAULT_GRAPH_API_VERSION

  try {
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    const result = (await response.json().catch(() => ({}))) as {
      events_received?: number
      fbtrace_id?: string
      error?: { message?: string; type?: string; code?: number; fbtrace_id?: string }
    }

    if (!response.ok || result.error) {
      await releaseEventId(eventId)
      const err = result.error ?? {}
      console.error(
        `[meta-capi] Meta rejected ${eventId}: HTTP ${response.status} ${err.type ?? ''} ${err.code ?? ''} ${
          err.message ?? ''
        } (trace ${err.fbtrace_id ?? 'n/a'})`,
      )
      return
    }

    console.log(
      `[meta-capi] Lead ${eventId} sent (events_received=${result.events_received ?? '?'}, trace ${
        result.fbtrace_id ?? 'n/a'
      }${testEventCode ? ', TEST MODE' : ''})`,
    )
  } catch (error) {
    await releaseEventId(eventId)
    console.error(`[meta-capi] Request for ${eventId} failed: ${(error as Error).name} ${(error as Error).message}`)
  }
}

export default {
  async formSubmitted(event: FormSubmittedEvent) {
    try {
      await sendLeadToMeta(event.data ?? {})
    } catch (error) {
      // Never let tracking errors surface into the platform's form pipeline.
      console.error('[meta-capi] Unexpected error:', (error as Error).message)
    }
  },
}
