const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-requestlog-'));
const configManager = require('../lib/config');
const logger = require('../lib/logger');
const { requestLogger, shouldLogRequest } = require('../lib/requestlog');
if (previousDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = previousDataDir;

logger.init(process.env.DATA_DIR || os.tmpdir(), true, false);

function runRequest(reqPath, statusCode, method = 'GET') {
    const req = { method, path: reqPath, ip: '10.0.0.5' };
    const res = new EventEmitter();
    let nextCalled = false;
    requestLogger(req, res, () => { nextCalled = true; });
    res.statusCode = statusCode;
    res.emit('finish');
    return nextCalled;
}

test('Request-Log: aus = nichts protokolliert', () => {
    logger.ramLogs = [];
    configManager.config.logRequests = false;
    assert.strictEqual(runRequest('/kueche/rgbw/50', 200), true);
    assert.strictEqual(logger.getLogs(10, 'HTTP').length, 0);
});

test('Request-Log: Loxone-Befehle mit Status, auch abgewiesene', () => {
    logger.ramLogs = [];
    configManager.config.logRequests = true;
    try {
        assert.strictEqual(runRequest('/kueche/rgbw/50', 200), true);
        runRequest('/kueche/rgbw/50', 401);
        const logs = logger.getLogs(10, 'HTTP');
        assert.strictEqual(logs.length, 2);
        assert.match(logs[1].msg, /^HTTP GET \/kueche\/rgbw\/50 -> 200 \(\d+ ms, von 10\.0\.0\.5\)$/);
        assert.strictEqual(logs[1].level, 'INFO');
        assert.match(logs[0].msg, /-> 401/);
        assert.strictEqual(logs[0].level, 'WARN');
    } finally {
        configManager.config.logRequests = false;
    }
});

test('Request-Log: Dashboard-Polling und statische Dateien werden ausgelassen', () => {
    assert.strictEqual(shouldLogRequest('/api/status'), false);
    assert.strictEqual(shouldLogRequest('/'), false);
    assert.strictEqual(shouldLogRequest('/app.js'), false);
    assert.strictEqual(shouldLogRequest('/style.css'), false);
    assert.strictEqual(shouldLogRequest('/dg-2.8-lampe/50'), true);
    assert.strictEqual(shouldLogRequest('/kueche/sunrise/30'), true);
});
