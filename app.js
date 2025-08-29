// ----------- Imports -----------
const express = require('express');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const { customAlphabet } = require('nanoid');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

// ----------- App setup -----------
const app = express();
const PORT = process.env.PORT || 3000;
const STAFF_PASS = process.env.STAFF_PASS || 'mudar-senha-staff';
const SALT = process.env.IP_SALT || 'mudar-sal-no-env';
const VOTE_WINDOW_MINUTES = parseInt(process.env.VOTE_WINDOW_MINUTES || '0', 10); // 0 = sem limite

// ----------- Middleware -----------
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ----------- DB setup -----------
const db = new Database(path.join(__dirname, 'votes.sqlite'));
db.pragma('journal_mode = WAL');

db.prepare(`CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (artist_id) REFERENCES artists(id)
)`).run();

const insertArtist = db.prepare("INSERT INTO artists (name, slug) VALUES (?, ?)");
const getArtistBySlug = db.prepare("SELECT * FROM artists WHERE slug = ?");
const getArtistById = db.prepare("SELECT * FROM artists WHERE id = ?");
const insertVote = db.prepare("INSERT INTO votes (artist_id, score, ip_hash, created_at) VALUES (?, ?, ?, ?)");
const leaderboardStmt = db.prepare(`
  SELECT a.id, a.name, 
    COUNT(v.id) as votes, 
    COALESCE(SUM(v.score),0) as total_score
  FROM artists a
  LEFT JOIN votes v ON v.artist_id = a.id
  GROUP BY a.id
  ORDER BY total_score DESC, votes DESC
`);

// ----------- Helpers -----------
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || '0.0.0.0';
}
function ipHash(ip) {
  return crypto.createHash('sha256').update(ip + SALT).digest('hex');
}
function isStaff(req) {
  return req.cookies.staff === (process.env.STAFF_PASS || 'mudar-senha-staff');
}
function layout({ title, body }) {
  return `<!doctype html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8"/>
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background:white; color:black; padding:20px; }
      .card { max-width:600px; margin:20px auto; padding:20px; border:1px solid #ddd; border-radius:10px; background:#f9f9f9; }
      h1.title { margin-top:0; }
      .btn { background:black; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:bold; }
      .pill { display:inline-block; padding:6px 12px; border:1px solid black; border-radius:20px; margin-left:8px; text-decoration:none; color:black; }
      .list { list-style:none; padding:0; }
      .list li { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #ddd; }
      .muted { color:#555; font-size:14px; }
    </style>
  </head>
  <body>
    <header style="text-align:center; margin-bottom:20px;">
      <img src="/logo.jpeg" alt="Ratazana Comedy Logo" style="max-height:80px;"/>
    </header>
    ${body}
  </body>
  </html>`;
}

// ----------- Routes -----------

// Home page
app.get('/', (req, res) => {
  const rows = leaderboardStmt.all();
  const body = `
    <div class="card">
      <h1 class="title">Vote em um Artista</h1>
      <p class="muted">Clique em um artista para dar sua nota de 0 a 10.</p>
      <ul class="list">
        ${rows.map(r => `
          <li>
            <span><strong>${r.name}</strong></span>
            <a class="pill" href="/a/${r.slug}">Votar</a>
          </li>`).join('')}
      </ul>
      <div style="margin-top:12px">
        <a class="pill" href="/leaderboard">Tabela de Liderança</a>
        <a class="pill" href="/staff-login">Área Staff</a>
      </div>
    </div>`;
  res.send(layout({ title: "Início", body }));
});

// Staff login
app.get('/staff-login', (req, res) => {
  const body = `
    <div class="card">
      <h1 class="title">Login Staff</h1>
      <form method="post" action="/staff/login">
        <input type="password" name="password" placeholder="Senha staff" required/>
        <button type="submit" class="btn">Entrar</button>
      </form>
    </div>`;
  res.send(layout({ title: "Login Staff", body }));
});

app.post('/staff/login', (req, res) => {
  const password = req.body.password || '';
  if (password === STAFF_PASS) {
    res.cookie('staff', STAFF_PASS, { httpOnly: true });
    res.redirect('/staff');
  } else {
    res.status(403).send("Senha incorreta");
  }
});

