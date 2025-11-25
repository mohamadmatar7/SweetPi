const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'sweet.db');
const db = new Database(dbPath);

// Better durability
db.exec(`PRAGMA journal_mode = WAL;`);

/**
 * Base table definition
 * - For fresh installs this creates the full schema
 * - For existing DBs this is ignored and migration below fixes missing cols/indexes
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT,
    mollie_payment_id TEXT,
    name TEXT NOT NULL,
    email TEXT,
    amount_requested_eur REAL NOT NULL DEFAULT 0,
    amount_eur REAL,                    -- set when paid
    credits_total INTEGER NOT NULL DEFAULT 0,
    credits_used INTEGER NOT NULL DEFAULT 0,
    credits_pulsed INTEGER NOT NULL DEFAULT 0, -- credits pressed on machine once
    status TEXT NOT NULL DEFAULT 'created',    -- created | waiting | active | done
    session_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/**
 * Simple migration for older DBs
 * - SQLite does NOT allow "ADD COLUMN ... UNIQUE", so we:
 *   1) Add columns without UNIQUE
 *   2) Create UNIQUE INDEXes separately
 */
function ensureColumn(name, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(donations)`).all().map(c => c.name);
  if (!cols.includes(name)) {
    db.exec(`ALTER TABLE donations ADD COLUMN ${name} ${typeSql};`);
  }
}

// Add missing columns (if any) WITHOUT UNIQUE
ensureColumn('intent_id', 'TEXT');
ensureColumn('mollie_payment_id', 'TEXT');
ensureColumn('amount_requested_eur', 'REAL NOT NULL DEFAULT 0');
ensureColumn('amount_eur', 'REAL');
ensureColumn('credits_total', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('credits_used', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('credits_pulsed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('status', "TEXT NOT NULL DEFAULT 'created'");
ensureColumn('session_token', 'TEXT');
ensureColumn('created_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('updated_at', "TEXT NOT NULL DEFAULT ''");

// Enforce uniqueness with indexes (safe if already exist)
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_intent_id ON donations(intent_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_mollie_payment_id ON donations(mollie_payment_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_session_token ON donations(session_token);
`);

function nowIso() {
  return new Date().toISOString();
}

function newIntentId() {
  return crypto.randomBytes(16).toString('hex');
}

function newSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create donation intent BEFORE Mollie payment
 */
function createIntent({ name, email, amountRequestedEur }) {
  const intentId = newIntentId();
  const sessionToken = newSessionToken();

  db.prepare(`
    INSERT INTO donations
      (intent_id, name, email, amount_requested_eur, status, session_token, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, 'created', ?, ?, ?)
  `).run(
    intentId,
    name,
    email || null,
    amountRequestedEur,
    sessionToken,
    nowIso(),
    nowIso()
  );

  return { intentId, sessionToken };
}

function attachPaymentToIntent(intentId, molliePaymentId) {
  db.prepare(`
    UPDATE donations
    SET mollie_payment_id = ?, updated_at = ?
    WHERE intent_id = ?
  `).run(molliePaymentId, nowIso(), intentId);
}

function getIntent(intentId) {
  return db.prepare(`SELECT * FROM donations WHERE intent_id = ?`).get(intentId);
}

function getDonationById(id) {
  return db.prepare(`SELECT * FROM donations WHERE id = ?`).get(id);
}

function getDonationByPaymentId(molliePaymentId) {
  return db.prepare(`SELECT * FROM donations WHERE mollie_payment_id = ?`).get(molliePaymentId);
}

function markIntentPaid({ intentId, molliePaymentId, amountEur, creditsTotal }) {
  const now = nowIso();
  db.prepare(`
    UPDATE donations SET
      mollie_payment_id = COALESCE(mollie_payment_id, ?),
      amount_eur = ?,
      credits_total = ?,
      status = 'waiting',
      created_at = ?,       -- payment time defines queue order
      updated_at = ?
    WHERE intent_id = ?
  `).run(molliePaymentId, amountEur, creditsTotal, now, now, intentId);
}

