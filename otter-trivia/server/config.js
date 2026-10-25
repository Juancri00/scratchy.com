'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';

  let adminPassword = env.ADMIN_PASSWORD || '';
  let generatedPassword = false;
  if (!adminPassword) {
    if (production) {
      throw new Error('ADMIN_PASSWORD must be set in production (use 12+ characters).');
    }
    adminPassword = crypto.randomBytes(9).toString('base64url');
    generatedPassword = true;
  }
  if (production && adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters in production.');
  }

  let sessionSecret = env.SESSION_SECRET || '';
  let generatedSecret = false;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    generatedSecret = true;
  }

  const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

  return {
    production,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    publicUrl,
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === 'true' : production,
    adminPassword,
    generatedPassword,
    sessionSecret,
    generatedSecret,
    sessionHours: int(env.ADMIN_SESSION_HOURS, 12),
    event: {
      eventName: env.EVENT_NAME || 'Restaurant Trivia Challenge',
      prizeName: env.PRIZE_NAME || 'an exclusive Otter prize',
      drawInfo: env.DRAW_INFO || 'One winner will be drawn at random at the Otter booth at the end of the event.',
      winnerContact: env.WINNER_CONTACT || 'We will call or text the winner at the phone number they entered. You do not need to be present to win.',
      raffleMinScore: Math.max(0, int(env.RAFFLE_MIN_SCORE, 0)),
      boothCta: env.BOOTH_CTA || 'Stop by the Otter booth for a quick demo.',
      rulesExtra: env.RULES_EXTRA || '',
    },
  };
}

module.exports = { loadConfig };
