import { createClient } from 'jsr:@supabase/supabase-js@2'

const QB_BASE = 'https://app.qualiobee.fr'
const NOTION_BASE = 'https://api.notion.com/v1'

// ─── Types ─────────────────────────────────────────────────────

interface NotionPage {
  id: string
  properties: Record<string, any>
}

// ─── Notion helpers ────────────────────────────────────────────

async function notionGet(path: string, token: string) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  })
  if (!res.ok) throw new Error(`Notion GET ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function notionPost(path: string, token: string, body: object) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion POST ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function notionPatch(path: string, token: string, body: object) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion PATCH ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function claimPage(_pageId: string, _token: string) {
  // déclencheur est un bouton Notion — pas d'état à réinitialiser via API
}

async function markSessionCreated(pageId: string, token: string) {
  await notionPatch(`/pages/${pageId}`, token, {
    properties: { 'déclencher': { checkbox: true } },
  })
}

async function fetchPagesToSync(_token: string, _dbId: string): Promise<NotionPage[]> {
  // déclencheur est un bouton Notion — pas de filtre possible via API
  // Le cron ne peut pas détecter les pages à traiter sans état persistant
  // Utiliser uniquement le webhook bouton pour déclencher la sync
  return []
}

// Property extractors
const getTitle = (p: NotionPage, k: string) =>
  p.properties[k]?.title?.map((t: any) => t.plain_text).join('') ?? ''
const getText = (p: NotionPage, k: string) =>
  p.properties[k]?.rich_text?.map((t: any) => t.plain_text).join('') ?? ''
const getDate = (p: NotionPage, k: string): string | null =>
  p.properties[k]?.date?.start ?? null
const getNumber = (p: NotionPage, k: string): number =>
  p.properties[k]?.number ?? 0
const getSelect = (p: NotionPage, k: string): string =>
  p.properties[k]?.select?.name ?? ''
const getMultiSelect = (p: NotionPage, k: string): string[] =>
  p.properties[k]?.multi_select?.map((s: any) => s.name) ?? []
const getRelationIds = (p: NotionPage, k: string): string[] =>
  p.properties[k]?.relation?.map((r: any) => r.id) ?? []
const getEmail = (p: NotionPage, k: string): string =>
  p.properties[k]?.email ?? ''
const getPhone = (p: NotionPage, k: string): string =>
  p.properties[k]?.phone_number ?? ''

// ─── Qualiobee internal API (document templates) ──────────────

async function loginQualiobeeInternal(username: string, password: string): Promise<string> {
  const res = await fetch(`${QB_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`Qualiobee login: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.tokens.access_token
}

async function probeEndpoint(url: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const res = await fetch(url, { headers })
    const text = await res.text()
    console.log(`probe ${url}: ${res.status} | ${text.slice(0, 300)}`)
    if (!res.ok) return []
    const data = JSON.parse(text)
    const items: any[] = data.result?.data ?? data.data ?? (Array.isArray(data) ? data : [])
    return items.map((c: any) => c.uuid).filter(Boolean)
  } catch (err) {
    console.warn(`probe error ${url}:`, err)
    return []
  }
}

async function getSessionDocUUIDs(
  sessionUuid: string,
  sessionObject: any,
  learnerUuid: string,
  internalToken: string,
  orgUuid: string,
  apiKey: string,
): Promise<{ conv: string[] }> {
  const bearerHeaders = { Authorization: `Bearer ${internalToken}` }
  const apiKeyHeaders = { 'x-api-key': apiKey, 'Content-Type': 'application/json' }

  // ── CONVOCATION : plusieurs approches en cascade ───────────────
  let conv: string[] = []

  // 1. Depuis l'objet session retourné à la création
  console.log(`session keys: ${Object.keys(sessionObject).join(',')}`)
  const convFromObj = [
    ...(Array.isArray(sessionObject.convocations) ? sessionObject.convocations : []),
    ...(sessionObject.convocation ? [sessionObject.convocation] : []),
  ].map((c: any) => (typeof c === 'string' ? c : c?.uuid)).filter(Boolean)
  if (convFromObj.length > 0) {
    console.log(`conv depuis session obj: ${convFromObj.join(',')}`)
    conv = convFromObj
  }

  // 2. API publique session avec relations
  if (conv.length === 0) {
    try {
      const res = await fetch(
        `${QB_BASE}/api/${orgUuid}/session/${sessionUuid}?relations[]=convocations&relations[]=attestations`,
        { headers: apiKeyHeaders },
      )
      const text = await res.text()
      console.log(`session public API relations: ${res.status} | ${text.slice(0, 600)}`)
      if (res.ok) {
        const data = JSON.parse(text)
        const c = (data.convocations ?? []).map((x: any) => x.uuid).filter(Boolean)
        if (c.length > 0) { console.log(`conv depuis public API: ${c.join(',')}`); conv = c }
      }
    } catch (err) {
      console.warn('session public API relations error:', err)
    }
  }

  // 3. API interne session avec Bearer
  if (conv.length === 0) {
    try {
      const res = await fetch(
        `${QB_BASE}/api/session/${sessionUuid}?relations[]=convocations`,
        { headers: bearerHeaders },
      )
      const text = await res.text()
      console.log(`session internal Bearer: ${res.status} | ${text.slice(0, 600)}`)
      if (res.ok) {
        const data = JSON.parse(text)
        const c = (data.convocations ?? []).map((x: any) => x.uuid).filter(Boolean)
        if (c.length > 0) { console.log(`conv depuis internal Bearer: ${c.join(',')}`); conv = c }
      }
    } catch (err) {
      console.warn('session internal Bearer error:', err)
    }
  }

  // 4. Probes convocation par session + learner
  if (conv.length === 0) {
    const convProbes: Array<[string, Record<string, string>]> = [
      [`${QB_BASE}/api/${orgUuid}/session/${sessionUuid}/convocations`, bearerHeaders],
      [`${QB_BASE}/api/${orgUuid}/session/${sessionUuid}/convocations`, apiKeyHeaders],
      [`${QB_BASE}/api/${orgUuid}/session/${sessionUuid}/convocation`, bearerHeaders],
      [`${QB_BASE}/api/${orgUuid}/session/${sessionUuid}/convocation`, apiKeyHeaders],
      [`${QB_BASE}/api/session/${sessionUuid}/convocations`, bearerHeaders],
      [`${QB_BASE}/api/convocation?session=${sessionUuid}&limit=100`, bearerHeaders],
      [`${QB_BASE}/api/convocation?sessionUuid=${sessionUuid}&limit=100`, bearerHeaders],
      [`${QB_BASE}/api/${orgUuid}/convocation?session=${sessionUuid}&limit=100`, bearerHeaders],
      [`${QB_BASE}/api/${orgUuid}/convocation?session=${sessionUuid}&limit=100`, apiKeyHeaders],
      [`${QB_BASE}/api/${orgUuid}/convocation?sessionUuid=${sessionUuid}&limit=100`, bearerHeaders],
      [`${QB_BASE}/api/${orgUuid}/convocation?sessionUuid=${sessionUuid}&limit=100`, apiKeyHeaders],
      ...(learnerUuid ? [
        [`${QB_BASE}/api/convocation?learner=${learnerUuid}&limit=100`, bearerHeaders] as [string, Record<string, string>],
        [`${QB_BASE}/api/${orgUuid}/convocation?learner=${learnerUuid}&limit=100`, apiKeyHeaders] as [string, Record<string, string>],
        [`${QB_BASE}/api/convocation?learnerUuid=${learnerUuid}&limit=100`, bearerHeaders] as [string, Record<string, string>],
      ] : []),
    ]
    for (const [url, hdrs] of convProbes) {
      const uuids = await probeEndpoint(url, hdrs)
      if (uuids.length > 0) { conv = uuids; break }
    }
  }

  console.log(`getSessionDocUUIDs result: ${conv.length} conv`)
  return { conv }
}

async function enableSubrogation(pricingUuid: string, token: string): Promise<void> {
  try {
    const patchRes = await fetch(`${QB_BASE}/api/pricing/${pricingUuid}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subrogation: true }),
    })
    const patchText = await patchRes.text()
    console.log(`pricing subrogation PATCH: ${patchRes.status} | ${patchText.slice(0, 200)}`)

    const funderRes = await fetch(`${QB_BASE}/api/funder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pricing: pricingUuid }),
    })
    const funderText = await funderRes.text()
    console.log(`funder POST: ${funderRes.status} | ${funderText.slice(0, 200)}`)
  } catch (err) {
    console.warn('enableSubrogation error:', err)
  }
}

async function patchDocTemplate(templateUuid: string, docUuid: string, token: string, bodyKey = 'attestation'): Promise<void> {
  try {
    const res = await fetch(`${QB_BASE}/api/document-template/duplicate/${templateUuid}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [bodyKey]: docUuid }),
    })
    const text = await res.text()
    if (!res.ok) console.warn(`template[${bodyKey}] ${templateUuid} → ${docUuid}: ${res.status} ${text}`)
    else console.log(`template[${bodyKey}] ${templateUuid} → ${docUuid}: OK`)
  } catch (err) {
    console.warn(`template patch error:`, err)
  }
}

