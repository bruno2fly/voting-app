const express = require('express');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const { customAlphabet } = require('nanoid');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
// Serve static files (like logo image) from /public

const app = express();                  // <- create the app FIRST
const PORT = process.env.PORT || 3000;
const STAFF_PASS = process.env.STAFF_PASS || 'change-this-staff-pass';

// Middleware (order matters)
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // <- static AFTER app is created


// ---------- Config ----------
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);
const SALT = process.env.IP_SALT || 'change-this-salt-in-env';
const VOTE_WINDOW_MINUTES = parseInt(process.env.VOTE_WINDOW_MINUTES || '0', 10); // 0 = unlimited time

// ---------- DB ----------
const db = new Database(path.join(__dirname, 'votes.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 10),
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  cookie_guard TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(artist_id) REFERENCES artists(id)
);

CREATE INDEX IF NOT EXISTS idx_votes_artist ON votes(artist_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_artist_ip ON votes(artist_id, ip_hash);
`);

const insertArtist = db.prepare(`INSERT INTO artists (name, slug) VALUES (?, ?)`);
const getArtistBySlug = db.prepare(`SELECT * FROM artists WHERE slug = ?`);
const getArtistById = db.prepare(`SELECT * FROM artists WHERE id = ?`);
const listArtists = db.prepare(`SELECT id, name, slug, created_at FROM artists ORDER BY created_at DESC`);
const insertVote = db.prepare(`INSERT INTO votes (artist_id, score, ip_hash, user_agent, cookie_guard) VALUES (?, ?, ?, ?, ?)`);
const getVoteByArtistAndIp = db.prepare(`SELECT * FROM votes WHERE artist_id = ? AND ip_hash = ?`);
const countVotesByCookie = db.prepare(`SELECT COUNT(1) as n FROM votes WHERE artist_id = ? AND cookie_guard = ?`);
const leaderboardStmt = db.prepare(`
  SELECT a.id, a.name, a.slug,
         COUNT(v.id) as votes,
         ROUND(AVG(v.score), 2) as avg_score
  FROM artists a
  LEFT JOIN votes v ON v.artist_id = a.id
  GROUP BY a.id
  ORDER BY avg_score DESC NULLS LAST, votes DESC, a.created_at ASC;
`);

// ---------- Helpers ----------
function layout({ title, body }) {
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #fff;      /* white background */
        color: #000;           /* black text */
        display: flex;
        flex-direction: column;
        align-items: center;
        min-height: 100vh;
      }
      header { padding: 20px; text-align: center; }
      header img { max-width: 220px; height: auto; }
      .container { max-width: 720px; width: 100%; padding: 20px; }
      .card { background: #f9f9f9; border: 1px solid #ccc; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
      .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
      .list { list-style: none; padding: 0; }
      .list li { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd; padding: 10px 0; }
      a, button { background: #000; color: #fff; padding: 8px 14px; border-radius: 6px; border: none; text-decoration: none; font-weight: bold; cursor: pointer; }
      input { padding: 10px; border-radius: 6px; border: 1px solid #ccc; width: 100%; margin-bottom: 10px; }
      .row { display:flex; gap:12px; flex-wrap:wrap; }
      .pill { background:#fff; color:#000; border:1px solid #000; }
    </style>
  </head>
  <body>
    <header>
      <img src="public/logo.jpeg" alt="Ratazana Comedy Logo" />
    </header>
    <div class="container">
      ${body}
    </div>
  </body>
  </html>`;
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

function isStaff(req) { return req.cookies.staff === 'ok'; }

function clientIp(req) {
  // Be careful behind proxies: trust proxy in production or configure IP source
  const xfwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xfwd || req.socket.remoteAddress || '0.0.0.0';
}

function ipHash(ip) {
  return crypto.createHmac('sha256', SALT).update(ip).digest('hex');
}

function cookieGuard(req, res) {
  if (!req.cookies._voter) {
    const token = nanoid();
    res.cookie('_voter', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
    return token;
  }
  return req.cookies._voter;
}

function voteWindowQuery() {
  if (!VOTE_WINDOW_MINUTES) return '';
  return ` AND created_at >= datetime('now', '-${VOTE_WINDOW_MINUTES} minutes') `;
}

// ---------- Views (simple server-side HTML) ----------

app.get('/', (req, res) => {
  // PUBLIC homepage: list all artists with Vote links
  const artists = listArtists.all();
  const body = `
    <div class="card">
      <h1 class="title">Votação Open Mic</h1>
      <p class="muted">Clique no Artista para dar o seu voto com notas de 0-10</p>
      <ul class="list">
        ${artists.map(a => `
          <li>
            <span>${a.name}</span>
            <span><a href="/a/${a.slug}">Votar</a></span>
          </li>
        `).join('')}
      </ul>
      <div class="row" style="margin-top:12px">
        <a class="pill" href="/leaderboard">View Leaderboard</a>
        <a class="pill" href="/staff-login">Staff Login</a>
      </div>
    </div>`;
  res.send(layout({ title: 'Voting — Artists', body }));
});

app.post('/artists', (req, res) => {
  if (!isStaff(req)) return res.status(403).send('Forbidden');
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).send('Name required');
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid()}`.replace(/-+/g, '-');
  try {
    insertArtist.run(name, slug);
  } catch (e) {
    return res.status(400).send('Could not create artist');
  }
  res.redirect('/staff');
});

app.get('/a/:slug', (req, res) => {
  const artist = getArtistBySlug.get(req.params.slug);
  if (!artist) return res.status(404).send('Artist not found');

  const guard = cookieGuard(req, res);
  const body = `
    <div class="card">
      <h1 class="title">Vote: ${artist.name}</h1>
      <p class="muted">Rate from 0 to 10 (whole numbers). One vote per IP.</p>
      <form id="voteForm">
        <input type="number" min="0" max="10" step="1" name="score" placeholder="Your score (0–10)" required />
        <input type="hidden" name="artist_id" value="${artist.id}" />
        <div class="row" style="margin-top:12px">
          <button type="submit">Submit Vote</button>
          <a class="pill" href="/leaderboard">Leaderboard</a>
        </div>
      </form>
      <p id="msg" class="muted" style="margin-top:12px"></p>
    </div>
    <script>
      const form = document.getElementById('voteForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = { artist_id: Number(fd.get('artist_id')), score: Number(fd.get('score')) };
        const r = await fetch('/api/vote', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await r.json();
        const msg = document.getElementById('msg');
        if (r.ok) {
          msg.textContent = 'Thanks! Your vote was recorded.';
        } else {
          msg.textContent = data.error || 'Unable to vote.';
        }
      });
    </script>
  `;
  res.send(layout({ title: `Vote — ${artist.name}`, body }));
});

app.get('/leaderboard', (req, res) => {
  const rows = leaderboardStmt.all();
  const body = `
    <div class="card">
      <h1 class="title">Leaderboard</h1>
      <p class="muted">Sorted by average score (then votes).</p>
      <ul class="list">
        ${rows.map((r, i) => `
          <li>
            <span>#${i+1} — <strong>${r.name || '—'}</strong> (${r.votes || 0} votes)</span>
            <span class="score">${r.avg_score ?? '—'}</span>
          </li>`).join('')}
      </ul>
      <div class="row" style="margin-top:12px">
        <a class="pill" href="/">Back</a>
      </div>
    </div>`;
  res.send(layout({ title: 'Leaderboard', body }));
});

// ---------- Staff auth pages ----------
app.get('/staff-login', (req, res) => {
  const body = `
    <div class="card">
      <h1 class="title">Staff Login</h1>
      <p class="muted">Enter the staff password to manage artists.</p>
      <form method="post" action="/staff-login">
        <input type="password" name="password" placeholder="Password" required />
        <div class="row" style="margin-top:12px">
          <button type="submit">Login</button>
          <a class="pill" href="/">Back</a>
        </div>
      </form>
    </div>`;
  res.send(layout({ title: 'Staff Login', body }));
});

app.post('/staff-login', (req, res) => {
  const password = (req.body.password || '').trim();
  if (password && password === STAFF_PASS) {
    res.cookie('staff', 'ok', { httpOnly: true, sameSite: 'lax', maxAge: 1000*60*60*8 });
    return res.redirect('/staff');
  }
  res.status(401).send('Invalid password');
});

app.get('/logout', (req, res) => {
  res.clearCookie('staff');
  res.redirect('/');
});

app.get('/staff', (req, res) => {
  if (!isStaff(req)) return res.redirect('/staff-login');
  const artists = listArtists.all();
  const body = `
    <div class="grid">
      <div class="card">
        <h1 class="title">Create Artist</h1>
        <p class="muted">Cadastre um artista abaixo (Staff only)</p>
        <form method="post" action="/artists">
          <input type="text" name="name" placeholder="Artist name" required />
          <div class="row" style="margin-top:12px">
            <button type="submit">Cadastrar Comediante</button>
            <a class="pill" href="/leaderboard">Ver Tabela</a>
            <a class="pill" href="/">Pagina Inicial</a>
            <a class="pill" href="/logout">Logout</a>
          </div>
        </form>
      </div>
      <div class="card">
        <h2 class="title">Comediantes</h2>
        <ul class="list">
          ${artists.map(a => `
            <li>
              <span>${a.name}</span>
              <span><a href="/a/${a.slug}">Compartilhar</a></span>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>`;
  res.send(layout({ title: 'Staff — Manage Artists', body }));
});

// ---------- API ----------
app.post('/api/artists', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid()}`.replace(/-+/g, '-');
  try {
    const info = insertArtist.run(name, slug);
    res.json({ id: info.lastInsertRowid, name, slug, link: `/a/${slug}` });
  } catch (e) {
    res.status(400).json({ error: 'Could not create artist' });
  }
});

app.post('/api/vote', (req, res) => {
  const { artist_id, score } = req.body || {};
  if (typeof artist_id !== 'number' || typeof score !== 'number') {
    return res.status(400).json({ error: 'artist_id and score are required' });
  }
  if (score < 0 || score > 10 || !Number.isInteger(score)) {
    return res.status(400).json({ error: 'Score must be an integer 0–10' });
  }
  const artist = getArtistById.get(artist_id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });

  const ip = clientIp(req);
  const hash = ipHash(ip);
  const guardToken = cookieGuard(req, res);

  // Optional time window: block repeat votes from same IP within window
  if (VOTE_WINDOW_MINUTES > 0) {
    const row = db.prepare(`SELECT 1 FROM votes WHERE artist_id = ? AND ip_hash = ? ${voteWindowQuery()} LIMIT 1`).get(artist_id, hash);
    if (row) return res.status(409).json({ error: `You have already voted recently for this artist.` });
  } else {
    const dup = getVoteByArtistAndIp.get(artist_id, hash);
    if (dup) return res.status(409).json({ error: 'You have already voted for this artist.' });
  }

  // Soft cookie guard (helps within same IP household)
  const cookieCount = countVotesByCookie.get(artist_id, guardToken)?.n || 0;
  if (cookieCount > 0) {
    return res.status(409).json({ error: 'You have already voted for this artist (cookie).' });
  }

  try {
    insertVote.run(artist_id, score, hash, (req.headers['user-agent'] || '').slice(0, 255), guardToken);
  } catch (e) {
    return res.status(400).json({ error: 'Vote not recorded' });
  }
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const rows = leaderboardStmt.all();
  res.json(rows);
});

// ---------- Static health ----------
app.get('/healthz', (_, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Voting app running on http://localhost:${PORT}`));

