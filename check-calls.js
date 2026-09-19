// Runs every ~10 minutes via GitHub Actions (see .github/workflows/check-calls.yml).
// Reliably handles Check Call scheduling and missed-deadline detection
// even when nobody has the app open — the app's own client-side timer
// still runs too (for a faster response while someone IS using it),
// this is the free backstop that keeps working when they're not.
//
// Schedule (mirrors src/utils/checkCallSchedule.js in the main app):
//  - 10 minutes after clock-in
//  - every 2 hours after that
//  - 10 minutes before the shift's SCHEDULED end time
// Stops entirely once a shift is completed (clockedOutAt is set).
const admin = require('firebase-admin')
const nodemailer = require('nodemailer')

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

const TEN_MIN = 10 * 60000
const TWO_HR = 2 * 3600000
const RESPONSE_WINDOW_MS = 15 * 60000

// Same overnight-safe start/end parsing as utils/shiftTime.js in the main app.
function parseShiftWindow(shift) {
  const [startStr, endStr] = shift.time.split('-').map((s) => s.trim())
  const [year, month, day] = shift.date.split('-').map(Number)
  function toDate(timeStr) {
    const [h, m] = timeStr.split(':').map(Number)
    return new Date(year, month - 1, day, h, m, 0)
  }
  const start = toDate(startStr)
  let end = toDate(endStr)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  }
  return { start, end }
}

function computeCheckCallSchedule(shift) {
  const { end } = parseShiftWindow(shift)
  const scheduledEndMs = end.getTime()
  const startMs = shift.clockedInAt
  const points = []

  points.push({ type: 'start', index: 0, dueAt: startMs + TEN_MIN })

  let n = 1
  while (true) {
    const dueAt = startMs + n * TWO_HR
    if (dueAt >= scheduledEndMs - TEN_MIN) break
    points.push({ type: 'interval', index: n, dueAt })
    n++
  }

  const preEndDue = scheduledEndMs - TEN_MIN
  if (preEndDue > startMs + TEN_MIN) {
    points.push({ type: 'preEnd', index: 0, dueAt: preEndDue })
  }

  return points
}

function checkCallId(point) {
  return `${point.type}-${point.index}`
}

async function sendEmail(subject, text) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, ADMIN_EMAIL } = process.env
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ADMIN_EMAIL) {
    console.log('Email not configured (optional) — skipping.')
    return
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  })
  await transporter.sendMail({ from: GMAIL_USER, to: ADMIN_EMAIL, subject, text })
  console.log('Email sent:', subject)
}

async function addNotification(audience, message) {
  await db.collection('notifications').add({
    audience,
    message,
    createdAt: Date.now(),
    read: false,
  })
}

async function main() {
  const now = Date.now()
  const shiftsSnap = await db.collection('shifts').get()
  let checked = 0

  for (const docSnap of shiftsSnap.docs) {
    const shift = docSnap.data()
    if (!shift.clockedInAt || shift.clockedOutAt) continue // not currently in progress
    checked++

    const existing = shift.checkCalls || []
    let updated = existing
    let changed = false

    // Missed ones first.
    for (const e of existing) {
      if (e.status === 'pending' && now > e.deadline) {
        updated = updated.map((x) => (x.id === e.id ? { ...x, status: 'missed' } : x))
        changed = true
        const msg = `${shift.site}: check call missed — no response within 15 minutes.`
        await addNotification('admin', msg)
        await sendEmail('Missed Check Call — Advance Protection', msg)
        console.log('Marked missed:', docSnap.id, e.id)
      }
    }

    // Any new checkpoint due?
    const schedule = computeCheckCallSchedule(shift)
    for (const point of schedule) {
      const id = checkCallId(point)
      if (point.dueAt <= now && !updated.some((e) => e.id === id)) {
        updated = [
          ...updated,
          {
            id,
            type: point.type,
            dueAt: point.dueAt,
            deadline: point.dueAt + RESPONSE_WINDOW_MS,
            status: 'pending',
            message: '',
          },
        ]
        changed = true
        console.log('Triggered check call:', docSnap.id, id)
        break // one new check call per pass is plenty
      }
    }

    if (changed) {
      await docSnap.ref.update({ checkCalls: updated })
    }
  }

  console.log(`Done. ${checked} shift(s) currently in progress.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
