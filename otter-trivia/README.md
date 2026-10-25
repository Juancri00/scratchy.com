# Otter Restaurant Trivia Challenge

A mobile-first booth game for restaurant industry events. Visitors scan a QR code, register (name, phone, optional restaurant, optional marketing consent), answer 8 quick multiple-choice questions with instant feedback, and get a raffle entry. The Otter team uses a password-protected dashboard to view leads, search, export CSV and draw a winner fairly.

- **Zero npm dependencies.** Uses Node's built-in HTTP server and built-in SQLite (`node:sqlite`). There's no `npm install` and no build step.
- **Persistent storage.** Every registration, answer, score and raffle draw is written to a SQLite file in `DATA_DIR`.
- **Requires Node.js 22.13 or later.**

## Quick start (local)

```bash
cd otter-trivia
npm start                # http://localhost:3000, admin at http://localhost:3000/admin/
```

If no `ADMIN_PASSWORD` is set, a temporary one is printed in the console. Tests:

```bash
npm test                 # API, validation, scoring, duplicates, auth, CSV, raffle, QR decoding
npm run test:e2e         # full browser flow on iPhone + Android viewports (needs Playwright)
```

## What you need to provide

| Item | Why | Where |
|---|---|---|
| **Hosting account** (Render, Railway, Fly.io, or any Docker/Node host) | Runs the app at a public HTTPS URL | see *Deploy* |
| **Persistent disk / volume** | Keeps the SQLite database across restarts and redeploys. Without one, data is lost on redeploy. | mount it and set `DATA_DIR` to its path |
| `ADMIN_PASSWORD` | Protects the dashboard (12+ characters, required in production) | host env vars |
| `SESSION_SECRET` | Signs admin login cookies (random 64-char hex) | host env vars |
| `PUBLIC_URL` | The live `https://` address. The booth QR code encodes it. | host env vars |
| Prize and draw wording | `PRIZE_NAME`, `DRAW_INFO`, `WINNER_CONTACT`, `RULES_EXTRA` | host env vars (see `.env.example`) |
| **Official Otter logo** | `public/brand/logo.svg` is a placeholder wordmark. Replace it with the official white-on-dark logo. Colors are CSS variables at the top of `public/styles.css`. | files |
| **Legal / marketing review** | Check the consent wording (`server/store.js`, `CONSENT_TEXT`), the raffle rules, and the Otter product explanations (`server/questions.js`). Rules differ by state, and texting consent falls under TCPA. | files / env |

No other external services, API keys or databases are needed.

## Deploy

### Option A: Render (Blueprint included)

1. Push this folder to a GitHub repo. It can stay as the `otter-trivia/` subfolder: `render.yaml` sets `rootDir`. If you move it to its own repo, move `render.yaml` to the root and delete the `rootDir` line.
2. In Render: **New → Blueprint**, pick the repo. Render creates a web service with a 1 GB persistent disk at `/var/data` (needs the paid *Starter* instance type or above; free instances have no disk).
3. Fill in `ADMIN_PASSWORD`, `PRIZE_NAME` and `DRAW_INFO` when prompted. `SESSION_SECRET` is generated for you.
4. After the first deploy, copy the service URL (e.g. `https://otter-trivia.onrender.com`), set `PUBLIC_URL` to it, and redeploy.

### Option B: Any Docker host (Fly.io, Railway, ECS, a VM)

```bash
docker build -t otter-trivia otter-trivia
docker run -d -p 3000:3000 -v otter-data:/data \
  -e ADMIN_PASSWORD='…' -e SESSION_SECRET='…' -e PUBLIC_URL='https://trivia.example.com' \
  -e PRIZE_NAME='a $250 gift card' otter-trivia
```

Mount a persistent volume at `/data`. Put the app behind HTTPS (most hosts do this for you). The app trusts `X-Forwarded-*` headers in production; set `TRUST_PROXY=false` if it is exposed directly.

### Option C: Railway / plain Node host

Start command `npm start`, Node 22.13+, add a volume, and set `DATA_DIR` to the volume's mount path plus the env vars above.

> Run **one instance** only. SQLite is a single-file database, and one small instance easily handles booth traffic.

## Booth QR code

