const cors = require('cors');
const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { compress } = require('compress-pdf');

const app = express();
const port = Number(process.env.PORT) || 3000;
const maxFileSize = Number(process.env.MAX_FILE_SIZE_BYTES) || 25 * 1024 * 1024;
const compressionResolution = process.env.PDF_RESOLUTION || 'ebook';
const imageQuality = Number(process.env.PDF_IMAGE_QUALITY) || 72;
const compressedFilePrefix = process.env.COMPRESSED_FILE_PREFIX || 'compressed_';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: 1 },
});

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

function isAuthorized(request) {
  const configuredKey = process.env.COMPRESS_API_KEY;
  if (!configuredKey) return true;

  const suppliedKey = request.get('x-api-key');
  return suppliedKey === configuredKey;
}

function sendError(response, status, code, message) {
  return response.status(status).json({
    success: false,
    error: { code, message },
  });
}

function getCompressedFilename(originalFilename) {
  const safeFilename = path.basename(originalFilename).replace(/["\\\r\n]/g, '_');
  return `${compressedFilePrefix}${safeFilename}`;
}

app.post('/compress', (request, response, next) => {
  if (!isAuthorized(request)) {
    return sendError(response, 401, 'UNAUTHORIZED', 'A valid x-api-key header is required.');
  }

  return upload.single('file')(request, response, (error) => {
    if (error) return next(error);
    return next();
  });
}, async (request, response, next) => {
  if (!request.file) {
    return sendError(response, 400, 'FILE_REQUIRED', 'Upload one PDF in the "file" form field.');
  }

  const isPdf = request.file.mimetype === 'application/pdf'
    || request.file.originalname.toLowerCase().endsWith('.pdf');
  const hasPdfSignature = request.file.buffer.subarray(0, 5).toString() === '%PDF-';
  if (!isPdf || !hasPdfSignature) {
    return sendError(response, 415, 'INVALID_PDF', 'The uploaded file must be a valid PDF.');
  }

  let temporaryDirectory;
  try {
    temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-compress-'));
    const inputPath = path.join(temporaryDirectory, 'input.pdf');
    await fs.promises.writeFile(inputPath, request.file.buffer);
    const compressedBuffer = await compress(inputPath, {
      resolution: compressionResolution,
      imageQuality,
      compatibilityLevel: 1.4,
    });
    const compressedFilename = getCompressedFilename(request.file.originalname);

    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${compressedFilename}"`,
      'Content-Length': compressedBuffer.length,
      'X-Original-Size': request.file.size,
      'X-Compressed-Size': compressedBuffer.length,
    });
    console.log(`Compressed PDF from ${request.file.size} bytes to ${compressedBuffer.length} bytes.`);
    return response.send(compressedBuffer) ;
  } catch (error) {
    return next(error);
  } finally {
    if (temporaryDirectory) {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return sendError(response, 413, 'FILE_TOO_LARGE', `PDF must be smaller than ${maxFileSize} bytes.`);
    }
    return sendError(response, 400, 'UPLOAD_ERROR', error.message);
  }

  console.error(error);
  return sendError(response, 500, 'COMPRESSION_FAILED', 'The PDF could not be compressed.');
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`PDF compression service listening on port ${port}`);
  });
}

module.exports = app;
