export type DeviceCategory = 'Mobile' | 'Tablet' | 'Desktop' | 'Unknown'

export type DeviceTrackingInfo = {
  device_category: DeviceCategory
  device_name: string
  operating_system: string
  operating_system_version: string
  browser: string
  browser_version: string
  device_identifier: string
  user_agent: string
  detected_at: string
}

type UserAgentData = {
  mobile?: boolean
  platform?: string
  brands?: Array<{ brand: string; version: string }>
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platformVersion?: string
    model?: string
    fullVersionList?: Array<{ brand: string; version: string }>
  }>
}

export type DeviceNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & { userAgentData?: UserAgentData }

let memoryDeviceIdentifier = ''
const DEVICE_ID_KEY = 'campusync:device-id'
const validIdentifier = (value: string | null): value is string => Boolean(value && /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(value))

function secureUuid() {
  if (typeof crypto === 'undefined') throw new Error('Secure random generation is not available in this browser.')
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  if (typeof crypto.getRandomValues !== 'function') throw new Error('Secure random generation is not available in this browser.')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Identifies this browser installation, not a physical device. Storage can be unavailable in private modes. */
export function getPersistentDeviceIdentifier() {
  if (memoryDeviceIdentifier) return memoryDeviceIdentifier
  try {
    const saved = localStorage.getItem(DEVICE_ID_KEY)
    if (validIdentifier(saved)) return (memoryDeviceIdentifier = saved)
  } catch { /* Try tab storage when persistent storage is blocked. */ }
  try {
    const saved = sessionStorage.getItem(DEVICE_ID_KEY)
    if (validIdentifier(saved)) return (memoryDeviceIdentifier = saved)
  } catch { /* A memory-only ID is the final storage fallback. */ }
  const identifier = secureUuid()
  memoryDeviceIdentifier = identifier
  try { localStorage.setItem(DEVICE_ID_KEY, identifier) } catch {
    try { sessionStorage.setItem(DEVICE_ID_KEY, identifier) } catch { /* Keep it in memory for this app lifetime. */ }
  }
  return identifier
}

export async function detectBrowserDevice(nav: DeviceNavigator = navigator) {
  const ua = nav.userAgent ?? ''
  const platform = nav.platform ?? ''
  const hints = nav.userAgentData
  const ipad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1)
  const android = /Android/i.test(ua) || /Android/i.test(hints?.platform ?? '')
  const iphone = /iPhone|iPod/i.test(ua)
  const mobile = iphone || /Mobile/i.test(ua) || hints?.mobile === true
  const tablet = ipad || /Tablet|PlayBook|Silk/i.test(ua) || (android && !mobile)

  let operatingSystem = ipad ? 'iPadOS'
    : iphone ? 'iOS'
    : android ? 'Android'
    : /Windows/i.test(ua) || /Win/i.test(platform) ? 'Windows'
    : /CrOS/i.test(ua) || /Chrome OS/i.test(hints?.platform ?? '') ? 'ChromeOS'
    : /Macintosh|Mac OS/i.test(ua) || /Mac/i.test(platform) ? 'macOS'
    : /Linux|X11/i.test(ua) || /Linux/i.test(platform) ? 'Linux'
    : 'Unknown'
  let operatingSystemVersion = ipad ? '' : (ua.match(/(?:Windows NT|Android|iPhone OS|CPU OS|Mac OS X) ([\d._]+)/i)?.[1] ?? '').replaceAll('_', '.')

  const browserPatterns: Array<[string, RegExp]> = [
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/i], ['Edge', /(?:Edg|EdgiOS|EdgA)\/([\d.]+)/i],
    ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/i], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/i],
    ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/i], ['Safari', /Version\/([\d.]+).*Safari/i],
  ]
  let browser = 'Unknown'
  let browserVersion = ''
  for (const [name, pattern] of browserPatterns) {
    const match = ua.match(pattern)
    if (match) { browser = name; browserVersion = match[1]; break }
  }

  try {
    const highEntropy = await hints?.getHighEntropyValues?.(['platformVersion', 'model', 'fullVersionList'])
    const hintPlatform = hints?.platform ?? ''
    if (hintPlatform) {
      if (/Android/i.test(hintPlatform)) operatingSystem = 'Android'
      else if (/Windows/i.test(hintPlatform)) operatingSystem = 'Windows'
      else if (/macOS/i.test(hintPlatform)) operatingSystem = 'macOS'
      else if (/Chrome OS/i.test(hintPlatform)) operatingSystem = 'ChromeOS'
      else if (!ipad && !iphone) operatingSystem = 'Unknown'
    }
    if (!ipad && highEntropy?.platformVersion) operatingSystemVersion = highEntropy.platformVersion
    const brands = highEntropy?.fullVersionList ?? hints?.brands ?? []
    const actualBrand = brands.find(item => !/Not.?A.?Brand/i.test(item.brand))
    const knownBrand = brands.find(item => /Microsoft Edge|Google Chrome|Opera/i.test(item.brand))
    const brand = knownBrand ?? actualBrand
    if (brand) {
      browser = /Edge/i.test(brand.brand) ? 'Edge' : /Opera/i.test(brand.brand) ? 'Opera' : /Chrome|Chromium/i.test(brand.brand) ? 'Chrome' : browser
      if (browser !== 'Unknown') browserVersion = brand.version
    }
  } catch { /* Client hints are optional; retain UA results. */ }

  const device_category: DeviceCategory = ipad || tablet ? 'Tablet' : mobile ? 'Mobile' :
    /Windows|Macintosh|Mac OS|Linux|X11|CrOS/i.test(ua) || /Windows|Mac|Linux/i.test(platform) ? 'Desktop' : 'Unknown'
  const device_name = [device_category, operatingSystem, browser].filter(value => value && value !== 'Unknown').join(' · ') || 'Unknown device'
  return {
    device_category, device_name, operating_system: operatingSystem, operating_system_version: operatingSystemVersion,
    browser, browser_version: browserVersion, user_agent: ua, detected_at: new Date().toISOString(),
  }
}

export async function collectDeviceTrackingInfo(nav: DeviceNavigator = navigator): Promise<DeviceTrackingInfo> {
  const detected = await detectBrowserDevice(nav)
  return { ...detected, device_identifier: getPersistentDeviceIdentifier() }
}
