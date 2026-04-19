const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('./config');

function resolveLogFile() {
  const candidates = [
    process.env.VOICE_WORKER_LOG_FILE,
    process.env.LOG_DIR ? path.join(process.env.LOG_DIR, 'voice-worker.log') : null,
    '/app/logs/voice-worker.log',
    '/tmp/openclaw-voice-worker/voice-worker.log',
  ].filter(Boolean);

  for (const filename of candidates) {
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      return filename;
    } catch (_) {}
  }

  return path.join(process.cwd(), 'voice-worker.log');
}

const logFile = resolveLogFile();

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: logFile,
      maxsize: 52428800, // 50MB
      maxFiles: 5
    })
  ]
});

module.exports = logger;
