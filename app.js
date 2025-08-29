// app.js — Minimal working voting app (white theme, staff-only create, 0–10 voting)
const express = require('express');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const { customAlphabet } = require('nanoid');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

// -------- App / Config --------
const app = express();
app.set('trust proxy', 1); // needed on Render/behind proxies

const PORT = process.env.PORT || 3000;
const STAFF_PASS = process.env.STAFF_PASS || 'change-this-staff-pass';
const SALT = process.env.IP_SALT || 'change-this-salt-in-env';
const VOTE_WINDOW_MINUTES = parseInt(process.env.VOTE_WINDOW_MINUTES || '0', 10); // 0 = unlimited once per IP
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'votes.sqlite');

app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// -------- DB --------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS artists (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id  INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    ip_hash    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (artist_id, ip_hash)
  )
`).run();

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

// statements
const insertArtist = db.prepare('INSERT INTO artists (name, slug) VALUES (?, ?)');
const getArtistBySlug = db.prepare('SELECT * FROM artists WHERE slug = ?');
const getArtistById = db.prepare('SELECT * FROM artists WHERE id = ?');
const listArtists = db.prepare('SELECT * FROM artists ORDER BY id DESC');
const insertVote = db.prepare('INSERT INTO votes (artist_id, score, ip_hash) VALUES (@artist_id, @score, @ip_hash)');
const getLastVoteByIp = db.prepare('SELECT created_at FROM votes WHERE artist_id = ? AND ip_hash = ? ORDER BY id DESC LIMIT 1');

const leaderboardStmt = db.prepare(`
  SELECT
    a.id,
    a.name,
    COUNT(v.id)               AS votes,
    COALESCE(SUM(v.score),0)  AS total_score,
    ROUND(AVG(v.score),2)     AS avg_score
  FROM artists a
  LEFT JOIN votes v ON v.artist_id = a.id
  GROUP BY a.id
  ORDER BY total_score DESC, votes DESC, a.name ASC
`);

// -------- helpers --------
const isStaff = (req) => req.cookies.staff === 'ok';

function clientIp(req) {
  // trust proxy above ensures this works on Render
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '0.0.0.0';
}

function ipHash(ip) {
  return crypto.createHash('sha256').update(ip + SALT).digest('hex');
}

function cookieGuard(req, res) {
  // simple write-once cookie so we can rate-limit by cookie if needed later
  const token = req.cookies.voter || crypto.randomBytes(16).toString('hex');
  if (!req.cookies.voter) {
    res.cookie('voter', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  }
  return token;
}

function layout({ title, body }) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        :root { --border:#d0d0d0; --muted:#666; --bg:#fff; --card:#f9f9f9; --txt:#000; }
        * { box-sizing:border-box; }
        body {
          margin:0; background:var(--bg); color:var(--txt);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          display:flex; flex-direction:column; align-items:center; min-height:100vh;
        }
        header { padding:20px; text-align:center; }
        header img { max-width:220px; height:auto; }
        .container { width:100%; max-width:920px; padding:20px; }
        .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
        .title { font-size:32px; font-weight:800; margin:0 0 8px; }
        .muted { color:var(--muted); margin:0 0 16px; }
        .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
        input[type="text"], input[type="number"], input[type="password"] {
          width:100%; padding:12px; border:1px solid var(--border); border-radius:10px; font-size:16px;
        }
        button, .pill {
          appearance:none; border:none; cursor:pointer; text-decoration:none;
          padding:10px 16px; border-radius:10px; font-weight:700; font-size:16px;
          background:#000; color:#fff;
        }
        .pill { background:#fff; color:#000; border:1px solid #000; }
        ul.list { list-style:none; padding:0; margin:0; }
        ul.list li { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--border); }
        .score { font-weight:800; }
        a { color:#000; }
      </style>
    </head>
    <body>
      <header>
        <img src="/logo.jpeg" alt="Ratazana Comedy Logo"/>
      </header>
      <div class="container">
        ${body}
      </div>
    </body>
  </html>`;
}

// -------- routes (pages) --------
app.get('/', (req, res) => {
  const rows = listArtists.all();
  const body = `
    <div class="card">
      <h1 class="title">Vote for an Artist</h1>
      <p class="muted">Tap an artist below to submit your 0–10 score.</p>
      <div class="row" style="margin-bottom:16px">
        <a class="pill" href="/leaderboard">View Leaderboard</a>
        ${isStaff(req) ? '<a class="pill" href="/staff">Staff Area</a>' : '<a class="pill" href="/staff-login">Staff Login</a>'}
      </div>
      <ul class="list">
        ${rows.length === 0 ? '<li><span>No artists yet.</span><span>—</span></li>' : rows.map(r=>`
          <li>
            <span><strong>${r.name}</strong></span>
            <span><a href="/a/${r.slug}">Vote</a></span>
          </li>`).join('')}
      </ul>
    </div>`;
  res.send(layout({ title:'Home', body }));
});

