require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { outlinePdf } = require('@lillallol/outline-pdf');
const Tesseract = require('tesseract.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const uploadDir = path.join(__dirname, '../uploads'); // now one level up (root/uploads)
const imageUploadDir = path.join(__dirname, '../uploads/images'); // separate directory for images
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(imageUploadDir)) fs.mkdirSync(imageUploadDir, { recursive: true });

const KEEP_AFTER_PROCESS = process.env.KEEP_AFTER_PROCESS === 'true';
const UPLOAD_TTL_HOURS = parseInt(process.env.UPLOAD_TTL_HOURS || '6', 10);

const upload = multer({ dest: uploadDir });
const imageUpload = multer({
  dest: imageUploadDir,
  fileFilter: (req, file, cb) => {
    // Check if file is an image
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

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

app.post('/api/upload-image', imageUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Get file extension from original filename
    const originalName = req.file.originalname;
    const fileExtension = path.extname(originalName);

    // Create new filename with timestamp to avoid conflicts
    const timestamp = Date.now();
    const newFilename = `img_${timestamp}${fileExtension}`;
    const oldPath = req.file.path;
    const newPath = path.join(imageUploadDir, newFilename);

    // Rename the file to include proper extension
    fs.renameSync(oldPath, newPath);

    // Extract text from the image using Tesseract.js
    let extractedText = '';
    try {
      const result = await Tesseract.recognize(newPath, 'eng', {
        logger: m => console.log(m)
      });
      extractedText = result.data.text.trim();
    } catch (ocrError) {
      console.error('OCR error:', ocrError);
      extractedText = 'Text extraction failed';
    }

    // Delete the image file after text extraction (since user only needs the text)
    try {
      fs.unlinkSync(newPath);
      console.log(`Deleted processed image: ${newFilename}`);
    } catch (deleteError) {
      console.warn(`Failed to delete image ${newFilename}:`, deleteError.message);
    }

    // Return success response with file info and extracted text
    res.json({
      success: true,
      message: 'Image processed and text extracted successfully',
      originalName: originalName,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
      extractedText: extractedText
    });

  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({
      error: 'Failed to upload image',
      details: error.message
    });
  }
});

// Error handling middleware for multer errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        details: 'Maximum file size is 10MB'
      });
    }
    return res.status(400).json({
      error: 'File upload error',
      details: error.message
    });
  }

  if (error.message === 'Only image files are allowed!') {
    return res.status(400).json({
      error: 'Invalid file type',
      details: 'Only image files are allowed'
    });
  }

  next(error);
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
