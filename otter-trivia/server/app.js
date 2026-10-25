'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateRegistration, ValidationError, CONSENT_TEXT } = require('./store');
const { qrSvg } = require('./qr');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 10 * 1024;
const COOKIE = 'otter_admin';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Fixed-window in-memory rate limiter, keyed per client IP.
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || t - h.start > windowMs) {
      h = { start: t, count: 0 };
      hits.set(key, h);
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
      }
    }
    h.count++;
    return h.count <= limit;
  };
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp({ config, store }) {
  const loginLimit = rateLimiter(10, 15 * 60 * 1000);
  const registerLimit = rateLimiter(120, 60 * 1000);
  const answerLimit = rateLimiter(600, 60 * 1000);

  // ---- helpers ----

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isHttps(req) {
    if (req.socket.encrypted) return true;
    return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  }

  function origin(req) {
    if (config.publicUrl) return config.publicUrl;
    const host = String(req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host || 'localhost');
    return `${isHttps(req) ? 'https' : 'http'}://${host.split(',')[0].trim()}`;
  }

  function securityHeaders(req, res) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }

  function json(res, status, body, headers = {}) {
    send(res, status, body, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
  }

  async function readJson(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  }

  function participantOr401(req) {
    const p = store.findByToken(bearer(req));
    if (!p) throw new HttpError(401, 'Your session has expired. Please register again.', { code: 'no_session' });
    return p;
  }

  // ---- admin session (HMAC-signed cookie) ----

  function sign(payload) {
    return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  }

  function makeSession() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + config.sessionHours * 3600e3, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  function isAdmin(req) {
    const value = readCookie(req, COOKIE);
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return false;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
    } catch {
      return false;
    }
  }

  function cookieHeader(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  function passwordMatches(given) {
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) throw new HttpError(401, 'Admin login required.');
    // Cookie is SameSite=Strict; also reject cross-site mutations outright.
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
      throw new HttpError(403, 'Cross-site request blocked.');
    }
  }

  // ---- static files ----

  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    if (rel.startsWith('/admin')) headers['X-Robots-Tag'] = 'noindex, nofollow';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }

  // ---- routes ----

  function publicConfig() {
    return { ...config.event, consentText: CONSENT_TEXT, questionCount: 8 };
  }

  const routes = {
    'GET /api/health': (req, res) => json(res, 200, { ok: true }),

    'GET /api/config': (req, res) => json(res, 200, publicConfig()),

    'POST /api/register': async (req, res) => {
      if (!registerLimit(clientIp(req))) throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
      const body = await readJson(req);
      const input = validateRegistration(body);
      try {
        const { token, participant, resumed } = store.register(input);
        json(res, resumed ? 200 : 201, { token, resumed, quiz: store.quizState(participant, config.event) });
      } catch (err) {
        if (err.code === 'already_played') {
          throw new HttpError(409, 'Looks like this phone number has already played. It’s one entry per person, but come say hi at the Otter booth!', { code: 'already_played' });
        }
        throw err;
      }
    },

    'GET /api/quiz': (req, res) => {
      json(res, 200, store.quizState(participantOr401(req), config.event));
    },

    'POST /api/answer': async (req, res) => {
      if (!answerLimit(clientIp(req))) throw new HttpError(429, 'Slow down a little and try again.');
      const p = participantOr401(req);
      const body = await readJson(req);
      try {
        json(res, 200, store.answer(p, body.index, String(body.choiceId || ''), config.event));
      } catch (err) {
        if (['bad_question', 'out_of_order', 'bad_choice'].includes(err.code)) throw new HttpError(400, err.message, { code: err.code });
        throw err;
      }
    },

    // Booth QR code for the participant landing page. Public on purpose: it
    // only encodes this app's own public URL, so it can be printed from any device.
    'GET /qr.svg': (req, res) => {
      send(res, 200, qrSvg(`${origin(req)}/`), 'image/svg+xml', { 'Cache-Control': 'no-cache' });
    },

    'GET /api/admin/session': (req, res) => json(res, 200, { authenticated: isAdmin(req) }),

    'POST /api/admin/login': async (req, res) => {
      if (!loginLimit(clientIp(req))) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
      const body = await readJson(req);
      if (!passwordMatches(body.password)) throw new HttpError(401, 'Incorrect password.');
      json(res, 200, { authenticated: true }, { 'Set-Cookie': cookieHeader(req, makeSession(), config.sessionHours * 3600) });
    },

    'POST /api/admin/logout': (req, res) => {
      json(res, 200, { authenticated: false }, { 'Set-Cookie': cookieHeader(req, '', 0) });
    },

    'GET /api/admin/participants': (req, res) => {
      requireAdmin(req);
      const participants = store.listParticipants(config.event);
      const completed = participants.filter((p) => p.status === 'completed');
      json(res, 200, {
        participants,
        draws: store.listDraws(),
        stats: {
          registered: participants.length,
          completed: completed.length,
          raffleEntries: participants.filter((p) => p.raffleEligible).length,
          marketingOptIns: participants.filter((p) => p.marketingConsent).length,
          averageScore: completed.length ? completed.reduce((n, p) => n + p.score, 0) / completed.length : null,
        },
        event: config.event,
        publicUrl: origin(req),
      });
    },

    'GET /api/admin/export.csv': (req, res) => {
      requireAdmin(req);
      const cols = [
        ['Full name', (p) => p.fullName],
        ['Phone', (p) => p.phone],
        ['Restaurant / business', (p) => p.business],
        ['Marketing consent', (p) => (p.marketingConsent ? 'Yes' : 'No')],
        ['Consent version', (p) => p.consentVersion],
        ['Consent timestamp (UTC)', (p) => p.consentAt],
        ['Registered (UTC)', (p) => p.registeredAt],
        ['Completed (UTC)', (p) => p.completedAt],
        ['Completion status', (p) => p.status],
        ['Questions answered', (p) => p.answered],
        ['Score', (p) => p.score],
        ['Total questions', (p) => p.total],
        ['Raffle entry', (p) => (p.raffleEligible ? 'Yes' : 'No')],
        ['Entry code', (p) => p.entryCode],
      ];
      const lines = [cols.map((c) => csvCell(c[0])).join(',')];
      for (const p of store.listParticipants(config.event)) lines.push(cols.map((c) => csvCell(c[1](p))).join(','));
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      send(res, 200, '﻿' + lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="otter-trivia-participants-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      });
    },

    'POST /api/admin/draw': async (req, res) => {
      requireAdmin(req);
      try {
        json(res, 200, store.drawWinner(config.event));
      } catch (err) {
        if (err.code === 'empty_pool') throw new HttpError(409, err.message);
        throw err;
      }
    },
  };

  async function handle(req, res) {
    securityHeaders(req, res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      const route = routes[`${req.method} ${pathname}`];
      if (route) return await route(req, res);

      const del = pathname.match(/^\/api\/admin\/participants\/(\d+)$/);
      if (del && req.method === 'DELETE') {
        requireAdmin(req);
        if (!store.deleteParticipant(Number(del[1]))) throw new HttpError(404, 'Participant not found.');
        return json(res, 200, { deleted: true });
      }

      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (pathname === '/admin') return send(res, 301, '', 'text/plain', { Location: '/admin/' });
      if (serveStatic(req, res, pathname)) return;
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (err) {
      if (err instanceof ValidationError) return json(res, 422, { error: err.message, fields: err.fields });
      if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof URIError) return json(res, 400, { error: 'Bad request.' });
      console.error(err);
      json(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  }

  return handle;
}

module.exports = { createApp, csvCell };