app.get('/staff-login', (req, res) => {
  const body = `
    <div class="card">
      <h1 class="title">Staff Login</h1>
      <form method="POST" action="/staff-login">
        <input type="password" name="password" placeholder="Enter staff password" required />
        <div class="row" style="margin-top:12px">
          <button type="submit">Login</button>
          <a href="/" class="pill">Back</a>
        </div>
      </form>
    </div>`;
  res.send(layout({ title:'Staff Login', body }));
});

app.post('/staff-login', (req, res) => {
  const password = (req.body.password || '').trim();
  if (password && password === STAFF_PASS) {
    res.cookie('staff', 'ok', { httpOnly: true, sameSite:'lax', maxAge: 1000*60*60*8 });
    return res.redirect('/staff');
  }
  return res.status(401).send('Invalid password');
});

app.get('/staff', (req, res) => {
  if (!isStaff(req)) return res.status(403).send('Forbidden');
  const rows = listArtists.all();
  const body = `
    <div class="card">
      <h1 class="title">Cadastrar Comediante</h1>
      <p class="muted">Adicionar Comediante.</p>
      <form id="createForm">
        <input type="text" name="name" placeholder="Nome do Comediante" required />
        <div class="row" style="margin-top:12px">
          <button type="submit">Adicionr</button>
          <a class="pill" href="/leaderboard">Ver tabela</a>
          <a class="pill" href="/">Home</a>
        </div>
      </form>
      <p id="msg" class="muted" style="margin-top:12px"></p>
      <h3 style="margin-top:24px">Comediantes</h3>
      <ul class="list">
        ${rows.map(r => `
          <li>
            <span>${r.name}</span>
            <span><a href="/a/${r.slug}">Compartilhar</a></span>
          </li>`).join('')}
      </ul>
    </div>
    <script>
      const f = document.getElementById('createForm');
      const msg = document.getElementById('msg');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(f);
        const r = await fetch('/api/artists', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ name: fd.get('name') })
        });
        const data = await r.json();
        if (r.ok) {
          msg.textContent = 'Created: ' + data.name + ' — link ' + data.link;
          location.reload();
        } else {
          msg.textContent = data.error || 'Create failed';
        }
      });
    </script>`;
  res.send(layout({ title:'Staff', body }));
});

// -------- Staff Login --------
function isStaff(req) {
  return req.cookies.staff === 'ok';
}

app.post('/staff-login', (req, res) => {
  const password = (req.body.password || '').trim();
  if (password && password === (process.env.STAFF_PASS || 'mude-esta-senha')) {
    // store a simple flag in the cookie
    res.cookie('staff', 'ok', { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 });
    return res.redirect('/staff');
  }
  return res.status(401).send('Senha incorreta');
});


app.get('/staff', (req, res) => {
  if (!isStaff(req)) return res.status(403).send('Acesso negado');
  const rows = listArtists.all();
  const body = `
    <div class="card">
      <h1 class="title">Criar Artista</h1>
      <p class="muted">Adicione um artista e compartilhe o link de votação.</p>
      <form id="createForm">
        <input type="text" name="name" placeholder="Nome do artista" required />
        <div class="row" style="margin-top:12px">
          <button type="submit">Criar</button>
          <a class="pill" href="/leaderboard">Ver Tabela</a>
          <a class="pill" href="/">Página Pública</a>
        </div>
      </form>
      <p id="msg" class="muted" style="margin-top:12px"></p>
      <h3 style="margin-top:24px">Artistas</h3>
      <ul class="list">
        ${rows.map(r => `
          <li>
            <span>${r.name}</span>
            <span><a href="/a/${r.slug}">Compartilhar link</a></span>
          </li>`).join('')}
      </ul>
    </div>
    <script>
      const f = document.getElementById('createForm');
      const msg = document.getElementById('msg');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(f);
        const r = await fetch('/api/artists', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ name: fd.get('name') })
        });
        const data = await r.json();
        if (r.ok) { msg.textContent = 'Criado: ' + data.name + ' — link ' + data.link; location.reload(); }
        else { msg.textContent = data.error || 'Falha ao criar'; }
      });
    </script>`;
  res.send(layout({ title:'Área do Staff', body }));
});

