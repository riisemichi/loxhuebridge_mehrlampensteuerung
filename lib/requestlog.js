const configManager = require('./config');
const logger = require('./logger');

// Statische Dateien des Dashboards und das Dashboard-Polling (/api/*) würden das Log fluten.
const STATIC_ASSET_PATTERN = /\.(?:js|css|html|png|jpg|jpeg|svg|ico|json|map|webmanifest|woff2?)$/i;

function shouldLogRequest(path) {
    if (path === '/' || path.startsWith('/api/')) return false;
    return !STATIC_ASSET_PATTERN.test(path);
}

// Protokolliert jede eingehende Anfrage mit Status, Dauer und Absender, auch wenn sie
// vor dem Router abgewiesen wird (z. B. 401 durch den Passwortschutz). Ohne Query-String,
// damit keine Tokens im Log landen.
function requestLogger(req, res, next) {
    if (!configManager.config.logRequests || !shouldLogRequest(req.path)) return next();
    const startedAt = Date.now();
    res.on('finish', () => {
        const client = req.ip || req.socket?.remoteAddress || '?';
        const level = res.statusCode >= 400 ? 'warn' : 'info';
        logger[level](`HTTP ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt} ms, von ${client})`, 'HTTP');
    });
    next();
}

module.exports = { requestLogger, shouldLogRequest };