const TMPL_CONVOCATION = 'a7c90117-3286-42d3-8179-871388253f15'
const TMPL_CERTIFICAT  = '91a36fb4-b5a3-488b-980b-80f69bc4b7ef'

async function assignDocumentTemplates(
  sessionUuid: string,
  sessionObject: any,
  learnerUuid: string,
  token: string,
  orgUuid: string,
  apiKey: string,
): Promise<void> {
  // Attendre 5s que Qualiobee crée les enregistrements convocation/attestation
  await new Promise((r) => setTimeout(r, 5000))

  const { conv } = await getSessionDocUUIDs(sessionUuid, sessionObject, learnerUuid, token, orgUuid, apiKey)

  console.log(`session ${sessionUuid}: ${conv.length} convocation(s)`)

  for (const uuid of conv) {
    await patchDocTemplate(TMPL_CONVOCATION, uuid, token, 'convocation')
    await patchDocTemplate(TMPL_CERTIFICAT, uuid, token, 'attestation')
  }

  if (conv.length === 0) {
    console.warn(`Aucun UUID convocation trouvé pour session ${sessionUuid}`)
  }
}

// ─── Qualiobee helpers ─────────────────────────────────────────

async function qb(path: string, apiKey: string, method = 'GET', body?: object) {
  const res = await fetch(`${QB_BASE}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qualiobee ${method} ${path}: ${res.status} ${text}`)
  }
  return res.json()
}

