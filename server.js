// server.js
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { createCanvas, loadImage, registerFont } = require('canvas');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.sqlite');
const CERTS_DIR = path.join(__dirname, 'certs');

// Ensure certs folder exists
if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });

// Express setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/certs', express.static(CERTS_DIR));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace_with_secure_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 2 * 60 * 60 * 1000 } // 2 hours
}));

// Simple admin credentials
const ADMIN = { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' };

// SQLite init
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    name TEXT,
    usn TEXT,
    college TEXT,
    type TEXT,
    date TEXT,
    hours INTEGER,
    filename TEXT,
    created_at TEXT
  )`);
});

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session && req.session.user === ADMIN.username) return next();
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN.username && password === ADMIN.password) {
    req.session.user = ADMIN.username;
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Invalid credentials' });
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/admin', requireLogin, (req, res) => {
  db.all('SELECT id,name,usn,college,type,date,created_at,filename FROM certificates ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.render('admin', { certificates: rows });
  });
});

app.get('/generate', requireLogin, (req, res) => res.render('generate'));

// Generate certificate (Canvas-based)
app.post('/generate', requireLogin, async (req, res) => {
  try {
    const { name, usn, college, type, date, hours } = req.body;
    const id = randomUUID();
    const filename = `${id}.png`;
    const qrPublicUrl = `${req.protocol}://${req.get('host')}/view/${id}`;

    // Create QR code data URL
    const qrDataURL = await QRCode.toDataURL(qrPublicUrl, { margin: 1, width: 250 });
    const qrImage = await loadImage(qrDataURL);

    // Canvas setup
    const width = 1400;
    const height = 900;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Certificate Title
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 60pt Sans';
    ctx.fillText('Certificate of Completion', 100, 150);

    // Name
    ctx.font = '50pt Sans';
    ctx.fillText(name, 100, 300);

    // Details
    ctx.font = '30pt Sans';
    ctx.fillText(`USN: ${usn}`, 100, 400);
    ctx.fillText(`College: ${college}`, 100, 450);
    ctx.fillText(`Type: ${type}`, 100, 500);
    ctx.fillText(`Date: ${date}`, 100, 550);
    ctx.fillText(`Hours: ${hours || 0}`, 100, 600);

    // QR code
    ctx.drawImage(qrImage, width - 350, height - 350, 300, 300);

    // Save to file
    const filePath = path.join(CERTS_DIR, filename);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filePath, buffer);

    // Insert into DB
    db.run(`INSERT INTO certificates (id,name,usn,college,type,date,hours,filename,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
      [id, name, usn, college, type, date, hours || 0, filename]);

    res.redirect('/admin');
  } catch (err) {
    console.error('Generate error', err);
    res.status(500).send('Failed to generate certificate: ' + (err.message || err));
  }
});

// Download single certificate
app.get('/download/:id', requireLogin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT filename FROM certificates WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).send('Not found');
    res.download(path.join(CERTS_DIR, row.filename));
  });
});

// Download all certificates as ZIP
app.get('/download-all', requireLogin, (req, res) => {
  const zipName = `all-certificates-${Date.now()}.zip`;
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send({ error: err.message }));
  archive.pipe(res);

  fs.readdir(CERTS_DIR, (err, files) => {
    if (err) return res.status(500).send('Error reading certs folder');
    files.filter(f => f.endsWith('.png')).forEach(f => archive.file(path.join(CERTS_DIR, f), { name: f }));
    archive.finalize();
  });
});

// Public certificate viewing
app.get('/view/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM certificates WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).send('Certificate not found');
    res.render('view_cert', { cert: row });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Certificate system running: http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN.username} / ${ADMIN.password}`);
});
