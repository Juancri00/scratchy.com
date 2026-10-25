'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { QUESTIONS, BY_ID } = require('./questions');

const CONSENT_TEXT =
  'Yes, Otter may contact me by phone or text about its products and services. I can opt out at any time.';
const CONSENT_VERSION = '2026-10-v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash          TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  phone_e164          TEXT NOT NULL UNIQUE,
  phone_display       TEXT NOT NULL,
  business            TEXT,
  marketing_consent   INTEGER NOT NULL DEFAULT 0,
  consent_version     TEXT,
  consent_at          TEXT,
  registered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  status              TEXT NOT NULL DEFAULT 'registered',
  score               INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL,
  plan_json           TEXT NOT NULL,
  answers_json        TEXT NOT NULL DEFAULT '[]',
  entry_code          TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS draws (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  entry_code      TEXT NOT NULL,
  pool_size       INTEGER NOT NULL,
  drawn_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_status ON participants(status);
`;

function now() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newEntryCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `OTR-${s}`;
}

// ---- Validation -----------------------------------------------------------

class ValidationError extends Error {
  constructor(fields) {
    super('Please fix the highlighted fields.');
    this.fields = fields;
  }
}

/**
 * Accepts US/Canada numbers (10 digits, optional leading 1) and international
 * numbers written with a leading "+" (8–15 digits, E.164).
 */
function normalizePhone(raw) {
  const input = String(raw || '').trim();
  if (!/^[+\d\s().\-]{7,25}$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+')) {
    if (digits.length < 8 || digits.length > 15 || digits[0] === '0') return null;
    if (digits[0] === '1') return normalizePhone(digits.slice(1));
    return { e164: `+${digits}`, display: `+${digits}` };
  }
  let national = digits;
  if (national.length === 11 && national[0] === '1') national = national.slice(1);
  if (national.length !== 10) return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return {
    e164: `+1${national}`,
    display: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
  };
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

function validateRegistration(body) {
  const fields = {};
  const fullName = cleanText(body.fullName, 80);
  const business = cleanText(body.business, 100);
  const phone = normalizePhone(body.phone);

  if (!fullName) fields.fullName = 'Please enter your name.';
  else if (fullName.length < 2 || !/\p{L}/u.test(fullName)) fields.fullName = 'Please enter your full name.';
  else if (fullName.length > 80) fields.fullName = 'Name is too long.';

  if (!String(body.phone || '').trim()) fields.phone = 'Please enter your phone number.';
  else if (!phone) fields.phone = 'Enter a valid phone number, e.g. (555) 123-4567.';

  if (business.length > 100) fields.business = 'Business name is too long.';

  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { fullName, business: business || null, phone, consent: body.consent === true };
}

// ---- Store ----------------------------------------------------------------

function openStore(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'otter-trivia.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const stmt = {
    byToken: db.prepare('SELECT * FROM participants WHERE token_hash = ?'),
    byPhone: db.prepare('SELECT * FROM participants WHERE phone_e164 = ?'),
    byId: db.prepare('SELECT * FROM participants WHERE id = ?'),
    codeExists: db.prepare('SELECT 1 FROM participants WHERE entry_code = ?'),
    insert: db.prepare(`INSERT INTO participants
      (token_hash, full_name, phone_e164, phone_display, business, marketing_consent, consent_version,
       consent_at, registered_at, updated_at, status, total, plan_json, entry_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?)`),
    resume: db.prepare(`UPDATE participants SET token_hash = ?, full_name = ?, business = ?,
      marketing_consent = ?, consent_version = ?, consent_at = ?, updated_at = ? WHERE id = ?`),
    saveAnswers: db.prepare(`UPDATE participants SET answers_json = ?, score = ?, status = ?,
      completed_at = ?, updated_at = ? WHERE id = ?`),
    all: db.prepare('SELECT * FROM participants ORDER BY registered_at DESC, id DESC'),
    del: db.prepare('DELETE FROM participants WHERE id = ?'),
    draws: db.prepare(`SELECT d.*, p.full_name, p.phone_e164 FROM draws d
      LEFT JOIN participants p ON p.id = d.participant_id ORDER BY d.id DESC`),
    insertDraw: db.prepare('INSERT INTO draws (participant_id, entry_code, pool_size, drawn_at) VALUES (?, ?, ?, ?)'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function uniqueCode() {
    for (;;) {
      const code = newEntryCode();
      if (!stmt.codeExists.get(code)) return code;
    }
  }

  function buildPlan() {
    return shuffle(QUESTIONS).map((q) => ({ q: q.id, c: shuffle(q.choices.map((c) => c.id)) }));
  }

  /**
   * Registers a participant, or lets an unfinished participant with the same
   * phone number resume. Returns { token, participant, resumed }.
   * Throws { code: 'already_played' } if that phone already finished.
   */
  function register(input) {
    const token = crypto.randomBytes(24).toString('base64url');
    const ts = now();
    const consent = input.consent ? 1 : 0;
    return tx(() => {
      const existing = stmt.byPhone.get(input.phone.e164);
      if (existing) {
        if (existing.status === 'completed') {
          const err = new Error('This phone number has already played.');
          err.code = 'already_played';
          throw err;
        }
        stmt.resume.run(hashToken(token), input.fullName, input.business, consent,
          CONSENT_VERSION, consent ? ts : null, ts, existing.id);
        return { token, participant: stmt.byId.get(existing.id), resumed: true };
      }
      const plan = buildPlan();
      const r = stmt.insert.run(hashToken(token), input.fullName, input.phone.e164, input.phone.display,
        input.business, consent, CONSENT_VERSION, consent ? ts : null, ts, ts,
        plan.length, JSON.stringify(plan), uniqueCode());
      return { token, participant: stmt.byId.get(r.lastInsertRowid), resumed: false };
    });
  }

  function findByToken(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    return stmt.byToken.get(hashToken(token)) || null;
  }

  function feedbackFor(qid, answer) {
    const q = BY_ID.get(qid);
    const correct = q.choices.find((c) => c.correct);
    return {
      choiceId: answer.choice,
      correct: answer.choice === correct.id,
      correctChoiceId: correct.id,
      explanation: q.explanation,
    };
  }

  function result(p, eventCfg) {
    if (p.status !== 'completed') return null;
    const eligible = p.score >= eventCfg.raffleMinScore;
    return { score: p.score, total: p.total, raffleEligible: eligible, entryCode: eligible ? p.entry_code : null };
  }

  /** The participant's view of their quiz, without revealing unanswered answers. */
  function quizState(p, eventCfg) {
    const plan = JSON.parse(p.plan_json);
    const answers = JSON.parse(p.answers_json);
    return {
      firstName: p.full_name.split(' ')[0],
      status: p.status,
      score: p.score,
      total: p.total,
      questions: plan.map((item, index) => {
        const q = BY_ID.get(item.q);
        return {
          index,
          prompt: q.prompt,
          choices: item.c.map((cid) => ({ id: cid, text: q.choices.find((c) => c.id === cid).text })),
        };
      }),
      answers: answers.map((a, index) => ({ index, ...feedbackFor(plan[index].q, a) })),
      result: result(p, eventCfg),
    };
  }

  /**
   * Records an answer. Answers must arrive in order; re-sending an answer for
   * a question already answered returns the stored outcome (safe for retries
   * and double taps) instead of changing it.
   */
  function answer(p, index, choiceId, eventCfg) {
    return tx(() => {
      const fresh = stmt.byId.get(p.id);
      const plan = JSON.parse(fresh.plan_json);
      const answers = JSON.parse(fresh.answers_json);
      if (!Number.isInteger(index) || index < 0 || index >= plan.length) {
        const err = new Error('Unknown question.');
        err.code = 'bad_question';
        throw err;
      }
      if (index < answers.length) {
        return { ...feedbackFor(plan[index].q, answers[index]), duplicate: true, ...progress(fresh, answers) };
      }
      if (index > answers.length) {
        const err = new Error('Please answer the questions in order.');
        err.code = 'out_of_order';
        throw err;
      }
      if (!plan[index].c.includes(choiceId)) {
        const err = new Error('Unknown answer choice.');
        err.code = 'bad_choice';
        throw err;
      }
      const entry = { choice: choiceId, at: now() };
      answers.push(entry);
      const fb = feedbackFor(plan[index].q, entry);
      const score = answers.reduce((n, a, i) => n + (feedbackFor(plan[i].q, a).correct ? 1 : 0), 0);
      const done = answers.length === plan.length;
      const ts = now();
      stmt.saveAnswers.run(JSON.stringify(answers), score, done ? 'completed' : 'in_progress',
        done ? ts : null, ts, fresh.id);
      const updated = stmt.byId.get(fresh.id);
      return { ...fb, duplicate: false, ...progress(updated, answers), result: result(updated, eventCfg) };
    });
  }

  function progress(p, answers) {
    return { score: p.score, answered: answers.length, total: p.total, completed: p.status === 'completed' };
  }

  // ---- Admin ----

  function adminRow(p, eventCfg) {
    const answered = JSON.parse(p.answers_json).length;
    const eligible = p.status === 'completed' && p.score >= eventCfg.raffleMinScore;
    return {
      id: p.id,
      fullName: p.full_name,
      phone: p.phone_e164,
      phoneDisplay: p.phone_display,
      business: p.business || '',
      marketingConsent: !!p.marketing_consent,
      consentVersion: p.marketing_consent ? p.consent_version : null,
      consentAt: p.consent_at,
      registeredAt: p.registered_at,
      completedAt: p.completed_at,
      status: p.status,
      answered,
      score: p.score,
      total: p.total,
      raffleEligible: eligible,
      entryCode: p.entry_code,
    };
  }

  function listParticipants(eventCfg) {
    return stmt.all.all().map((p) => adminRow(p, eventCfg));
  }

  function listDraws() {
    return stmt.draws.all().map((d) => ({
      id: d.id,
      participantId: d.participant_id,
      // Name and phone are read live so deleting a participant also removes them here.
      fullName: d.full_name ?? '(deleted)',
      phone: d.phone_e164 ?? '',
      entryCode: d.entry_code,
      poolSize: d.pool_size,
      drawnAt: d.drawn_at,
    }));
  }

  /**
   * Draws one winner uniformly at random (crypto.randomInt) from everyone who
   * completed the quiz with the minimum score and hasn't already been drawn.
   */
  function drawWinner(eventCfg) {
    return tx(() => {
      const drawn = new Set(stmt.draws.all().map((d) => d.participant_id));
      const pool = stmt.all
        .all()
        .filter((p) => p.status === 'completed' && p.score >= eventCfg.raffleMinScore && !drawn.has(p.id))
        .sort((a, b) => a.id - b.id);
      if (!pool.length) {
        const err = new Error('There are no eligible raffle entries left to draw from.');
        err.code = 'empty_pool';
        throw err;
      }
      const w = pool[crypto.randomInt(pool.length)];
      const ts = now();
      stmt.insertDraw.run(w.id, w.entry_code, pool.length, ts);
      return { winner: adminRow(w, eventCfg), poolSize: pool.length, drawnAt: ts };
    });
  }

  function deleteParticipant(id) {
    return stmt.del.run(id).changes > 0;
  }

  return {
    db,
    register,
    findByToken,
    quizState,
    answer,
    listParticipants,
    listDraws,
    drawWinner,
    deleteParticipant,
    close: () => db.close(),
  };
}

module.exports = { openStore, validateRegistration, normalizePhone, ValidationError, CONSENT_TEXT, CONSENT_VERSION };
