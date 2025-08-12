require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { outlinePdf } = require('@lillallol/outline-pdf');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const uploadDir = path.join(__dirname, '../uploads'); // now one level up (root/uploads)
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const KEEP_AFTER_PROCESS = process.env.KEEP_AFTER_PROCESS === 'true';
const UPLOAD_TTL_HOURS = parseInt(process.env.UPLOAD_TTL_HOURS || '6', 10);

const upload = multer({ dest: uploadDir });

// ===== HELPERS =====
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn('Failed to delete file', filePath, e.message);
  }
}

function sortBookmarksByPage(nodes = []) {
  return nodes
    .slice()
    .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0))
    .map((n) => ({
      ...n,
      children: Array.isArray(n.children) ? sortBookmarksByPage(n.children) : [],
    }));
}

function buildPrintedOutline(bookmarks, depth = 0, lines = []) {
  bookmarks.forEach((b) => {
    const page = parseInt(b.page, 10) || 1;
    const title = (b.title || '').replace(/\n/g, ' ');
    const depthMarkers = '-'.repeat(depth);
    lines.push(`${page}|${depthMarkers}|${title}`);
    if (Array.isArray(b.children) && b.children.length > 0) {
      buildPrintedOutline(b.children, depth + 1, lines);
    }
  });
  return lines.join('\n');
}

// ===== API ROUTES =====
app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const oldPath = req.file.path;
  const newPath = path.join(uploadDir, req.file.filename + '.pdf');
  fs.renameSync(oldPath, newPath);
  res.json({ id: req.file.filename + '.pdf', originalName: req.file.originalname });
});

app.post('/api/process', async (req, res) => {
  try {
    const { id, bookmarks } = req.body;
    if (!id) return res.status(400).json({ error: 'missing id' });

    const filePath = path.join(uploadDir, id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });

    const normalized = Array.isArray(bookmarks) ? sortBookmarksByPage(bookmarks) : [];
    const printedOutline = normalized.length > 0 ? buildPrintedOutline(normalized) : '';

    if (!printedOutline) {
      const pdfBytes = fs.readFileSync(filePath);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="bookmarked.pdf"',
      });
      res.send(Buffer.from(pdfBytes));
      if (!KEEP_AFTER_PROCESS) {
        res.on('finish', () => safeUnlink(filePath));
      }
      return;
    }

    const savePath = path.join(uploadDir, `${path.parse(id).name}-outlined.pdf`);
    await outlinePdf({
      loadPath: filePath,
      savePath,
      outline: printedOutline,
    });

    const outlinedPdf = fs.readFileSync(savePath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="bookmarked.pdf"',
    });
    res.send(Buffer.from(outlinedPdf));

    if (!KEEP_AFTER_PROCESS) {
      res.on('finish', () => {
        safeUnlink(savePath);
        safeUnlink(filePath);
      });
    }
  } catch (err) {
    console.error('Processing error', err);
    return res.status(500).json({ error: err.message || 'processing error' });
  }
});

// ===== SERVE FRONTEND IN PRODUCTION =====
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(frontendPath));

  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// ===== START SERVER =====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

// ===== FILE CLEANUP (TTL) =====
function sweepUploadsDirectory() {
  try {
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    const ttlMs = UPLOAD_TTL_HOURS * 60 * 60 * 1000;
    files.forEach((name) => {
      const p = path.join(uploadDir, name);
      try {
        const stat = fs.statSync(p);
        const age = now - stat.mtimeMs;
        if (age > ttlMs) {
          safeUnlink(p);
        }
      } catch (e) {
        // ignore
      }
    });
  } catch (e) {
    console.warn('Sweep failed', e.message);
  }
}
setInterval(sweepUploadsDirectory, 30 * 60 * 1000);
sweepUploadsDirectory();
