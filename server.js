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
const PUBLIC_DIR = path.join(__dirname, 'public');

// make sure folders exist
if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// optional: register a font if you have a ttf in /public/fonts (uncomment & adjust)
// try { registerFont(path.join(__dirname, 'public/fonts/Inter-Regular.ttf'), { family: 'Inter' }); } catch (e) {}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(PUBLIC_DIR));
app.use('/certs', express.static(CERTS_DIR));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace_with_secure_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 2 * 60 * 60 * 1000 }
}));

const ADMIN = { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123' };

// DB init
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

// helper to convert local image file -> base64 data URL
function fileToDataURL(filePath) {
  try {
    const ext = path.extname(filePath).substring(1) || 'png';
    const data = fs.readFileSync(filePath);
    return `data:image/${ext};base64,${data.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// middleware
function requireLogin(req, res, next) {
  if (req.session && req.session.user === ADMIN.username) return next();
  res.redirect('/login');
}

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

// Canvas certificate renderer
async function renderCertificateToPNG({ name, usn, college, type, date, hours, certId, outPath }) {
  const width = 1280; // match your template width
  const height = 820;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // COLORS / STYLES (matching your CSS)
  const bg1 = '#ffffff';
  const bg2 = '#fafbff';
  const accent = '#0b5ed7';
  const accentDark = '#052c65';
  const muted = '#5a6779';

  // Simple gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#f0f4fb');
  grad.addColorStop(1, '#eef6ff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // inner paper
  const pad = 40;
  const paperX = pad;
  const paperY = pad;
  const paperW = width - pad * 2;
  const paperH = height - pad * 2;

  // paper background (subtle)
  const innerGrad = ctx.createLinearGradient(0, paperY, 0, paperY + paperH);
  innerGrad.addColorStop(0, bg1);
  innerGrad.addColorStop(1, bg2);
  ctx.fillStyle = innerGrad;
  ctx.fillRect(paperX, paperY, paperW, paperH);

  // double border
  ctx.strokeStyle = accentDark;
  ctx.lineWidth = 12;
  roundRect(ctx, paperX, paperY, paperW, paperH, 12, false, true);

  // Header logos
  const logoLeftPath = path.join(__dirname, 'public', 'logos', 'gov_karnataka_logo.png');
  const logoRightPath = path.join(__dirname, 'public', 'logos', 'vtu_logo.png');

  let leftLogoImg = null, rightLogoImg = null;
  try { leftLogoImg = await loadImage(logoLeftPath); } catch (e) { /* ignore */ }
  try { rightLogoImg = await loadImage(logoRightPath); } catch (e) { /* ignore */ }

  const headerTop = paperY + 20;
  const logoH = 90;
  if (leftLogoImg) ctx.drawImage(leftLogoImg, paperX + 20, headerTop, logoH * (leftLogoImg.width / leftLogoImg.height), logoH);
  if (rightLogoImg) {
    const rw = logoH * (rightLogoImg.width / rightLogoImg.height);
    ctx.drawImage(rightLogoImg, paperX + paperW - 20 - rw, headerTop, rw, logoH);
  }

  // Center header text
  ctx.fillStyle = accentDark;
  ctx.font = '700 20px "Sans"';
  ctx.textAlign = 'center';
  ctx.fillText('Government Engineering College', paperX + paperW / 2, headerTop + 28);

  ctx.fillStyle = muted;
  ctx.font = '16px "Sans"';
  ctx.fillText('Department of Computer Science & Engineering', paperX + paperW / 2, headerTop + 52);

  ctx.fillStyle = accent;
  ctx.font = '700 40px "Sans"';
  ctx.fillText('Certificate of Participation', paperX + paperW / 2, headerTop + 110);

  ctx.fillStyle = '#333';
  ctx.font = '18px "Sans"';
  ctx.fillText('This is to certify the achievement of the participant named below', paperX + paperW / 2, headerTop + 140);

  // Body
  ctx.textAlign = 'left';
  ctx.fillStyle = '#000';
  ctx.font = 'bold 20px "Sans"';
  ctx.fillText('This is to certify that', paperX + 60, paperY + 210);

  ctx.font = '700 30px "Sans"';
  ctx.fillStyle = accentDark;
  ctx.fillText(name || '-', paperX + 60, paperY + 260);

  ctx.font = '500 16px "Sans"';
  ctx.fillStyle = muted;
  ctx.fillText(`(USN: ${usn || '-'})`, paperX + 60, paperY + 290);

  // meta paragraph
  ctx.font = '600 18px "Sans"';
  ctx.fillStyle = '#222';
  const meta = `has successfully participated in the ${type || '-'} organized by ${college || '-'} on ${date || '-'}. The event was conducted for a duration of ${hours || 0} hour${hours && parseInt(hours) > 1 ? 's' : ''}.`;
  wrapText(ctx, meta, paperX + 60, paperY + 350, paperW - 420, 26);

  // still-para (italic)
  ctx.font = 'italic 16px "Sans"';
  ctx.fillStyle = '#333';
  const still = `This certificate is awarded as a recognition of the student’s active participation and commitment towards enhancing their technical knowledge and professional development. It stands as a formal acknowledgment of the skills and dedication demonstrated during the course of the event.`;
  wrapText(ctx, still, paperX + 60, paperY + 460, paperW - 420, 22);

  // signatures (simple lines)
  const sigY = paperY + paperH - 140;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(paperX + 120, sigY);
  ctx.lineTo(paperX + 120 + 260, sigY);
  ctx.stroke();
  ctx.font = '16px "Sans"';
  ctx.fillStyle = '#222';
  ctx.fillText('Head of Department', paperX + 120 + 30, sigY + 24);

  ctx.beginPath();
  ctx.moveTo(paperX + paperW - 120 - 260, sigY);
  ctx.lineTo(paperX + paperW - 120, sigY);
  ctx.stroke();
  ctx.fillText('Principal', paperX + paperW - 120 - 260 + 60, sigY + 24);

  // QR code: generate and draw
  const qrDataURL = await QRCode.toDataURL(`${process.env.SITE_URL || 'http://localhost:' + PORT}/view/${certId}`, { width: 300, margin: 1 });
  const qrImg = await loadImage(qrDataURL);
  ctx.drawImage(qrImg, paperX + paperW - 350, paperY + paperH - 350, 300, 300);

  // footer id
  ctx.font = '14px "Sans"';
  ctx.fillStyle = muted;
  ctx.fillText(`Certificate ID: ${certId}`, paperX + 24, paperY + paperH - 24);

  // write buffer to file
  const outBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, outBuffer);
  return { qrDataURL }; // return QR so caller can reuse it if needed
}

// tiny helper: rounded rect
function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  if (typeof r === 'undefined') r = 5;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// wrap text helper
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

// Generate certificate (Canvas-based)
app.post('/generate', requireLogin, async (req, res) => {
  try {
    const { name, usn, college, type, date, hours } = req.body;
    const id = randomUUID();
    const filename = `${id}.png`;
    const outPath = path.join(CERTS_DIR, filename);

    const { qrDataURL } = await renderCertificateToPNG({
      name, usn, college, type, date, hours,
      certId: id,
      outPath
    });

    // Insert into DB
    db.run(`INSERT INTO certificates (id,name,usn,college,type,date,hours,filename,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
      [id, name, usn, college, type, date, hours || 0, filename], err => { if (err) console.error(err); });

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

// Download all as ZIP
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
  db.get('SELECT * FROM certificates WHERE id = ?', [id], async (err, row) => {
    if (err || !row) return res.status(404).send('Certificate not found');

    // create QR for this public view (for the template)
    const qrDataURL = await QRCode.toDataURL(`${req.protocol}://${req.get('host')}/view/${id}`, { margin: 1, width: 300 });

    // Inline logos as base64 for the HTML template
    const logoGov = fileToDataURL(path.join(__dirname, 'public', 'logos', 'gov_karnataka_logo.png'));
    const logoVTU = fileToDataURL(path.join(__dirname, 'public', 'logos', 'vtu_logo.png'));

    res.render('cert_template', {
      name: row.name,
      usn: row.usn,
      college: row.college,
      type: row.type,
      date: row.date,
      hours: row.hours,
      qrDataURL,
      logoGovDataURL: logoGov,
      logoVTUDataURL: logoVTU,
      certId: row.id
    });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Certificate system running: http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN.username} / ${ADMIN.password}`);
});