async function findOrCreateLearner(
  orgUuid: string,
  apiKey: string,
  params: { firstName: string; lastName: string; email: string; phoneNumber: string; externalId: string; customerUuid: string; isIndividual: boolean }
) {
  const byExtId = await qb(`/api/${orgUuid}/learner?externalId=${encodeURIComponent(params.externalId)}&limit=1`, apiKey)
  if (byExtId.data?.length > 0) return byExtId.data[0]

  if (params.email) {
    const byEmail = await qb(`/api/${orgUuid}/learner?email=${encodeURIComponent(params.email)}&limit=1`, apiKey)
    if (byEmail.data?.length > 0) return byEmail.data[0]
  }

  const learnerType = params.isIndividual ? 'PARTICULIER' : 'SALARIE'

  try {
    return await qb(`/api/${orgUuid}/learner`, apiKey, 'POST', {
      firstName: params.firstName,
      lastName: params.lastName,
      email: params.email,
      phoneNumber: params.phoneNumber,
      externalId: params.externalId,
      customerUuid: params.customerUuid,
      type: learnerType,
    })
  } catch (err) {
    // 403/409 = déjà existant — re-chercher par email avant de planter
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('403') || msg.includes('409') || msg.includes('422')) {
      if (params.email) {
        const retry = await qb(`/api/${orgUuid}/learner?email=${encodeURIComponent(params.email)}&limit=1`, apiKey)
        if (retry.data?.length > 0) return retry.data[0]
      }
      const retryExt = await qb(`/api/${orgUuid}/learner?externalId=${encodeURIComponent(params.externalId)}&limit=1`, apiKey)
      if (retryExt.data?.length > 0) return retryExt.data[0]
    }
    throw err
  }
}