app.get('/staff', (req, res) => {
  if (!isStaff(req)) return res.status(403).send("Acesso negado");
  const rows = leaderboardStmt.all();
  const body = `
    <div class="card">
      <h1 class="title">Área Staff</h1>
      <form method="post" action="/api/artists">
        <input type="text" name="name" placeholder="Nome do artista" required/>
        <button type="submit" class="btn">Criar Artista</button>
      </form>
      <h2 style="margin-top:20px;">Artistas</h2>
      <ul class="list">
        ${rows.map(r => `
          <li>
            <span>${r.name}</span>
            <a class="pill" href="/a/${r.slug}">Link de Votação</a>
          </li>`).join('')}
      </ul>
    </div>`;
  res.send(layout({ title: "Staff", body }));
});

// Add artist
app.post('/api/artists', (req, res) => {
  if (!isStaff(req)) return res.status(403).json({ error: 'Proibido' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid()}`.replace(/-+/g, '-');
  try {
    insertArtist.run(name, slug);
    res.redirect('/staff');
  } catch (e) {
    res.status(400).json({ error: 'Não foi possível criar artista' });
  }
});

// Artist voting page
app.get('/a/:slug', (req, res) => {
  const artist = getArtistBySlug.get(req.params.slug);
  if (!artist) return res.status(404).send("Artista não encontrado");
  const body = `
    <div class="card">
      <h1 class="title">Votar: ${artist.name}</h1>
      <p class="muted">Nota de 0 a 10. Um voto por IP.</p>
      <form id="voteForm">
        <input type="number" min="0" max="10" step="1" name="score" placeholder="Sua nota (0–10)" required />
        <input type="hidden" name="artist_id" value="${artist.id}" />
        <div style="margin-top:12px">
          <button type="submit" class="btn">VOTAR</button>
          <a class="pill" href="/leaderboard">Tabela de Liderança</a>
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
          msg.textContent = 'Obrigado! Seu voto foi registrado.';
        } else {
          msg.textContent = data.error || 'Erro ao registrar voto.';
        }
      });
    </script>`;
  res.send(layout({ title: `Votar — ${artist.name}`, body }));
});

// API vote
app.post('/api/vote', (req, res) => {
  const { artist_id, score } = req.body || {};
  if (typeof artist_id !== 'number' || typeof score !== 'number') {
    return res.status(400).json({ error: 'artist_id e score são obrigatórios' });
  }
  if (score < 0 || score > 10 || !Number.isInteger(score)) {
    return res.status(400).json({ error: 'Score deve ser um número inteiro 0–10' });
  }
  const artist = getArtistById.get(artist_id);
  if (!artist) return res.status(404).json({ error: 'Artista não encontrado' });

  const ip = clientIp(req);
  const hash = ipHash(ip);

  // one vote per artist per IP
  const existing = db.prepare("SELECT * FROM votes WHERE artist_id=? AND ip_hash=?").get(artist_id, hash);
  if (existing) return res.status(409).json({ error: 'Você já votou neste artista.' });

  insertVote.run(artist_id, score, hash, Date.now());
  res.json({ success: true });
});

// Leaderboard
app.get('/leaderboard', (req, res) => {
  const rows = leaderboardStmt.all();
  const body = `
    <div class="card">
      <h1 class="title">Tabela de Liderança</h1>
      <p class="muted">Pontuação é pela soma de todos os votos.</p>
      <ul class="list">
        ${rows.map((r, i) => `
          <li>
            <span>#${i+1} — <strong>${r.name || '—'}</strong> (${r.votes || 0} votos)</span>
            <span class="score">${r.total_score ?? '—'}</span>
          </li>`).join('')}
      </ul>
      <div style="margin-top:12px">
        <a class="pill" href="/">Voltar</a>
      </div>
    </div>`;
  res.send(layout({ title: "Leaderboard", body }));
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ----------- Start server -----------
app.listen(PORT, () => console.log(`Voting app rodando em http://localhost:${PORT}`));

