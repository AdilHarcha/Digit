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

async function fetchPagesToSync(token: string, dbId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = []
  let cursor: string | undefined = undefined

  do {
    const body: any = {
      filter: {
        and: [
          { property: 'Automatisation', checkbox: { equals: true } },
          { property: 'Ok dans Qualiobee ?', checkbox: { equals: false } },
        ],
      },
      page_size: 100,
    }
    if (cursor) body.start_cursor = cursor

    const data = await notionPost(`/databases/${dbId}/query`, token, body)
    pages.push(...data.results)
    cursor = data.has_more ? data.next_cursor : undefined
  } while (cursor)

  return pages
}

async function markPageSynced(pageId: string, token: string) {
  // Décoche "Automatisation" pour éviter une re-sync au prochain passage du cron
  // "Ok dans Qualiobee ?" est laissé à la main de l'utilisateur
  await notionPatch(`/pages/${pageId}`, token, {
    properties: { 'Automatisation': { checkbox: false } },
  })
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
): Promise<{ conv: string[], attest: string[] }> {
  const bearerHeaders = { Authorization: `Bearer ${internalToken}` }
  const apiKeyHeaders = { 'x-api-key': apiKey, 'Content-Type': 'application/json' }

  // ── ATTESTATION : sonde directe (méthode prouvée v16) ──────────
  let attest: string[] = []
  for (const param of ['session', 'sessionUuid']) {
    const uuids = await probeEndpoint(`${QB_BASE}/api/attestation?${param}=${sessionUuid}&limit=100`, bearerHeaders)
    if (uuids.length > 0) { attest = uuids; break }
  }
  if (attest.length === 0) {
    for (const param of ['session', 'sessionUuid']) {
      const uuids = await probeEndpoint(`${QB_BASE}/api/${orgUuid}/attestation?${param}=${sessionUuid}&limit=100`, bearerHeaders)
      if (uuids.length > 0) { attest = uuids; break }
    }
  }

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
        // Si attestation aussi présente et qu'on n'en a pas encore, on la prend
        if (attest.length === 0) {
          const a = (data.attestations ?? []).map((x: any) => x.uuid).filter(Boolean)
          if (a.length > 0) { attest = a }
        }
      }
    } catch (err) {
      console.warn('session public API relations error:', err)
    }
  }

  // 3. API interne session avec Bearer
  if (conv.length === 0) {
    try {
      const res = await fetch(
        `${QB_BASE}/api/session/${sessionUuid}?relations[]=convocations&relations[]=attestations`,
        { headers: bearerHeaders },
      )
      const text = await res.text()
      console.log(`session internal Bearer: ${res.status} | ${text.slice(0, 600)}`)
      if (res.ok) {
        const data = JSON.parse(text)
        const c = (data.convocations ?? []).map((x: any) => x.uuid).filter(Boolean)
        if (c.length > 0) { console.log(`conv depuis internal Bearer: ${c.join(',')}`); conv = c }
        if (attest.length === 0) {
          const a = (data.attestations ?? []).map((x: any) => x.uuid).filter(Boolean)
          if (a.length > 0) { attest = a }
        }
      }
    } catch (err) {
      console.warn('session internal Bearer error:', err)
    }
  }

  // 4. Probes convocation par session + learner
  if (conv.length === 0) {
    const convProbes: Array<[string, Record<string, string>]> = [
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

  console.log(`getSessionDocUUIDs result: ${conv.length} conv, ${attest.length} attest`)
  return { conv, attest }
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

  const { conv, attest } = await getSessionDocUUIDs(sessionUuid, sessionObject, learnerUuid, token, orgUuid, apiKey)

  console.log(`session ${sessionUuid}: ${conv.length} convocation(s), ${attest.length} attestation(s)`)

  // "convocation à traiter" → modèle Convocation
  for (const uuid of conv) {
    await patchDocTemplate(TMPL_CONVOCATION, uuid, token, 'convocation')
  }

  // "certificat à traiter" → modèle Certificat de réalisation
  for (const uuid of attest) {
    await patchDocTemplate(TMPL_CERTIFICAT, uuid, token, 'attestation')
  }

  if (conv.length === 0 && attest.length === 0) {
    console.warn(`Aucun UUID document trouvé pour session ${sessionUuid}`)
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

  return qb(`/api/${orgUuid}/learner`, apiKey, 'POST', {
    firstName: params.firstName,
    lastName: params.lastName,
    email: params.email,
    phoneNumber: params.phoneNumber,
    externalId: params.externalId,
    customerUuid: params.customerUuid,
    type: learnerType,
  })
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
    IA: ['ia', 'intelligence artificielle'],
    RS: ['rs', 'réseaux sociaux', 'reseaux sociaux', 'social'],
    SEO: ['seo', 'référencement', 'referencement'],
  }
  // Inclure les modules pour obtenir leurs UUIDs
  const res = await qb(`/api/${orgUuid}/formation?limit=100&relations[]=modules`, apiKey)
  const formations: any[] = res.data ?? []
  const kws = keywords[type] ?? [type.toLowerCase()]

  const found = formations.find((f) =>
    kws.some((kw) => f.title?.toLowerCase().includes(kw))
  )
  if (!found) throw new Error(`Formation "${type}" introuvable dans Qualiobee. Titres disponibles: ${formations.map((f) => f.title).join(', ')}`)
  return found
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

  if (type === 'IA') {
    // E-learning : startDate 9h → veille de endDate 17h (heure Paris)
    const elearningEnd = new Date(endDate)
    elearningEnd.setDate(elearningEnd.getDate() - 1)
    const safeElearningEnd = elearningEnd >= startDate ? elearningEnd : new Date(startDate)
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(startDate, 9, 0)), endAt: fmt(withTimeParis(safeElearningEnd, 17, 0)), elearningHours: 14, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
    // Présentiel sur endDate : 9h-12h30 et 13h30-17h (Paris)
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(endDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 12, 30)) })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(endDate, 13, 30)), endAt: fmt(withTimeParis(endDate, 17, 0)) })
  }

  if (type === 'RS') {
    const elearningEnd = new Date(endDate)
    elearningEnd.setDate(elearningEnd.getDate() - 1)
    const safeElearningEnd = elearningEnd >= startDate ? elearningEnd : new Date(startDate)
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(startDate, 9, 0)), endAt: fmt(withTimeParis(safeElearningEnd, 17, 0)), elearningHours: 10, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(endDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 12, 30)) })
    dates.push({ type: presenceType, startAt: fmt(withTimeParis(endDate, 13, 30)), endAt: fmt(withTimeParis(endDate, 17, 0)) })
    const suiviDay = new Date(endDate)
    suiviDay.setDate(suiviDay.getDate() + 1)
    dates.push({ type: 'remote', startAt: fmt(withTimeParis(suiviDay, 10, 0)), endAt: fmt(withTimeParis(suiviDay, 11, 0)) })
  }

  if (type === 'SEO') {
    dates.push({ type: 'elearning', startAt: fmt(withTimeParis(startDate, 9, 0)), endAt: fmt(withTimeParis(endDate, 17, 0)), elearningHours: 7, remoteLink: ELEARNING_LINK, softwareName: 'Skool' })
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
  }

  return dates
}