function setDonationStatus(id, status) {
  db.prepare(`
    UPDATE donations
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(status, nowIso(), id);
}

/**
 * Move player to the end of queue (used when they don't move in time).
 * We keep status waiting but refresh created_at so they go last.
 */
function requeueToEnd(id) {
  const now = nowIso();
  db.prepare(`
    UPDATE donations
    SET status = 'waiting',
        created_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(now, now, id);
}

/**
 * Mark that machine credits were already pulsed for this donation.
 * This prevents double-crediting if player gets re-queued and becomes active again.
 */
function markCreditsPulsed(id) {
  db.prepare(`
    UPDATE donations
    SET credits_pulsed = 1, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), id);
}

function useOneCredit(id) {
  db.prepare(`
    UPDATE donations
    SET credits_used =
      CASE
        WHEN credits_used + 1 > credits_total THEN credits_total
        ELSE credits_used + 1
      END,
      updated_at = ?
    WHERE id = ?
  `).run(nowIso(), id);
}


function getDonationByToken(token) {
  return db.prepare(`SELECT * FROM donations WHERE session_token = ?`).get(token);
}

function listQueue() {
  return db.prepare(`
    SELECT id, name, credits_total, credits_used, credits_pulsed, status, created_at
    FROM donations
    WHERE status IN ('waiting','active')
    ORDER BY created_at ASC
  `).all();
}

/**
 * Admin: full list for dashboard.
 */
function listAllDonations() {
  return db.prepare(`
    SELECT *
    FROM donations
    ORDER BY created_at DESC
  `).all();
}

/**
 * Admin: add/subtract credits safely.
 * - credits_total is clamped to >= credits_used and >= 0.
 */
function adjustCredits(id, delta) {
  const row = getDonationById(id);
  if (!row) return null;

  const nextTotal = Math.max(0, (row.credits_total || 0) + delta);
  const clampedTotal = Math.max(nextTotal, row.credits_used || 0);

  db.prepare(`
    UPDATE donations
    SET credits_total = ?, updated_at = ?
    WHERE id = ?
  `).run(clampedTotal, nowIso(), id);

  return getDonationById(id);
}

/**
 * Admin: set total credits safely.
 */
function setCreditsTotal(id, creditsTotal) {
  const row = getDonationById(id);
  if (!row) return null;

  const nextTotal = Math.max(0, creditsTotal);
  const clampedTotal = Math.max(nextTotal, row.credits_used || 0);

  db.prepare(`
    UPDATE donations
    SET credits_total = ?, updated_at = ?
    WHERE id = ?
  `).run(clampedTotal, nowIso(), id);

  return getDonationById(id);
}

/**
 * Admin: set used credits safely.
 */
function setCreditsUsed(id, creditsUsed) {
  const row = getDonationById(id);
  if (!row) return null;

  const nextUsed = Math.max(0, Math.min(creditsUsed, row.credits_total || 0));

  db.prepare(`
    UPDATE donations
    SET credits_used = ?, updated_at = ?
    WHERE id = ?
  `).run(nextUsed, nowIso(), id);

  return getDonationById(id);
}

/**
 * Admin: delete a single donation row.
 */
function deleteDonationById(id) {
  db.prepare(`DELETE FROM donations WHERE id = ?`).run(id);
}

/**
 * Admin: delete all donations.
 */
function deleteAllDonations() {
  db.prepare(`DELETE FROM donations`).run();
}

module.exports = {
  db,
  createIntent,
  attachPaymentToIntent,
  getIntent,
  getDonationById,
  getDonationByPaymentId,
  markIntentPaid,
  setDonationStatus,
  requeueToEnd,
  markCreditsPulsed,
  useOneCredit,
  getDonationByToken,
  listQueue,

  // Admin exports
  listAllDonations,
  adjustCredits,
  setCreditsTotal,
  setCreditsUsed,
  deleteDonationById,
  deleteAllDonations,
};
