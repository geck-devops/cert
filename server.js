// server.js
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer-core');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { randomUUID } = require('crypto');
const os = require('os');
const child_process = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.sqlite');
const CERTS_DIR = path.join(__dirname, 'certs');

// small portable sleep helper (works regardless of puppeteer version)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Simple admin credentials (change in production)
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

/**
 * Try to find a Chrome / Chromium executable on the system.
 *  - honor process.env.CHROME_PATH (explicit override)
 *  - check common install paths per-OS
 *  - try `which` / `where` for common binary names
 * Returns a path string or null.
 */
function findChromeExecutable() {
  try {
    // 1) Env override
    const envPath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const platform = os.platform();
    const candidates = [];

    if (platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
      );
      // check 'where' for common exe names as fallback
      try {
        const whereOut = child_process.execSync('where chrome', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0];
        if (whereOut && fs.existsSync(whereOut)) return whereOut;
      } catch (e) {
        // ignore
      }
    } else if (platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      );
      // try `which`
      try {
        const whichOut = child_process.execSync('which google-chrome || which chrome || which chromium || which chromium-browser', { stdio: ['pipe', 'pipe', 'ignore'], shell: true }).toString().trim();
        if (whichOut && fs.existsSync(whichOut)) return whichOut;
      } catch (e) { /* ignore */ }
    } else {
      // linux/unix
      candidates.push(
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/msedge'
      );
      // try `which` for multiple names
      try {
        const whichOut = child_process.execSync('which google-chrome || which google-chrome-stable || which chromium-browser || which chromium || which chrome', { stdio: ['pipe', 'pipe', 'ignore'], shell: true }).toString().trim();
        if (whichOut && fs.existsSync(whichOut)) return whichOut;
      } catch (e) { /* ignore */ }
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
  } catch (err) {
    // ignore detection errors
    console.error('Chrome detection error:', err && err.message ? err.message : err);
  }
  return null;
}

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session && req.session.user === ADMIN.username) return next();
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN.username && password === ADMIN.password) {
    req.session.user = ADMIN.username;
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Invalid credentials' });
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/admin', requireLogin, (req, res) => {
  db.all('SELECT id,name,usn,college,type,date,created_at,filename FROM certificates ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.render('admin', { certificates: rows });
  });
});

app.get('/generate', requireLogin, (req, res) => {
  res.render('generate');
});

app.post('/generate', requireLogin, async (req, res) => {
  let browser;
  try {
    const { name, usn, college, type, date, hours } = req.body;
    const id = randomUUID();
    const filename = `${id}.png`;
    const qrPublicUrl = `${req.protocol}://${req.get('host')}/view/${id}`;

    // create dataURL for QR (embed in cert template)
    const qrDataURL = await QRCode.toDataURL(qrPublicUrl, { margin: 1, width: 300 });

    // render EJS cert template to html string
    const html = await new Promise((resolve, reject) => {
      app.render('cert_template', { name, usn, college, type, date, hours, qrDataURL }, (err, str) => {
        if (err) reject(err); else resolve(str);
      });
    });

    // find chrome executable
    const executablePath = findChromeExecutable();
    if (!executablePath) {
      console.error('No Chrome/Chromium found. Set CHROME_PATH env var to point to your browser executable.');
      return res.status(500).send(
        `No Chrome/Chromium executable found on server. Set environment variable CHROME_PATH to your browser executable path.
Example (PowerShell): $env:CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" then restart the server.`
      );
    }

    // Launch puppeteer-core with detected executablePath
    try {
      browser = await puppeteer.launch({
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: true
      });
    } catch (launchErr) {
      console.error('Failed to launch puppeteer-core with executablePath:', executablePath, launchErr);
      return res.status(500).send(`Failed to launch browser at ${executablePath}: ${launchErr.message}`);
    }

    const page = await browser.newPage();
    // set viewport roughly for A4 landscape look
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });

    // load content
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // wait small time to ensure fonts/images render (reliable fallback)
    await sleep(300);

    const filePath = path.join(CERTS_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true, omitBackground: false });

    // insert into DB
    db.run(`INSERT INTO certificates (id,name,usn,college,type,date,hours,filename,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
      [id, name, usn, college, type, date, hours || 0, filename], err => {
        if (err) console.error(err);
      });

    res.redirect('/admin');
  } catch (err) {
    console.error('Generate error', err);
    res.status(500).send('Failed to generate certificate: ' + (err && err.message ? err.message : err));
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore close errors */ }
    }
  }
});

// Download a single cert (optional)
app.get('/download/:id', requireLogin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT filename FROM certificates WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).send('Not found');
    const filePath = path.join(CERTS_DIR, row.filename);
    res.download(filePath);
  });
});

// Download all generated certificate images as ZIP
app.get('/download-all', requireLogin, (req, res) => {
  const zipName = `all-certificates-${Date.now()}.zip`;

  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send({ error: err.message }));
  archive.pipe(res);

  // add only PNGs from certs folder (skip any zip inside)
  fs.readdir(CERTS_DIR, (err, files) => {
    if (err) return res.status(500).send('Error reading certs folder');
    files.filter(f => f.endsWith('.png')).forEach(f => {
      const p = path.join(CERTS_DIR, f);
      archive.file(p, { name: f });
    });
    archive.finalize();
  });
});

// Public certificate viewing route (scanning QR goes here)
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
  console.log(`Admin login: ${ADMIN.username} / ${ADMIN.password}  (change in server.js or via env vars)`);
  console.log('If no Chrome/Chromium is found automatically, set CHROME_PATH env var to your browser executable path.');
});