// ─── Détection du type de formation ───────────────────────────

function detectFormationType(name: string): string {
  const n = name.toUpperCase()
  if (/\bIA\b|INTELLIGENCE/.test(n)) return 'IA'
  if (/\bRS\b|RÉSEAUX|RESEAUX|SOCIAL/.test(n)) return 'RS'
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
  const lieu = getSelect(page, 'Lieu') || getText(page, 'Lieu') || ''
  const clientIds = getRelationIds(page, 'Clients')

  if (!startDateStr) throw new Error('Date de début manquante')
  if (!endDateStr) throw new Error('Date de fin manquante')
  if (clientIds.length === 0) throw new Error('Aucun client lié à la session')

  const startDate = new Date(startDateStr)
  const endDate = new Date(endDateStr)
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
    city: lieu || 'Paris',
  })

  // Créer la session (sans le prix dans le nom)
  const cleanName = sessionName.replace(/\s*[-–—]\s*\d[\d\s,.]*€?/g, '').trim()

  const session = await qb(`/api/${orgUuid}/session`, qbKey, 'POST', {
    formationUuid: formation.uuid,
    externalId: pageId,
    name: cleanName,
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

  console.log(`session créée: ${session.uuid} | keys: ${Object.keys(session).join(',')} | ${JSON.stringify(session).slice(0, 400)}`)

  // Récupérer les modules de la formation pour matching par type de séance
  const formationModules: { uuid: string; name: string }[] = (formation.modules ?? [])
    .map((m: any) => ({ uuid: m.uuid, name: (m.name ?? m.title ?? '').toLowerCase() }))
    .filter((m: any) => m.uuid)

  function moduleForType(type: string): string[] {
    if (formationModules.length === 0) return []
    let matched = formationModules.find((m) => {
      if (type === 'elearning') return m.name.includes('e-learning') || m.name.includes('elearning')
      if (type === 'remote') return m.name.includes('distanciel')
      if (type === 'presence') return m.name.includes('présentiel') || m.name.includes('presentiel')
      return false
    })
    if (!matched) matched = formationModules[0]
    return [matched.uuid]
  }

  // Créer les séances
  const sessionDates = buildSessionDates(formationType, startDate, endDate, modalities)

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
    if (sd.softwareName) body.softwareName = sd.softwareName
    const moduleUuids = moduleForType(sd.type)
    if (moduleUuids.length > 0) body.moduleUuids = moduleUuids

    await qb(`/api/${orgUuid}/session-date`, qbKey, 'POST', body)
  }

  // Décocher "Automatisation" en PREMIER pour éviter les doublons si la suite timeout
  await markPageSynced(pageId, notionKey)

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
    try {
      const internalToken = await loginQualiobeeInternal(qbUsername, qbPassword)
      // Attendre 15s que Qualiobee crée les documents convocation/attestation
      await new Promise((r) => setTimeout(r, 15000))
      const { conv, attest } = await getSessionDocUUIDs(session.uuid, session, learner.uuid, internalToken, orgUuid, qbKey)
      await supabase.from('qualiobee_sync_log').insert({
        notion_page_id: pageId,
        session_name: sessionName,
        qualiobee_session_uuid: session.uuid,
        status: 'debug',
        error_message: `conv=${conv.join(',')||'none'} attest=${attest.join(',')||'none'}`,
      })
      for (const uuid of conv) await patchDocTemplate(TMPL_CONVOCATION, uuid, internalToken, 'convocation')
      for (const uuid of attest) await patchDocTemplate(TMPL_CERTIFICAT, uuid, internalToken, 'attestation')
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
  const NOTION_DB = Deno.env.get('NOTION_DATABASE_ID')!

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const pages = await fetchPagesToSync(NOTION_KEY, NOTION_DB)

  const results: any[] = []
  const errors: any[] = []

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

  return new Response(
    JSON.stringify({ processed: pages.length, success: results.length, errors: errors.length, results, errors }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
