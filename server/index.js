require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { outlinePdf } = require('@lillallol/outline-pdf');

const app = express();
app.use(cors());
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cleanup behavior configuration
const KEEP_AFTER_PROCESS = process.env.KEEP_AFTER_PROCESS === 'true'; // default false
const UPLOAD_TTL_HOURS = parseInt(process.env.UPLOAD_TTL_HOURS || '6', 10);

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn('Failed to delete file', filePath, e.message);
  }
}

app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const oldPath = req.file.path;
  const newPath = path.join(uploadDir, req.file.filename + '.pdf');
  fs.renameSync(oldPath, newPath);
  res.json({ id: req.file.filename + '.pdf', originalName: req.file.originalname });
});

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

app.post('/api/process', async (req, res) => {
  try {
    const { id, bookmarks } = req.body;
    console.log('Received id:', id);
    console.log('Received bookmarks:', bookmarks);

    if (!id) return res.status(400).json({ error: 'missing id' });

    const filePath = path.join(uploadDir, id);
    console.log('Constructed filePath:', filePath);
    console.log('File exists:', fs.existsSync(filePath));

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });

    const normalized = Array.isArray(bookmarks) ? sortBookmarksByPage(bookmarks) : [];
    const printedOutline = normalized.length > 0 ? buildPrintedOutline(normalized) : '';

    if (!printedOutline) {
      // If no bookmarks provided, just return original pdf
      const pdfBytes = fs.readFileSync(filePath);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="bookmarked.pdf"'
      });
      console.log('No bookmarks provided; returning original PDF');
      res.send(Buffer.from(pdfBytes));
      // Immediate cleanup after response is finished
      if (!KEEP_AFTER_PROCESS) {
        res.on('finish', () => safeUnlink(filePath));
      }
      return;
    }

    const savePath = path.join(uploadDir, `${path.parse(id).name}-outlined.pdf`);
    console.log('Outline string to apply:\n', printedOutline);

    // Apply outline/bookmarks to the PDF file and save
    await outlinePdf({
      loadPath: filePath,
      savePath,
      outline: printedOutline,
    });

    const outlinedPdf = fs.readFileSync(savePath);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="bookmarked.pdf"'
    });
    console.log('Sending outlined PDF with bookmarks embedded');
    res.send(Buffer.from(outlinedPdf));
    // Immediate cleanup after response is finished
    if (!KEEP_AFTER_PROCESS) {
      res.on('finish', () => {
        safeUnlink(savePath);
        safeUnlink(filePath);
      });
    }
    return;

  } catch (err) {
    console.error('Processing error', err);
    return res.status(500).json({ error: err.message || 'processing error' });
  }
});

app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));
app.get('*', (req, res) => {
  const index = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(404).send('Not found');
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Server listening on', PORT));

// TTL sweep: delete files older than UPLOAD_TTL_HOURS
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

// run every 30 minutes
setInterval(sweepUploadsDirectory, 30 * 60 * 1000);
// also run once at startup
sweepUploadsDirectory();