async function findOrCreateCustomer(
  orgUuid: string,
  apiKey: string,
  params: { firstName: string; lastName: string; email: string; isIndividual: boolean; externalId: string }
) {
  const byExtId = await qb(`/api/${orgUuid}/customer?externalId=${encodeURIComponent(params.externalId)}&limit=1`, apiKey)
  if (byExtId.data?.length > 0) return byExtId.data[0]

  if (params.email) {
    const byEmail = await qb(`/api/${orgUuid}/customer?email=${encodeURIComponent(params.email)}&limit=1`, apiKey)
    if (byEmail.data?.length > 0) return byEmail.data[0]
  }

  return qb(`/api/${orgUuid}/customer`, apiKey, 'POST', params)
}

async function findFormationByType(orgUuid: string, apiKey: string, type: string) {
  const keywords: Record<string, string[]> = {
    IA:       ['intelligence artificielle generative', 'creation de contenus redactionnels', 'rs6776'],
    DEVIA:    ['rs7344', 'developper son activite avec l\'intelligence artificielle'],
    RS:       ['activite commerciale par les reseaux sociaux'],
    CM:       ['rs6452', 'community management'],
    SEO:      ['rs6521', 'referencement naturel'],
    LINKEDIN: ['linkedin'],
  }
  // Strip diacritics by decomposing to NFD and removing combining characters (U+0300–U+036F)
  const norm = (s: string) => s.normalize('NFD').split('').filter(c => {
    const cp = c.codePointAt(0) ?? 0; return cp < 0x0300 || cp > 0x036F
  }).join('').toLowerCase()

  // Inclure les modules pour obtenir leurs UUIDs
  const res = await qb(`/api/${orgUuid}/formation?limit=100&relations[]=modules`, apiKey)
  const formations: any[] = res.data ?? []
  const kws = keywords[type] ?? [norm(type)]

  const found = formations.find((f) =>
    kws.some((kw) => norm(f.title ?? '').includes(kw))
  )
  if (!found) throw new Error(`Formation "${type}" introuvable dans Qualiobee. Titres disponibles: ${formations.map((f) => f.title).join(', ')}`)
  return found
}

async function findExistingSession(orgUuid: string, apiKey: string, pageId: string) {
  try {
    const res = await qb(`/api/${orgUuid}/session?externalId=${encodeURIComponent(pageId)}&limit=1`, apiKey)
    return res.data?.[0] ?? null
  } catch {
    return null
  }
}

async function findOrCreateLocation(
  orgUuid: string,
  apiKey: string,
  params: { addressLine1: string; city: string }
) {
  const res = await qb(`/api/${orgUuid}/location?limit=100`, apiKey)
  const locations: any[] = res.data ?? []
  const found = locations.find(
    (l) =>
      l.city?.toLowerCase() === params.city.toLowerCase() ||
      l.addressLine1?.toLowerCase() === params.addressLine1.toLowerCase()
  )
  if (found) return found
  return qb(`/api/${orgUuid}/location`, apiKey, 'POST', {
    addressLine1: params.addressLine1,
    city: params.city,
    country: 'France',
  })
}

async function findOrCreateTrainer(orgUuid: string, apiKey: string, name: string) {
  const res = await qb(`/api/${orgUuid}/trainer?limit=100`, apiKey)
  const trainers: any[] = res.data ?? []
  const found = trainers.find(
    (t) =>
      `${t.firstName} ${t.lastName}`.toLowerCase().includes(name.toLowerCase()) ||
      t.lastName?.toLowerCase().includes(name.toLowerCase())
  )
  if (found) return found

  // Créer le formateur s'il n'existe pas dans Qualiobee
  const parts = name.trim().split(/\s+/)
  const lastName = parts[parts.length - 1]
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : lastName
  const slug = name.toLowerCase().replace(/\s+/g, '-')
  return qb(`/api/${orgUuid}/trainer`, apiKey, 'POST', {
    firstName,
    lastName,
    email: `${slug}@digit-formations.fr`,
    description: 'Formateur',
    externalId: `notion-trainer-${slug}`,
    isExternal: true,
  })
}

// ─── Construction des séances ──────────────────────────────────

function parisUtcOffsetMs(date: Date): number {
  // Retourne l'offset UTC→Paris en ms (ex: -7200000 pour UTC+2)
  const utcMs = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  const parisMs = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getTime()
  return utcMs - parisMs
}

