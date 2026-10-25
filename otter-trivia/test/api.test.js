'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server/index');
const { normalizePhone } = require('../server/store');
const { csvCell } = require('../server/app');
const { QUESTIONS, BY_ID } = require('../server/questions');

const PASSWORD = 'test-admin-password-123';
let base;
let app;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otter-trivia-test-'));
  app = start({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(64), DATA_DIR: dataDir, PORT: '0' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => {
  app.server.close();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, p, { body, token, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

function correctChoice(prompt) {
  return QUESTIONS.find((q) => q.prompt === prompt).choices.find((c) => c.correct).id;
}

async function playThrough(token, quiz, { wrong = 0 } = {}) {
  let last;
  for (const q of quiz.questions) {
    const right = correctChoice(q.prompt);
    const choice = q.index < wrong ? q.choices.find((c) => c.id !== right).id : right;
    last = await call('POST', '/api/answer', { token, body: { index: q.index, choiceId: choice } });
    assert.equal(last.status, 200);
  }
  return last.json;
}

async function login() {
  const r = await call('POST', '/api/admin/login', { body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('phone normalization', () => {
  assert.equal(normalizePhone('(415) 555-2671').e164, '+14155552671');
  assert.equal(normalizePhone('1-415-555-2671').e164, '+14155552671');
  assert.equal(normalizePhone('+1 415 555 2671').e164, '+14155552671');
  assert.equal(normalizePhone('+44 20 7946 0958').e164, '+442079460958');
  assert.equal(normalizePhone('555-1234'), null);
  assert.equal(normalizePhone('(015) 555-2671'), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('+0123456789'), null);
});

test('csv cells neutralise formulas and quote properly', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+14155552671'), "'+14155552671");
  assert.equal(csvCell('Joe, Inc'), '"Joe, Inc"');
  assert.equal(csvCell(null), '');
});

test('every question has exactly one correct answer', () => {
  assert.equal(QUESTIONS.length, 8);
  for (const q of QUESTIONS) assert.equal(q.choices.filter((c) => c.correct).length, 1);
});

test('static pages and public config are served with security headers', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Start the Trivia Challenge/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.raffleMinScore, 0);
  assert.equal((await call('GET', '/../server/config.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server/config.js')).status, 404);
  const qr = await call('GET', '/qr.svg');
  assert.equal(qr.status, 200);
  assert.match(qr.text, /^<svg/);
});

test('registration validates required fields and phone format', async () => {
  let r = await call('POST', '/api/register', { body: { fullName: '', phone: '' } });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.fullName);
  assert.ok(r.json.fields.phone);
  r = await call('POST', '/api/register', { body: { fullName: 'Ana Ruiz', phone: '12345' } });
  assert.equal(r.status, 422);
  assert.match(r.json.fields.phone, /valid phone/);
  r = await call('POST', '/api/register', { body: 'nope', headers: {} });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/register', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
});

test('full game flow: register, randomized quiz, feedback, scoring, results', async () => {
  const reg = await call('POST', '/api/register', {
    body: { fullName: 'Maria Lopez', phone: '(415) 555-0101', business: 'Taqueria Lopez', consent: true },
  });
  assert.equal(reg.status, 201);
  const { token, quiz } = reg.json;
  assert.equal(quiz.questions.length, 8);
  assert.equal(quiz.answers.length, 0);
  // No correct answers leak before answering.
  assert.doesNotMatch(JSON.stringify(quiz), /correct/i);
  for (const q of quiz.questions) assert.equal(q.choices.length, 3);

  // Out-of-order answers rejected.
  const skip = await call('POST', '/api/answer', { token, body: { index: 3, choiceId: 'a' } });
  assert.equal(skip.status, 400);

  // First answer wrong on purpose, check feedback.
  const q0 = quiz.questions[0];
  const right = correctChoice(q0.prompt);
  const wrongId = q0.choices.find((c) => c.id !== right).id;
  const a0 = await call('POST', '/api/answer', { token, body: { index: 0, choiceId: wrongId } });
  assert.equal(a0.json.correct, false);
  assert.equal(a0.json.correctChoiceId, right);
  assert.ok(a0.json.explanation.length > 10);
  assert.equal(a0.json.score, 0);

  // Double tap / retry can't change the answer.
  const again = await call('POST', '/api/answer', { token, body: { index: 0, choiceId: right } });
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.correct, false);

  // Resume state includes the answer.
  const state = await call('GET', '/api/quiz', { token });
  assert.equal(state.json.answers.length, 1);
  assert.equal(state.json.status, 'in_progress');

  let last;
  for (const q of quiz.questions.slice(1)) {
    last = await call('POST', '/api/answer', { token, body: { index: q.index, choiceId: correctChoice(q.prompt) } });
  }
  assert.equal(last.json.completed, true);
  assert.equal(last.json.result.score, 7);
  assert.equal(last.json.result.total, 8);
  assert.equal(last.json.result.raffleEligible, true);
  assert.match(last.json.result.entryCode, /^OTR-[A-Z2-9]{6}$/);

  const done = await call('GET', '/api/quiz', { token });
  assert.equal(done.json.status, 'completed');
  assert.equal(done.json.result.score, 7);
});

test('question and choice order are randomized per participant', async () => {
  const orders = new Set();
  for (let i = 0; i < 6; i++) {
    const r = await call('POST', '/api/register', { body: { fullName: `Shuffle Tester ${i}`, phone: `+1 (212) 555-01${10 + i}` } });
    orders.add(JSON.stringify(r.json.quiz.questions.map((q) => [q.prompt, q.choices.map((c) => c.id)])));
  }
  assert.ok(orders.size > 1, 'expected different orders across participants');
  // Answer mapping stays correct regardless of order (checked via playThrough in other tests).
  for (const q of QUESTIONS) assert.ok(BY_ID.get(q.id));
});

test('duplicates: same phone resumes if unfinished, blocked once completed', async () => {
  const first = await call('POST', '/api/register', { body: { fullName: 'Dup Person', phone: '312-555-0199' } });
  assert.equal(first.status, 201);
  await call('POST', '/api/answer', {
    token: first.json.token,
    body: { index: 0, choiceId: correctChoice(first.json.quiz.questions[0].prompt) },
  });
  const resume = await call('POST', '/api/register', { body: { fullName: 'Dup Person', phone: '+1 312 555 0199' } });
  assert.equal(resume.status, 200);
  assert.equal(resume.json.resumed, true);
  assert.equal(resume.json.quiz.answers.length, 1);
  // Old token no longer valid after re-registration.
  assert.equal((await call('GET', '/api/quiz', { token: first.json.token })).status, 401);

  await playThrough(resume.json.token, resume.json.quiz);
  const blocked = await call('POST', '/api/register', { body: { fullName: 'Dup Person', phone: '(312) 555-0199' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'already_played');
});

test('invalid participant token is rejected', async () => {
  assert.equal((await call('GET', '/api/quiz')).status, 401);
  assert.equal((await call('GET', '/api/quiz', { token: 'bogus' })).status, 401);
  assert.equal((await call('POST', '/api/answer', { token: 'bogus', body: { index: 0, choiceId: 'a' } })).status, 401);
});

test('admin endpoints require authentication', async () => {
  assert.equal((await call('GET', '/api/admin/participants')).status, 401);
  assert.equal((await call('GET', '/api/admin/export.csv')).status, 401);
  assert.equal((await call('POST', '/api/admin/draw', { body: {} })).status, 401);
  assert.equal((await call('DELETE', '/api/admin/participants/1')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { body: { password: 'wrong' } })).status, 401);
  const forged = 'otter_admin=eyJleHAiOjk5OTk5OTk5OTk5OTl9.forged';
  assert.equal((await call('GET', '/api/admin/participants', { cookie: forged })).status, 401);
});

test('admin dashboard data, search fields, CSV export, raffle draw, delete', async () => {
  const cookie = await login();
  assert.match((await call('GET', '/api/admin/session', { cookie })).json.authenticated.toString(), /true/);

  const list = await call('GET', '/api/admin/participants', { cookie });
  assert.equal(list.status, 200);
  const maria = list.json.participants.find((p) => p.fullName === 'Maria Lopez');
  assert.equal(maria.phone, '+14155550101');
  assert.equal(maria.business, 'Taqueria Lopez');
  assert.equal(maria.marketingConsent, true);
  assert.equal(maria.status, 'completed');
  assert.equal(maria.score, 7);
  assert.equal(maria.raffleEligible, true);
  assert.ok(maria.registeredAt);
  const shuffle = list.json.participants.find((p) => p.fullName === 'Shuffle Tester 0');
  assert.equal(shuffle.marketingConsent, false);
  assert.equal(shuffle.raffleEligible, false);
  assert.equal(list.json.stats.completed, 2);
  assert.equal(list.json.stats.raffleEntries, 2);

  const csv = await call('GET', '/api/admin/export.csv', { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="otter-trivia-participants-/);
  const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(lines[0], /^Full name,Phone,Restaurant \/ business,Marketing consent/);
  assert.equal(lines.length, list.json.participants.length + 1);
  assert.ok(lines.some((l) => l.startsWith("Maria Lopez,'+14155550101,Taqueria Lopez,Yes")));

  // Draws pick only eligible, never repeat, then run out.
  const eligible = new Set(list.json.participants.filter((p) => p.raffleEligible).map((p) => p.id));
  const d1 = await call('POST', '/api/admin/draw', { cookie, body: {} });
  const d2 = await call('POST', '/api/admin/draw', { cookie, body: {} });
  assert.equal(d1.status, 200);
  assert.equal(d1.json.poolSize, 2);
  assert.equal(d2.json.poolSize, 1);
  assert.ok(eligible.has(d1.json.winner.id) && eligible.has(d2.json.winner.id));
  assert.notEqual(d1.json.winner.id, d2.json.winner.id);
  assert.equal((await call('POST', '/api/admin/draw', { cookie, body: {} })).status, 409);

  // Cross-site mutation blocked even with a cookie.
  const xs = await call('POST', '/api/admin/draw', { cookie, body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(xs.status, 403);

  const del = await call('DELETE', `/api/admin/participants/${shuffle.id}`, { cookie });
  assert.equal(del.status, 200);
  const after = await call('GET', '/api/admin/participants', { cookie });
  assert.ok(!after.json.participants.some((p) => p.id === shuffle.id));
  // Deleting a drawn winner scrubs their details from the draw history too.
  await call('DELETE', `/api/admin/participants/${d1.json.winner.id}`, { cookie });
  const hist = await call('GET', '/api/admin/participants', { cookie });
  assert.equal(hist.json.draws.find((d) => d.id && d.entryCode === d1.json.winner.entryCode).fullName, '(deleted)');
});

test('data persists across a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otter-persist-'));
  const env = { ADMIN_PASSWORD: PASSWORD, DATA_DIR: dir };
  const a = start(env);
  const reg = a.store.register({ fullName: 'Persist Me', business: null, consent: false, phone: normalizePhone('6175550123') });
  a.store.close();
  const b = start(env);
  const rows = b.store.listParticipants({ raffleMinScore: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, 'Persist Me');
  assert.ok(b.store.findByToken(reg.token));
  b.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('raffle minimum score is configurable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otter-min-'));
  const s = start({ ADMIN_PASSWORD: PASSWORD, DATA_DIR: dir, RAFFLE_MIN_SCORE: '6' });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.server.address().port}`;
  const reg = await (await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Low Scorer', phone: '7185550142' }),
  })).json();
  let last;
  for (const q of reg.quiz.questions) {
    const right = correctChoice(q.prompt);
    const choice = q.index < 4 ? q.choices.find((c) => c.id !== right).id : right;
    last = await (await fetch(`${url}/api/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ index: q.index, choiceId: choice }),
    })).json();
  }
  assert.equal(last.result.score, 4);
  assert.equal(last.result.raffleEligible, false);
  assert.equal(last.result.entryCode, null);
  s.server.close();
  s.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('production refuses to start without a strong admin password', () => {
  assert.throws(() => start({ NODE_ENV: 'production' }), /ADMIN_PASSWORD/);
  assert.throws(() => start({ NODE_ENV: 'production', ADMIN_PASSWORD: 'short' }), /12 characters/);
});

test('booth QR codes decode back to the exact URL (matrix and SVG output)', () => {
  const { qrMatrix, qrSvg } = require('../server/qr');
  const { decode } = require('./qr-decode');
  const urls = [
    'https://otter-trivia.onrender.com/',
    'https://trivia.example.com/',
    'https://otter-restaurant-trivia-challenge-booth-2026.up.railway.app/',
    'https://a.co/',
  ];
  for (const url of urls) {
    assert.equal(decode(qrMatrix(url)), url);
    // Rebuild the matrix from the SVG path to check the rendered output too.
    const svg = qrSvg(url, { margin: 4 });
    const n = Number(svg.match(/viewBox="0 0 (\d+)/)[1]) - 8;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1/g)) m[y - 4][x - 4] = true;
    assert.equal(decode(m), url);
  }
});
