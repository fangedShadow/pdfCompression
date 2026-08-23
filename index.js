const cors = require('cors');
const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const os = require('os');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { compress } = require('compress-pdf');
const dotenv = require('dotenv');


dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const maxFileSize = Number(process.env.MAX_FILE_SIZE_BYTES) || 25 * 1024 * 1024;
const compressionResolution = process.env.PDF_RESOLUTION || 'ebook';
const imageQuality = Number(process.env.PDF_IMAGE_QUALITY) || 72;
const compressedFilePrefix = process.env.COMPRESSED_FILE_PREFIX || 'compressed_';
const compressionConcurrency = Number(process.env.COMPRESSION_CONCURRENCY)
  || Math.max(1, Math.min(os.cpus().length, 4));
const maxQueueSize = Number(process.env.MAX_QUEUE_SIZE) || 1000;
const compressionRateLimit = Number(process.env.COMPRESSION_RATE_LIMIT) || 60;
const configuredApiKey = process.env.COMPRESS_API_KEY;
const compressionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: compressionRateLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many compression requests. Try again later.' },
  },
});
let activeCompressionJobs = 0;
const compressionQueue = [];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: 1 },
});

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

function isAuthorized(request) {
  if (!configuredApiKey) return process.env.NODE_ENV !== 'production';

  const suppliedKey = request.get('x-api-key');
  if (!suppliedKey || suppliedKey.length !== configuredApiKey.length) return false;

  return require('crypto').timingSafeEqual(
    Buffer.from(suppliedKey),
    Buffer.from(configuredApiKey),
  );
}

function sendError(response, status, code, message) {
  return response.status(status).json({
    success: false,
    error: { code, message },
  });
}

function getCompressedFilename(originalFilename) {
  const safeFilename = path.basename(originalFilename).replace(/["\\\r\n]/g, '_');
  const safePrefix = compressedFilePrefix.replace(/["\\\r\n]/g, '_');
  return `${safePrefix}${safeFilename}`;
}

function acquireCompressionSlot() {
  if (activeCompressionJobs < compressionConcurrency) {
    activeCompressionJobs += 1;
    return Promise.resolve(() => {
      activeCompressionJobs -= 1;
      processNextCompressionJob();
    });
  }

  if (compressionQueue.length >= maxQueueSize) {
    return Promise.reject(new Error('COMPRESSION_QUEUE_FULL'));
  }

  return new Promise((resolve) => compressionQueue.push(resolve));
}

function processNextCompressionJob() {
  if (activeCompressionJobs >= compressionConcurrency || compressionQueue.length === 0) return;

  activeCompressionJobs += 1;
  const resolve = compressionQueue.shift();
  resolve(() => {
    activeCompressionJobs -= 1;
    processNextCompressionJob();
  });
}

function releaseCompressionSlot(request) {
  if (request.compressionSlot) {
    request.compressionSlot();
    request.compressionSlot = null;
  }
}

app.post('/compress', compressionLimiter, (request, response, next) => {
  if (!isAuthorized(request)) {
    return sendError(response, 401, 'UNAUTHORIZED', 'A valid x-api-key header is required.');
  }

  return acquireCompressionSlot().then((release) => {
    request.compressionSlot = release;
    return upload.single('file')(request, response, (error) => {
      if (error) releaseCompressionSlot(request);
      if (error) return next(error);
      return next();
    });
  }).catch((error) => {
    if (error.message === 'COMPRESSION_QUEUE_FULL') {
      response.set('Retry-After', '30');
      return sendError(response, 503, 'QUEUE_FULL', 'The compression service is busy. Retry this request shortly.');
    }
    if (error) return next(error);
  });
}, async (request, response, next) => {
  if (!request.file) {
    releaseCompressionSlot(request);
    return sendError(response, 400, 'FILE_REQUIRED', 'Upload one PDF in the "file" form field.');
  }

  const isPdf = request.file.mimetype === 'application/pdf'
    || request.file.originalname.toLowerCase().endsWith('.pdf');
  const hasPdfSignature = request.file.buffer.subarray(0, 5).toString() === '%PDF-';
  if (!isPdf || !hasPdfSignature) {
    releaseCompressionSlot(request);
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
    releaseCompressionSlot(request);
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