**There is no final QR code yet because the app isn't deployed.** `docs/qr-placeholder.svg` is a clearly marked, non-scannable placeholder for layout mockups. Never print a QR that points to `localhost` or a private IP: phones at the event can't reach it.

After deploying, get the real code in any of these ways:

1. **Admin dashboard → "Booth QR code."** It shows a QR for `PUBLIC_URL` (or the address you opened the dashboard from), with **Download SVG** and **Print booth sign** (a letter-size poster at `/sign.html`). A red warning appears if the address is local or not HTTPS.
2. **Command line:**
   ```bash
   npm run qr -- https://your-live-url.example.com ./print
   ```
   This writes `otter-trivia-qr.svg` (vector, best for print) and `otter-trivia-qr.png` (888 px), and previews the code in the terminal. It refuses non-HTTPS and local URLs.
3. Always **scan the printed code with an iPhone and an Android phone** before the event.

If you later move to a custom domain, update `PUBLIC_URL` and regenerate the QR.

## How it works

**Player flow:** register → 8 questions (one per screen, 3 choices, progress bar, live score) → instant feedback with the correct answer and a short explanation → results with score, a celebratory message and a raffle entry code.

- Question order and choice order are shuffled per participant on the server (`crypto.randomInt`). Each choice keeps its id, so the correct answer always maps correctly.
- Answers are checked on the server. The client never receives the answer key for unanswered questions.
- A page refresh resumes where the player left off (server state, with a token kept in `localStorage`).
- **Duplicates:** the phone number is normalized (E.164) and unique. If it hasn't finished, it resumes the same game. If it has finished, it gets a friendly "already played" screen. Each answer can be submitted only once, in order, so double taps and retries can't change it.
- Phone validation accepts US/Canada numbers (`(415) 555-0142`, `415-555-0142`, `+1 415…`) and international numbers with a leading `+`.

**Raffle:** by default everyone who finishes gets one equal entry, whatever their score (`RAFFLE_MIN_SCORE=0`). Set `RAFFLE_MIN_SCORE` to require a minimum. Players see clear rules: a random draw among eligible entries, not everyone wins, and how the winner is contacted. In the dashboard, **Draw a winner** picks uniformly at random (`crypto.randomInt`) from eligible entries that haven't already been drawn. Every draw is logged with time and pool size. If a winner can't be reached, draw again.

**Admin (`/admin/`):** password login (rate-limited, HMAC-signed HttpOnly SameSite=Strict cookie, 12 h). It shows stats, the participant table with search (name, restaurant, phone, entry code) and filters, **Export CSV**, raffle draw and history, per-participant delete (on request), and the booth QR. It auto-refreshes every 15 seconds.

**CSV columns:** full name, phone (E.164), restaurant, marketing consent, consent version and timestamp, registered and completed timestamps (UTC), completion status, questions answered, score, total, raffle entry, entry code. Cells are protected against spreadsheet formula injection.

## Privacy & security notes

- Participant data is served only through authenticated admin endpoints. Public endpoints return only the caller's own game.
- Marketing consent is opt-in (unchecked by default) and stored with the exact wording version and timestamp. The phone number is otherwise used only for the raffle.
- Strict Content-Security-Policy (no third-party scripts, fonts or trackers), HSTS on HTTPS, `noindex` on admin, JSON body limits, and rate limits on registration and login.
- Participant tokens are stored hashed. Deleting a participant also removes their name and phone from the draw history.
- Retention: export what you need after the event, then delete the database file (`$DATA_DIR/otter-trivia.sqlite*`) or the volume.

## Customizing

- Questions and explanations: `server/questions.js`
- Text, prize and rules: environment variables (`.env.example`)
- Brand: `public/brand/logo.svg`, `public/brand/favicon.svg`, CSS variables in `public/styles.css`

## Project layout

```
server/      index.js (entry), app.js (routes, auth, CSV), store.js (SQLite, game logic),
             questions.js, qr.js, config.js, vendor/qrcode (MIT QR encoder)
public/      index.html, app.js, styles.css (player), admin/ (dashboard), sign.html (poster)
scripts/     make-qr.js
test/        api.test.js, e2e.mjs, qr-decode.js
```