app.post('/api/artists', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error:'Forbidden' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error:'Name required' });
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${nanoid()}`.replace(/-+/g,'-');
  try {
    const info = insertArtist.run(name, slug);
    res.json({ id: info.lastInsertRowid, name, slug, link:`/a/${slug}` });
  } catch {
    res.status(400).json({ error:'Tente Novamente' });
  }
});

app.get('/a/:slug', (req, res) => {
  const artist = getArtistBySlug.get(req.params.slug);
  if (!artist) return res.status(404).send('Artist not found');
  const guard = cookieGuard(req, res);
  const body = `
    <div class="card">
      <h1 class="title">Votar: ${artist.name}</h1>
      <p class="muted">Clique em votar e dê uma nota de 0 - 10.</p>
      <form id="voteForm">
        <input type="number" min="0" max="10" step="1" name="score" placeholder="Sua Nota (0–10) />
        <input type="hidden" name="artist_id" value="${artist.id}" />
        <div class="row" style="margin-top:12px">
         <button type="submit" style="background:black; color:white; padding:10px 20px; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">
  Votar
</button>
          <a class="pill" href="/leaderboard">Tabla de Liderança</a>
        </div>
      </form>
      <p id="msg" class="muted" style="margin-top:12px"></p>
    </div>
    <script>
      const form = document.getElementById('voteForm');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = { artist_id: Number(fd.get('artist_id')), score: Number(fd.get('score')) };
        const r = await fetch('/api/vote', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await r.json();
        msg.textContent = r.ok ? 'Obrigado! Seu voto foi registrado.' : (data.error || 'não foi possível registrar seu voto.');
      });
    </script>`;
  res.send(layout({ title:`Vote — ${artist.name}`, body }));
});

// -------- API: vote --------
app.post('/api/vote', (req, res) => {
  try {
    const artist_id = Number(req.body.artist_id);
    const score     = Number(req.body.score);

    if (!Number.isInteger(artist_id) || !Number.isInteger(score))
      return res.status(400).json({ error:'artist_id and score are required' });
    if (score < 0 || score > 10)
      return res.status(400).json({ error:'Score must be an integer 0–10' });

    const artist = getArtistById.get(artist_id);
    if (!artist) return res.status(404).json({ error:'Artist not found' });

    const ip = clientIp(req);
    const hash = ipHash(ip);
    const guardToken = cookieGuard(req, res);

    if (VOTE_WINDOW_MINUTES > 0) {
      const last = getLastVoteByIp.get(artist_id, hash);
      if (last) {
        const minutes = (Date.now() - new Date(last.created_at).getTime()) / 60000;
        if (minutes < VOTE_WINDOW_MINUTES) {
          return res.status(409).json({ error: `Already voted. Try again in ${Math.ceil(VOTE_WINDOW_MINUTES - minutes)} min.` });
        }
      }
    }

    try {
      insertVote.run({ artist_id, score, ip_hash: hash });
      return res.json({ ok:true, guardToken });
    } catch {
      return res.status(409).json({ error:'You already voted for this artist.' });
    }
  } catch (err) {
    console.error('VOTE_ERROR', err);
    return res.status(500).json({ error:'Server error while recording vote' });
  }
});

// -------- Leaderboard --------
app.get('/leaderboard', (req, res) => {
  const rows = leaderboardStmt.all();
  const body = `
    <div class="card">
      <h1 class="title">Leaderboard</h1>
      <p class="muted">Scored by sum of all votes.</p>
      <ul class="list">
        ${rows.map((r,i)=>`
          <li>
            <span>#${i+1} — <strong>${r.name}</strong> (${r.votes} votes)</span>
            <span class="score">${r.total_score}</span>
          </li>`).join('')}
      </ul>
      <div class="row" style="margin-top:12px">
        <a class="pill" href="/">Back</a>
      </div>
    </div>`;
  res.send(layout({ title:'Leaderboard', body }));
});

// -------- Health/Debug --------
app.get('/api/health', (req,res)=> res.json({ ok:true }));
app.get('/api/debug/votes', (req,res)=>{
  const rows = db.prepare(`
    SELECT artist_id, COUNT(*) votes, SUM(score) total_score, ROUND(AVG(score),2) avg_score
    FROM votes GROUP BY artist_id ORDER BY artist_id
  `).all();
  res.json(rows);
});

// -------- Start server --------
app.listen(PORT, () => {
  console.log(`Voting app running on http://localhost:${PORT}`);
});

