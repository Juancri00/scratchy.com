// End-to-end browser test: open link → register → play all 8 → results →
// admin login → search → CSV export → raffle draw. Runs on emulated iPhone
// and Android viewports. Usage: npm run test:e2e [-- --shots <dir>]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const { start } = require('../server/index.js');
const { QUESTIONS } = require('../server/questions.js');

const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > -1 ? process.argv[shotsIdx + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const snap = async (page, name) => {
  if (!shots) return;
  await page.waitForTimeout(450); // let entrance animations settle
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const PASSWORD = 'e2e-admin-password-xyz';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otter-e2e-'));
const app = start({ ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, PRIZE_NAME: 'a $250 restaurant supply gift card' });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const answerFor = (prompt) => QUESTIONS.find((q) => q.prompt === prompt).choices.find((c) => c.correct).text;

const browser = await chromium.launch();
const errors = [];

async function playOnDevice(deviceName, player, { wrongFirst }) {
  const ctx = await browser.newContext({ ...devices[deviceName] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${deviceName}: ${e.message}`));
  // The 409 is the expected response to the deliberate replay attempt below.
  page.on('console', (m) => m.type() === 'error' && !/status of 409/.test(m.text()) && errors.push(`${deviceName}: ${m.text()}`));
  const tag = deviceName.replace(/\W+/g, '-').toLowerCase();

  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Start the Trivia Challenge' }).waitFor();
  assert.equal(await page.locator('#consent').isChecked(), false, 'consent unchecked by default');
  await snap(page, `${tag}-1-register`);

  // Validation
  await page.getByRole('button', { name: 'Start the Trivia Challenge' }).click();
  await page.locator('#fullName-error', { hasText: 'Please enter your name.' }).waitFor();
  await page.fill('#fullName', player.name);
  await page.fill('#phone', '555-12');
  await page.getByRole('button', { name: 'Start the Trivia Challenge' }).click();
  await page.locator('#phone-error', { hasText: 'valid phone' }).waitFor();
  await snap(page, `${tag}-2-validation`);

  await page.fill('#phone', player.phone);
  await page.fill('#business', player.business);
  if (player.consent) await page.check('#consent');
  await page.getByRole('button', { name: 'Start the Trivia Challenge' }).click();

  let expected = 0;
  for (let i = 0; i < 8; i++) {
    await page.locator('#qCounter', { hasText: `Question ${i + 1} of 8` }).waitFor();
    const prompt = await page.locator('#questionText').innerText();
    const right = answerFor(prompt);
    const choices = page.locator('.choice');
    assert.equal(await choices.count(), 3);
    let target;
    if (wrongFirst && i === 0) {
      target = choices.filter({ hasNotText: right }).first();
    } else {
      target = choices.filter({ hasText: right });
      expected++;
    }
    if (i === 0) await snap(page, `${tag}-3-question`);
    await target.click();
    await page.locator('#feedback').waitFor({ state: 'visible' });
    if (wrongFirst && i === 0) {
      await page.locator('#feedbackAnswer', { hasText: `Correct answer: ${right}` }).waitFor();
      await snap(page, `${tag}-4-feedback-wrong`);
    } else if (i === 1) {
      await snap(page, `${tag}-5-feedback-right`);
    }
    assert.equal(await page.locator('#scoreValue').innerText(), String(expected));
    if (i === 3) {
      // Reload mid-game: progress must resume from the server.
      await page.reload();
      await page.locator('#qCounter', { hasText: 'Question 5 of 8' }).waitFor();
      continue;
    }
    await page.locator('#nextBtn').click();
  }

  await page.locator('[data-screen="results"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#finalScore').innerText(), String(expected));
  const code = await page.locator('#entryCode').innerText();
  assert.match(code, /^OTR-[A-Z2-9]{6}$/);
  assert.match(await page.locator('#prizeMain').innerText(), /\$250 restaurant supply gift card/);
  await snap(page, `${tag}-6-results`);

  // No horizontal overflow on phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'page should not scroll horizontally');

  // Same phone can't play twice.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'New player on this device' }).click();
  await page.fill('#fullName', player.name);
  await page.fill('#phone', player.phone);
  await page.getByRole('button', { name: 'Start the Trivia Challenge' }).click();
  await page.locator('[data-screen="played"]').waitFor({ state: 'visible' });
  await snap(page, `${tag}-7-already-played`);

  // Rules dialog explains the raffle.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /Raffle rules/ }).click();
  await page.locator('#rulesList', { hasText: 'Not every participant wins' }).waitFor();
  await snap(page, `${tag}-8-rules`);
  await ctx.close();
  return { code, score: expected };
}

const iphone = await playOnDevice('iPhone 13', { name: 'Jamie Chen', phone: '(415) 555-0142', business: 'Golden Wok', consent: true }, { wrongFirst: true });
const pixel = await playOnDevice('Pixel 7', { name: 'Sam Patel', phone: '+1 646 555 0177', business: '', consent: false }, { wrongFirst: false });
assert.equal(iphone.score, 7);
assert.equal(pixel.score, 8);

// ---- Admin ----
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`admin: ${e.message}`));
await page.goto(`${base}/admin/`);
await page.locator('#password').waitFor();
await page.fill('#password', 'nope');
await page.getByRole('button', { name: 'Log in' }).click();
await page.locator('#loginError', { hasText: 'Incorrect password' }).waitFor();
await snap(page, 'admin-1-login');
await page.fill('#password', PASSWORD);
await page.getByRole('button', { name: 'Log in' }).click();
await page.locator('#rows tr', { hasText: 'Jamie Chen' }).waitFor();
assert.equal(await page.locator('#rows tr').count(), 2);
const jamie = await page.locator('#rows tr', { hasText: 'Jamie Chen' }).innerText();
assert.match(jamie, /\(415\) 555-0142/);
assert.match(jamie, /Golden Wok/);
assert.match(jamie, /Yes/);
assert.match(jamie, /7\/8/);
assert.match(jamie, new RegExp(iphone.code));
await page.locator('#qrWarn').waitFor({ state: 'visible' }); // local URL → warning shown
await snap(page, 'admin-2-dashboard');

await page.fill('#search', 'golden');
await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
await page.fill('#search', '');
await page.selectOption('#filter', 'consent');
await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
await page.selectOption('#filter', 'all');

const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
const csvPath = path.join(shots || dataDir, 'export.csv');
await download.saveAs(csvPath);
const csv = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').trim().split('\r\n');
assert.equal(csv.length, 3);
assert.match(csv[0], /Full name,Phone,Restaurant \/ business,Marketing consent/);
assert.ok(csv.some((l) => l.startsWith("Jamie Chen,'+14155550142,Golden Wok,Yes")));
assert.ok(csv.some((l) => l.startsWith("Sam Patel,'+16465550177,,No")));

page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Draw a winner' }).click();
await page.locator('#winnerBox').waitFor({ state: 'visible' });
const winner = await page.locator('#winnerBox .w-name').innerText();
assert.ok(['Jamie Chen', 'Sam Patel'].includes(winner));
await page.locator('#poolCount', { hasText: '1' }).waitFor();
await snap(page, 'admin-3-winner');

await page.goto(`${base}/sign.html`);
await page.waitForLoadState('networkidle');
await snap(page, 'booth-sign');

await ctx.close();
await browser.close();
app.server.close();
app.store.close();
fs.rmSync(dataDir, { recursive: true, force: true });

if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`E2E passed: iPhone score ${iphone.score}/8 (${iphone.code}), Pixel score ${pixel.score}/8 (${pixel.code}), winner ${winner}`);