function withTimeParis(base: Date, h: number, m: number): Date {
  // Construit une Date UTC représentant h:m heure de Paris sur la même journée que base
  const parisDateStr = base.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) // YYYY-MM-DD
  const naive = new Date(`${parisDateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
  return new Date(naive.getTime() + parisUtcOffsetMs(base))
}

function buildSessionDates(
  type: string,
  startDate: Date,
  endDate: Date,
  formationDate: Date,
  modalities: string[]
) {
  const isDistanciel = modalities.some((m) =>
    /distanciel|distance|remote|visio/i.test(m)
  )
  const presenceType = isDistanciel ? 'remote' : 'presence'

  const fmt = (d: Date) => d.toISOString()

  const ELEARNING_LINK = 'https://www.skool.com/digit-formations-1451/classroom'

  const dates: Array<{
    type: string
    startAt: string
    endAt: string
    elearningHours?: number
    remoteLink?: string
    softwareName?: string
  }> = []

  if (type === 'IA' || type === 'DEVIA') {
    // Présentiel EN PREMIER (Journee formation) pour que Qualiobee l'identifie comme "première séance"
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(formationDate, 12, 30)) })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 13, 30)), endAt: fmt(withTimeParis(formationDate, 17, 0)) })
    // E-learning : Journee formation 9h → Date de fin 17h
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 17, 0)), elearningHours: 14, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
  }

  if (type === 'RS' || type === 'CM') {
    // Présentiel EN PREMIER (Journee formation) pour que Qualiobee l'identifie comme "première séance"
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(formationDate, 12, 30)) })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 13, 30)), endAt: fmt(withTimeParis(formationDate, 17, 0)) })
    // E-learning : Journee formation 9h → Date de fin 17h
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 17, 0)), elearningHours: 10, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
    // Séance de suivi : lendemain de la Journee formation
    const suiviDay = new Date(formationDate)
    suiviDay.setDate(suiviDay.getDate() + 1)
    dates.push({ type: 'remote', startAt: fmt(withTimeParis(suiviDay, 10, 0)), endAt: fmt(withTimeParis(suiviDay, 11, 0)) })
  }

  if (type === 'LINKEDIN') {
    // Présentiel EN PREMIER sur Journee formation
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(formationDate, 12, 30)) })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(formationDate, 13, 30)), endAt: fmt(withTimeParis(formationDate, 17, 0)) })
    // E-learning : Journee formation 9h → Date de fin 17h
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(formationDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 17, 0)), elearningHours: 1, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
  }

  if (type === 'SEO') {
    // Séances distanciel EN PREMIER (lundi et jeudi) pour que Qualiobee identifie la première
    const cur = new Date(startDate)
    while (cur <= endDate) {
      const parisDay = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getDay()
      if (parisDay === 1 || parisDay === 4) {
        dates.push({
          type: 'remote',
          startAt: fmt(withTimeParis(cur, 10, 0)),
          endAt: fmt(withTimeParis(cur, 11, 0)),
        })
      }
      cur.setDate(cur.getDate() + 1)
    }
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(startDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 17, 0)), elearningHours: 7, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
  }

  return dates
}

// ─── Détection du type de formation ───────────────────────────

function detectFormationType(name: string): string {
  const n = name.toUpperCase()
  // Ordre important : les types composés doivent être testés avant les types simples
  if (/DEV\s+ACTI\s+IA\b/.test(n)) return 'DEVIA'
  if (/DEV\s+ACTI\s+CM\b|COMMUNITY\s+MANAG/.test(n)) return 'CM'
  if (/LINKEDIN/.test(n)) return 'LINKEDIN'
  if (/\bIA\b|INTELLIGENCE|MAITRIS/.test(n)) return 'IA'
  if (/DEV\s+ACTI\b|\bRS\b|RÉSEAUX|RESEAUX|SOCIAL/.test(n)) return 'RS'
  if (/\bSEO\b|RÉFÉRENCEMENT|REFERENCEMENT/.test(n)) return 'SEO'
  throw new Error(`Type de formation non reconnu dans: "${name}"`)
}

// ─── Sync d'une page Notion ────────────────────────────────────

async function syncPage(
  page: NotionPage,
  orgUuid: string,
  qbKey: string,
  notionKey: string,
  supabase: ReturnType<typeof createClient>
) {
  const pageId = page.id
  const sessionName = getTitle(page, 'Nom')
  const startDateStr = getDate(page, 'Date de début')
  const endDateStr = getDate(page, 'Date de fin')
  const modalities = getMultiSelect(page, 'Modalités')
  const montant = getNumber(page, 'Montant')
  // "Animé par" peut être select ou multi_select selon la config Notion
  const trainerName = getSelect(page, 'Animé par') || getMultiSelect(page, 'Animé par')[0] || ''
  const lieu = getText(page, 'Lieu') || getSelect(page, 'Lieu') || ''
  const ville = getSelect(page, 'Ville') || getText(page, 'Ville') || ''
  const clientIds = getRelationIds(page, 'Clients')
  // Supporte les deux noms de propriété (ancienne et nouvelle BDD)
  const formationDateStr = getDate(page, 'Journée de formation') ?? getDate(page, 'Journee formation')

  if (!startDateStr) throw new Error('Date de début manquante')
  if (!endDateStr) throw new Error('Date de fin manquante')
  if (!formationDateStr) throw new Error('Journée de formation manquante')
  if (clientIds.length === 0) throw new Error('Aucun client lié à la session')

  // Idempotence : éviter les doublons si le webhook est appelé plusieurs fois
  const existingSession = await findExistingSession(orgUuid, qbKey, pageId)
  if (existingSession) {
    console.log(`Session déjà existante pour page ${pageId}: ${existingSession.uuid} — skip`)
    return { sessionUuid: existingSession.uuid, formationType: 'already-exists', clientName: '', sessionDatesCreated: 0 }
  }

  // Décocher Automatisation immédiatement pour éviter qu'une autre invocation cron
  // ne repasse sur cette page pendant les ~30s de traitement
  await claimPage(pageId, notionKey)

  const startDate = new Date(startDateStr)
  const endDate = new Date(endDateStr)
  const formationDate = new Date(formationDateStr)
  const formationType = detectFormationType(sessionName)

  // Récupérer les infos du client depuis Notion
  const clientPage: NotionPage = await notionGet(`/pages/${clientIds[0]}`, notionKey)
  const firstName = getText(clientPage, 'Prénom du dirigeant')
  const lastName = getText(clientPage, 'Nom du dirigeant')
  const email = getEmail(clientPage, 'Email contact')
  const phone = getPhone(clientPage, 'Téléphone')
  const clientType = getSelect(clientPage, 'Type de client')
  const isIndividual = clientType !== 'Professionnel'

  // Trouver la formation dans Qualiobee
  const formation = await findFormationByType(orgUuid, qbKey, formationType)

  // Créer ou retrouver customer EN PREMIER (requis pour créer le learner)
  const customer = await findOrCreateCustomer(orgUuid, qbKey, {
    firstName,
    lastName,
    email,
    isIndividual,
    externalId: clientPage.id,
  })

  // Créer ou retrouver learner avec le customerUuid
  const learner = await findOrCreateLearner(orgUuid, qbKey, {
    firstName,
    lastName,
    email,
    phoneNumber: phone,
    externalId: clientPage.id,
    customerUuid: customer.uuid,
    isIndividual,
  })

  // Trouver ou créer le formateur (obligatoire pour les séances)
  if (!trainerName) throw new Error('Champ "Animé par" vide — un formateur est requis')
  const trainer = await findOrCreateTrainer(orgUuid, qbKey, trainerName)

  // Locations : distanciel pour e-learning/remote, physique pour présentiel
  const locationDistanciel = await findOrCreateLocation(orgUuid, qbKey, {
    addressLine1: 'Distanciel',
    city: 'Distanciel',
  })
  const locationPhysique = await findOrCreateLocation(orgUuid, qbKey, {
    addressLine1: lieu || 'Digit Formations',
    city: ville || lieu || 'Paris',
  })

  let session: any
  try {
    session = await qb(`/api/${orgUuid}/session`, qbKey, 'POST', {
      formationUuid: formation.uuid,
      externalId: pageId,
      name: formation.title,
      learnerUuids: [learner.uuid],
      isConventionDisabled: true,
      isConvocationDisabled: false,
      pricing: {
        strategy: 'FOR_FORMATION',
        precision: 'FIXED',
        moneyValue: montant,
        taxRate: 0,
      },
    })
  } catch (err) {
    // 500 peut indiquer un externalId déjà existant — re-chercher avant de planter
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('500') || msg.includes('409') || msg.includes('422')) {
      const existing = await findExistingSession(orgUuid, qbKey, pageId)
      if (existing) {
        console.log(`session déjà existante (récupérée après erreur ${msg.slice(0, 30)}): ${existing.uuid}`)
        return { sessionUuid: existing.uuid, formationType, clientName: `${firstName} ${lastName}`, sessionDatesCreated: 0 }
      }
    }
    throw err
  }

  console.log(`session créée: ${session.uuid} | keys: ${Object.keys(session).join(',')} | ${JSON.stringify(session).slice(0, 400)}`)

  // Récupérer les modules de la formation pour matching par type de séance
  const formationModules: { uuid: string; name: string }[] = (formation.modules ?? [])
    .map((m: any) => ({ uuid: m.uuid, name: (m.name ?? m.title ?? '').toLowerCase() }))
    .filter((m: any) => m.uuid)

  function moduleForType(type: string): string[] {
    if (formationModules.length === 0) return []
    const matched = formationModules.find((m) => {
      if (type === 'elearning') return m.name.includes('e-learning') || m.name.includes('elearning')
      if (type === 'remote') return m.name.includes('distanciel')
      if (type === 'presence') return m.name.includes('présentiel') || m.name.includes('presentiel')
      return false
    })
    return matched ? [matched.uuid] : []
  }

  // Créer les séances
  const sessionDates = buildSessionDates(formationType, startDate, endDate, formationDate, modalities)

  for (const sd of sessionDates) {
    const isPhysical = sd.type === 'presence'
    const body: Record<string, any> = {
      sessionUuid: session.uuid,
      type: sd.type,
      startAt: sd.startAt,
      endAt: sd.endAt,
      trainerUuids: [trainer.uuid],
      locationUuid: isPhysical ? locationPhysique.uuid : locationDistanciel.uuid,
    }
    if (sd.elearningHours) body.elearningHours = sd.elearningHours
    if (sd.remoteLink) body.remoteLink = sd.remoteLink
    if (sd.softwareName) body.remoteTool = sd.softwareName
    const moduleUuids = moduleForType(sd.type)
    if (moduleUuids.length > 0) {
      body.moduleUuids = moduleUuids
    } else if (formationModules.length > 0) {
      // API requires at least one moduleUuid — fallback to first available module
      body.moduleUuids = [formationModules[0].uuid]
    }

    await qb(`/api/${orgUuid}/session-date`, qbKey, 'POST', body)
  }

  // Cocher "declencher" pour notifier l'utilisateur que la session a été créée
  await markSessionCreated(pageId, notionKey)

  // Logger dans Supabase
  await supabase.from('qualiobee_sync_log').insert({
    notion_page_id: pageId,
    session_name: sessionName,
    formation_type: formationType,
    qualiobee_session_uuid: session.uuid,
    client_name: `${firstName} ${lastName}`,
    status: 'success',
  })

  // Assigner les modèles de documents via l'API interne Qualiobee
  const qbUsername = Deno.env.get('QUALIOBEE_USERNAME')
  const qbPassword = Deno.env.get('QUALIOBEE_PASSWORD')
  if (qbUsername && qbPassword) {
    await supabase.from('qualiobee_sync_log').insert({
      notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
      status: 'debug', error_message: 'CHECKPOINT-1: entree bloc credentials',
    })
    try {
      const internalToken = await loginQualiobeeInternal(qbUsername, qbPassword)
      await supabase.from('qualiobee_sync_log').insert({
        notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
        status: 'debug', error_message: 'CHECKPOINT-2: login-ok avant wait 20s',
      })
      // Attendre 20s que Qualiobee crée les documents convocation/attestation
      await new Promise((r) => setTimeout(r, 20000))
      await supabase.from('qualiobee_sync_log').insert({
        notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
        status: 'debug', error_message: 'CHECKPOINT-3: apres wait 20s',
      })

      // Retry jusqu'à 3 fois si les convocations ne sont pas encore disponibles
      let conv: string[] = []
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 10000))
        const result = await getSessionDocUUIDs(session.uuid, session, learner.uuid, internalToken, orgUuid, qbKey)
        conv = result.conv
        await supabase.from('qualiobee_sync_log').insert({
          notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
          status: 'debug', error_message: `conv-attempt-${attempt}: ${conv.join(',') || 'none'}`,
        })
        if (conv.length > 0) break
      }

      for (const uuid of conv) await patchDocTemplate(TMPL_CONVOCATION, uuid, internalToken, 'convocation')
      for (const uuid of conv) await patchDocTemplate(TMPL_CERTIFICAT, uuid, internalToken, 'attestation')

      // Activer la subrogation automatiquement
      const pricingUuid = session.pricing?.uuid
      if (pricingUuid) {
        await enableSubrogation(pricingUuid, internalToken)
        await supabase.from('qualiobee_sync_log').insert({
          notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
          status: 'debug', error_message: `subrogation-ok: pricing=${pricingUuid}`,
        })
      } else {
        console.warn(`pricing UUID non trouvé dans session ${session.uuid}. Keys: ${Object.keys(session).join(',')}`)
        await supabase.from('qualiobee_sync_log').insert({
          notion_page_id: pageId, session_name: sessionName, qualiobee_session_uuid: session.uuid,
          status: 'debug', error_message: `subrogation-skip: no pricingUuid (session keys: ${Object.keys(session).join(',')})`,
        })
      }
    } catch (err) {
      console.warn('Assignation modèles échouée (non bloquant):', err)
      await supabase.from('qualiobee_sync_log').insert({
        notion_page_id: pageId,
        session_name: sessionName,
        qualiobee_session_uuid: session.uuid,
        status: 'debug',
        error_message: `template-error: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    await supabase.from('qualiobee_sync_log').insert({
      notion_page_id: pageId,
      session_name: sessionName,
      qualiobee_session_uuid: session.uuid,
      status: 'debug',
      error_message: 'QUALIOBEE_USERNAME ou QUALIOBEE_PASSWORD non definis dans les secrets Supabase',
    })
  }

  return {
    sessionUuid: session.uuid,
    formationType,
    clientName: `${firstName} ${lastName}`,
    sessionDatesCreated: sessionDates.length,
  }
}

