// Runs every ~10 minutes via GitHub Actions (see .github/workflows/check-calls.yml).
// Reliably handles Check Call scheduling and missed-deadline detection
// even when nobody has the app open — the app's own client-side timer
// still runs too (for a faster response while someone IS using it),
// this is the free backstop that keeps working when they're not.
const admin = require('firebase-admin')
const nodemailer = require('nodemailer')

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

const CHECK_CALL_INTERVAL_MS = 2 * 60 * 60 * 1000 // 2 hours
const RESPONSE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

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

    const elapsed = now - shift.clockedInAt
    const cycleIndex = Math.floor(elapsed / CHECK_CALL_INTERVAL_MS)
    const cc = shift.checkCall

    if (cc && cc.status === 'pending') {
      if (now > cc.deadline) {
        await docSnap.ref.update({ 'checkCall.status': 'missed' })
        const msg = `${shift.site}: check call missed — no response within 15 minutes.`
        await addNotification('admin', msg)
        await sendEmail('Missed Check Call — Advance Protection', msg)
        console.log('Marked missed:', docSnap.id)
      }
      continue
    }

    if (cycleIndex >= 1 && (!cc || cc.cycleIndex < cycleIndex)) {
      await docSnap.ref.update({
        checkCall: {
          cycleIndex,
          triggeredAt: now,
          deadline: now + RESPONSE_WINDOW_MS,
          status: 'pending',
          message: '',
        },
      })
      console.log('Triggered check call:', docSnap.id)
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