// ─── Entry point ───────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const ORG_UUID = Deno.env.get('QUALIOBEE_ORG_UUID')!
  const QB_KEY = Deno.env.get('QUALIOBEE_API_KEY')!
  const NOTION_KEY = Deno.env.get('NOTION_API_KEY')!
  const NOTION_DB = (Deno.env.get('NOTION_DATABASE_ID_vraie') || Deno.env.get('NOTION_DATABASE_ID'))!

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Détecter si c'est un webhook Notion (bouton) ou un appel cron
  let webhookPageId: string | null = null
  try {
    const body = await req.json()
    // Notion envoie l'id de la page dans data.id ou directement dans id
    webhookPageId = body?.data?.id ?? body?.page?.id ?? body?.id ?? null
    if (webhookPageId) console.log(`Webhook bouton reçu pour page: ${webhookPageId}`)
  } catch {
    // Body vide ou non-JSON (appel cron) — ignoré
  }

  const results: any[] = []
  const errors: any[] = []

  if (webhookPageId) {
    // Mode webhook : traiter uniquement la page déclenchée par le bouton
    try {
      const page: NotionPage = await notionGet(`/pages/${webhookPageId}`, NOTION_KEY)
      const result = await syncPage(page, ORG_UUID, QB_KEY, NOTION_KEY, supabase)
      results.push({ pageId: webhookPageId, ...result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pageId: webhookPageId, error: message })
      await supabase.from('qualiobee_sync_log').insert({
        notion_page_id: webhookPageId,
        status: 'error',
        error_message: message,
      })
    }
  } else {
    // Mode batch (cron) : cherche toutes les pages avec déclencheur = true
    const pages = await fetchPagesToSync(NOTION_KEY, NOTION_DB)

    if (pages.length === 0) {
      return new Response(JSON.stringify({ processed: 0, success: 0, errors: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    for (const page of pages) {
      try {
        const result = await syncPage(page, ORG_UUID, QB_KEY, NOTION_KEY, supabase)
        results.push({ pageId: page.id, ...result })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ pageId: page.id, error: message })
        await supabase.from('qualiobee_sync_log').insert({
          notion_page_id: page.id,
          status: 'error',
          error_message: message,
        })
      }
    }
  }

  return new Response(
    JSON.stringify({ processed: results.length + errors.length, success: results.length, errors: errors.length, results, errors }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
