const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const originalLoad = Module._load;
const axiosGetCalls = [];
const axiosGetResponses = [];
Module._load = function mockOptionalDeps(request, parent, isMain) {
    if (request === 'express') {
        return {
            Router: () => {
                const router = {
                    stack: [],
                    get(path, handler) {
                        this.stack.push({ route: { path, stack: [{ handle: handler }] } });
                    },
                    post(path, handler) {
                        this.stack.push({ route: { path, stack: [{ handle: handler }] } });
                    }
                };
                return router;
            }
        };
    }
    if (request === 'axios') {
        const axiosMock = async () => ({ data: { data: [] } });
        axiosMock.get = async (url) => {
            axiosGetCalls.push(url);
            if (axiosGetResponses.length) {
                const response = axiosGetResponses.shift();
                if (response instanceof Error) throw response;
                if (typeof response === 'function') return response(url);
                return response;
            }
            return { data: { data: [] } };
        };
        axiosMock.post = async () => ({ data: [] });
        axiosMock.put = async () => ({ data: [] });
        return axiosMock;
    }
    if (request === 'mqtt') {
        return { connect: () => ({ on: () => {}, end: () => {}, publish: () => {}, connected: false }) };
    }

    return originalLoad(request, parent, isMain);
};

const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'loxhue-routes-'));
const configManager = require('../lib/config');
if (previousDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = previousDataDir;
const routes = require('../lib/routes');

function getRouteHandler(path) {
    const layer = routes.stack.find(l => l.route && l.route.path === path);
    return layer.route.stack[0].handle;
}

test('Routes - reservierte Discovery/API Pfade werden nicht als Loxone-Befehl behandelt', () => {
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('api'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('description.xml'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('upnp'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('wohnzimmer'), false);
});

test('Routes - unbekannte Textwerte werden mit HTTP 400 abgelehnt', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'light-1', hue_name: 'Test Lampe', loxone_name: 'test_lampe', hue_type: 'light' }
    ];

    const layer = routes.stack.find(l => l.route && l.route.path === '/:name/:value');
    const handler = layer.route.stack[0].handle;

    let statusCode = null;
    let body = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        send(content) {
            body = content;
            return this;
        }
    };

    await handler({ params: { name: 'test_lampe', value: 'foobar' } }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(body, 'Ungültiger Wert');
});

test('Routes - ungültige Warmweiss-CT-Werte werden mit HTTP 400 abgelehnt', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'light-1', hue_name: 'Test Lampe', loxone_name: 'test_lampe', hue_type: 'light' }
    ];

    const layer = routes.stack.find(l => l.route && l.route.path === '/:name/:value');
    const handler = layer.route.stack[0].handle;

    let statusCode = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        send() {
            return this;
        }
    };

    await handler({ params: { name: 'test_lampe', value: '201001500' } }, res);

    assert.strictEqual(statusCode, 400);
});

test('F06: API meldet Speicherfehler und behaelt Runtime-Werte', () => {
    const save = configManager.saveConfig;
    const previous = { ...configManager.config };
    configManager.saveConfig = () => { throw new Error('disk full'); };
    let status, result;
    try {
        getRouteHandler('/api/settings/debug')({ body: { active: !previous.debug } }, {
            status(code) { status = code; return this; },
            json(body) { result = body; }
        });
        assert.strictEqual(status, 500);
        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(configManager.config, previous);
    } finally { configManager.saveConfig = save; }
});

test('Routes - Security Status gibt keine Passwortdaten zurück', () => {
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = 'pbkdf2$1$salt$hash';

    const handler = getRouteHandler('/api/security/status');
    let payload = null;
    handler({}, { json: content => { payload = content; } });

    assert.deepStrictEqual(payload, {
        authEnabled: true,
        authUser: 'admin',
        passwordConfigured: true
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'authPasswordHash'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'password'), false);
});

test('Routes - Security Aktivierung ohne Passwort wird abgelehnt', () => {
    configManager.config.authEnabled = false;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = '';

    const handler = getRouteHandler('/api/security/settings');
    let statusCode = null;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(content) {
            payload = content;
            return this;
        }
    };

    handler({ body: { authEnabled: true, authUser: 'admin' } }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(payload.success, false);
    assert.strictEqual(configManager.config.authEnabled, false);
});

test('Routes - Security speichert Passwort nur als Hash', async () => {
    configManager.config.authEnabled = false;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = '';

    const handler = getRouteHandler('/api/security/settings');
    let payload = null;
    const res = {
        json(content) {
            payload = content;
            return this;
        }
    };

    await handler({ body: { authEnabled: true, authUser: 'admin', password: 'top-secret-pass' } }, res);

    assert.strictEqual(payload.success, true);
    assert.strictEqual(configManager.config.authEnabled, true);
    assert.notStrictEqual(configManager.config.authPasswordHash, 'top-secret-pass');
    assert.match(configManager.config.authPasswordHash, /^pbkdf2\$/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'authPasswordHash'), false);
});

test('Routes - Backup Redaction entfernt Zugangsdaten', () => {
    const redacted = routes._internals.redactConfigSecrets({
        bridgeIp: '192.168.1.10',
        appKey: 'hue-secret',
        mqttUser: 'mqtt-user',
        mqttPass: 'mqtt-secret',
        authToken: 'auth-secret',
        authPasswordHash: 'pbkdf2$1$salt$hash'
    });

    assert.strictEqual(redacted.bridgeIp, '192.168.1.10');
    assert.strictEqual(redacted.mqttUser, 'mqtt-user');
    assert.strictEqual(redacted.appKey, '***');
    assert.strictEqual(redacted.mqttPass, '***');
    assert.strictEqual(redacted.authToken, '***');
    assert.strictEqual(redacted.authPasswordHash, '***');
});

test('Routes - Mapping Settings speichert Sync-Offset und erlaubte Felder', () => {
    configManager.mapping = [
        {
            loxone_name: 'deckenlampe_top',
            hue_uuid: 'uuid-top',
            hue_name: 'Hue Decke Top',
            hue_type: 'light',
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: false,
            multi_sync_group: 'a',
            sync_offset_ms: 0
        }
    ];

    const handler = getRouteHandler('/api/mapping/:loxoneName/settings');
    let payload = null;
    const res = {
        json(content) {
            payload = content;
            return this;
        },
        status() {
            return this;
        }
    };

    handler({
        params: { loxoneName: 'deckenlampe_top' },
        body: {
            sync_lox: false,
            ignore_dynamics: true,
            multi_sync: true,
            multi_sync_group: 'b',
            sync_cluster: ' Deckenlampe ',
            sync_offset_ms: -50,
            hue_uuid: 'evil-change'
        }
    }, res);

    assert.strictEqual(payload.success, true);
    assert.strictEqual(configManager.mapping[0].sync_offset_ms, -50);
    assert.strictEqual(configManager.mapping[0].multi_sync_group, 'b');
    assert.strictEqual(configManager.mapping[0].sync_cluster, 'Deckenlampe');
    assert.strictEqual(configManager.mapping[0].multi_sync, true);
    assert.strictEqual(configManager.mapping[0].sync_lox, false);
    assert.strictEqual(configManager.mapping[0].ignore_dynamics, true);
    assert.strictEqual(configManager.mapping[0].verify_state, false);
    assert.strictEqual(configManager.mapping[0].split_on, false);
    assert.strictEqual(configManager.mapping[0].repeat_command, false);
    assert.strictEqual(configManager.mapping[0].hue_uuid, 'uuid-top');
});

test('Routes - Mapping Settings speichert genau eine Funkmaßnahme', () => {
    configManager.mapping = [
        {
            loxone_name: 'wohn_lampe',
            hue_uuid: 'uuid-wohn',
            hue_name: 'Hue Wohn',
            hue_type: 'light',
            sync_offset_ms: 0
        }
    ];

    const handler = getRouteHandler('/api/mapping/:loxoneName/settings');
    let payload = null;
    const res = {
        json(content) {
            payload = content;
            return this;
        },
        status() {
            return this;
        }
    };

    handler({
        params: { loxoneName: 'wohn_lampe' },
        body: {
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: true,
            multi_sync_group: 'a',
            sync_cluster: '',
            sync_offset_ms: 0,
            verify_state: true,
            split_on: false,
            repeat_command: false
        }
    }, res);

    assert.strictEqual(payload.success, true);
    assert.strictEqual(configManager.mapping[0].verify_state, true);
    assert.strictEqual(configManager.mapping[0].split_on, false);
    assert.strictEqual(configManager.mapping[0].repeat_command, false);
});

test('Routes - Mapping Settings lehnt mehrere Funkmaßnahmen gleichzeitig ab', () => {
    configManager.mapping = [
        {
            loxone_name: 'wohn_lampe',
            hue_uuid: 'uuid-wohn',
            hue_name: 'Hue Wohn',
            hue_type: 'light',
            sync_offset_ms: 0
        }
    ];

    const handler = getRouteHandler('/api/mapping/:loxoneName/settings');
    let statusCode = null;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(content) {
            payload = content;
            return this;
        }
    };

    handler({
        params: { loxoneName: 'wohn_lampe' },
        body: {
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: true,
            multi_sync_group: 'a',
            sync_cluster: '',
            sync_offset_ms: 0,
            verify_state: true,
            split_on: true,
            repeat_command: false
        }
    }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(payload.success, false);
});

test('Routes - Mapping Settings validiert und begrenzt Sync-Offset', () => {
    assert.strictEqual(routes._internals.parseSyncOffsetSetting(-900), -500);
    assert.strictEqual(routes._internals.parseSyncOffsetSetting(0), 0);
    assert.strictEqual(routes._internals.parseSyncOffsetSetting(100), 100);
    assert.strictEqual(routes._internals.parseSyncOffsetSetting(1007), 1000);
    assert.strictEqual(routes._internals.parseSyncOffsetSetting(23), 20);
    assert.throws(() => routes._internals.parseSyncOffsetSetting('abc'), /sync_offset_ms/);
    assert.strictEqual(routes._internals.parseSyncClusterSetting(' TV '), 'TV');
    assert.strictEqual(routes._internals.parseSyncClusterSetting(null), '');
    assert.strictEqual(routes._internals.parseSyncClusterSetting('123456789012345678901234567890123456789012345'), '1234567890123456789012345678901234567890');
});

test('Routes - leeres MQTT Passwort bleibt beim Speichern unverändert', () => {
    const hueManager = require('../lib/hue');
    const originalSaveConfig = configManager.saveConfig;
    const originalLoad = configManager.load;
    const originalStartEventStream = hueManager.startEventStream;
    configManager.saveConfig = candidate => { configManager.config = candidate; };
    configManager.load = () => {};
    hueManager.startEventStream = () => {};

    configManager.config.mqttPass = 'bestehend';

    const handler = getRouteHandler('/api/setup/loxone');
    let payload = null;
    const res = { json: content => { payload = content; } };

    handler({
        body: {
            loxoneIp: '192.168.1.2',
            loxonePort: 7000,
            mqttPass: '',
            multiLightControl: configManager.getDefaultMultiLightControl()
        }
    }, res);

    assert.strictEqual(payload.success, true);
    assert.strictEqual(configManager.config.mqttPass, 'bestehend');

    handler({
        body: {
            loxoneIp: '192.168.1.2',
            loxonePort: 7000,
            mqttPass: 'neu',
            multiLightControl: configManager.getDefaultMultiLightControl()
        }
    }, res);
    assert.strictEqual(configManager.config.mqttPass, 'neu');

    handler({
        body: {
            loxoneIp: '192.168.1.2',
            loxonePort: 7000,
            mqttPassClear: true,
            multiLightControl: configManager.getDefaultMultiLightControl()
        }
    }, res);
    assert.strictEqual(configManager.config.mqttPass, '');

    configManager.saveConfig = originalSaveConfig;
    configManager.load = originalLoad;
    hueManager.startEventStream = originalStartEventStream;
});

test('Routes - /api/targets liefert Teilresultate bei Hue-Ressourcenfehlern', async () => {
    axiosGetCalls.length = 0;
    axiosGetResponses.length = 0;
    configManager.isConfigured = true;
    configManager.config.bridgeIp = 'bridge';
    configManager.config.appKey = 'key';

    axiosGetResponses.push(
        { data: { data: [] } },
        { data: { data: [] } },
        { data: { data: [{ id: 'light-1', metadata: { name: 'Lampe 1' } }] } },
        new Error('room down'),
        { data: { data: [{ metadata: { name: 'Zone 1' }, services: [{ rtype: 'grouped_light', rid: 'grouped-1' }] }] } },
        { data: { data: [{ id: 'device-1', metadata: { name: 'Sensor 1' }, services: [{ rtype: 'motion', rid: 'motion-1' }] }] } }
    );

    const handler = getRouteHandler('/api/targets');
    let payload = null;
    let statusCode = 200;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(content) {
            payload = content;
            return this;
        }
    };

    await handler({}, res);

    assert.strictEqual(statusCode, 200);
    assert.ok(payload.find(item => item.uuid === 'light-1' && item.type === 'light'));
    assert.ok(payload.find(item => item.uuid === 'grouped-1' && item.type === 'group'));
    assert.ok(payload.find(item => item.uuid === 'motion-1' && item.type === 'sensor'));
});

test('Routes - Mapping Settings lehnt ungültige Felder ab', () => {
    configManager.mapping = [
        {
            loxone_name: 'wohn_lampe',
            hue_uuid: 'uuid-wohn',
            hue_name: 'Hue Wohn',
            hue_type: 'light',
            sync_offset_ms: 0
        }
    ];

    const handler = getRouteHandler('/api/mapping/:loxoneName/settings');
    let statusCode = null;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(content) {
            payload = content;
            return this;
        }
    };

    handler({
        params: { loxoneName: 'wohn_lampe' },
        body: {
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: true,
            multi_sync_group: 'z',
            sync_offset_ms: 0
        }
    }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(payload.success, false);
    assert.strictEqual(configManager.mapping[0].multi_sync_group, undefined);
});

test('Routes - XML Exports escape special characters', async (t) => {
    // Setup dummy mapping with special characters
    configManager.mapping = [
        {
            hue_uuid: 'uuid-1',
            hue_name: 'Wohnzimmer & Esszimmer "Licht" <1>',
            loxone_name: 'wz_esszimmer',
            hue_type: 'light'
        },
        {
            hue_uuid: 'uuid-2',
            hue_name: 'Sensor & Taster',
            loxone_name: 'sensor&taster',
            hue_type: 'sensor'
        }
    ];

    // Find route handlers directly from the Express Router stack to avoid network binding (EPERM)
    const layerOutputs = routes.stack.find(l => l.route && l.route.path === '/api/download/outputs');
    const handlerOutputs = layerOutputs.route.stack[0].handle;

    const layerInputs = routes.stack.find(l => l.route && l.route.path === '/api/download/inputs');
    const handlerInputs = layerInputs.route.stack[0].handle;

    // Test outputs export handler
    let outputsXml = '';
    let outputsHeaders = {};
    const resOutputs = {
        set: (k, v) => { outputsHeaders[k] = v; },
        send: (content) => { outputsXml = content; }
    };

    await handlerOutputs({ query: {} }, resOutputs);

    assert.strictEqual(outputsHeaders['Content-Type'], 'text/xml');
    assert.strictEqual(outputsXml.includes('&amp;'), true);
    assert.strictEqual(outputsXml.includes('&quot;'), true);
    assert.strictEqual(outputsXml.includes('&lt;1&gt;'), true);
    assert.strictEqual(outputsXml.includes('Wohnzimmer & Esszimmer'), false);

    // Test inputs export handler
    let inputsXml = '';
    let inputsHeaders = {};
    const resInputs = {
        set: (k, v) => { inputsHeaders[k] = v; },
        send: (content) => { inputsXml = content; }
    };

    handlerInputs({ query: {} }, resInputs);

    assert.strictEqual(inputsHeaders['Content-Type'], 'text/xml');
    assert.strictEqual(inputsXml.includes('VirtualInUdpCmd'), true);
    assert.strictEqual(inputsXml.includes('&amp;'), true);
    assert.strictEqual(inputsXml.includes('Sensor & Taster'), false);
});

test('Routes - typisierte Loxone-Pfade validieren je Befehlstyp', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'light-1', hue_name: 'Test Lampe', loxone_name: 'test_lampe', hue_type: 'light' }
    ];
    const handler = getRouteHandler('/:name/:type/:value');

    let statusCode = null;
    const res = {
        status(code) { statusCode = code; return this; },
        send() { return this; }
    };

    await handler({ params: { name: 'test_lampe', type: 'dim', value: '150' } }, res, () => {});
    assert.strictEqual(statusCode, 400);

    statusCode = null;
    await handler({ params: { name: 'test_lampe', type: 'rgb', value: 'candle' } }, res, () => {});
    assert.strictEqual(statusCode, 400);

    let nextCalled = false;
    statusCode = null;
    await handler({ params: { name: 'test_lampe', type: 'foo', value: '50' } }, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(statusCode, null);
});

function mockHueResourcesForExport(resources) {
    // URL-basierte Antworten für buildDeviceMap und die Gruppenauflösung (Cache-unabhängig)
    const respond = (url) => {
        const name = url.split('/resource/')[1];
        return { data: { data: resources[name] || [] } };
    };
    for (let i = 0; i < 20; i++) axiosGetResponses.push(respond);
}

test('Routes - XML Exports enthalten Befehlstypen und Loxone-Sync-Lichter', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'uuid-color', hue_name: 'Farbe', loxone_name: 'farbe', hue_type: 'light', sync_lox: true },
        { hue_uuid: 'uuid-ambiance', hue_name: 'Ambiance', loxone_name: 'ambiance', hue_type: 'light', sync_lox: false },
        { hue_uuid: 'uuid-white', hue_name: 'Weiss', loxone_name: 'weiss', hue_type: 'light', sync_lox: false },
        { hue_uuid: 'uuid-plug', hue_name: 'Stecker', loxone_name: 'stecker', hue_type: 'light', sync_lox: false },
        { hue_uuid: 'uuid-unknown', hue_name: 'Unbekannt', loxone_name: 'unbekannt', hue_type: 'light', sync_lox: false },
        { hue_uuid: 'uuid-room', hue_name: 'Raum', loxone_name: 'raum', hue_type: 'group', sync_lox: true },
        { hue_uuid: 'uuid-zone', hue_name: 'Zone', loxone_name: 'zone', hue_type: 'group', sync_lox: false },
        { hue_uuid: 'pseudo-all', hue_name: 'Alle Lichter', loxone_name: 'all', hue_type: 'group', sync_lox: false }
    ];
    mockHueResourcesForExport({
        light: [
            { id: 'uuid-color', owner: { rid: 'dev-color' }, on: {}, dimming: {}, color: {}, color_temperature: { mirek_schema: {} } },
            { id: 'uuid-ambiance', owner: { rid: 'dev-ambiance' }, on: {}, dimming: {}, color_temperature: { mirek_schema: {} } },
            { id: 'uuid-white', owner: { rid: 'dev-white' }, on: {}, dimming: {} },
            { id: 'uuid-plug', owner: { rid: 'dev-plug' }, on: {} }
        ],
        room: [{ id: 'room-1', services: [{ rtype: 'grouped_light', rid: 'uuid-room' }], children: [{ rtype: 'device', rid: 'dev-ambiance' }, { rtype: 'device', rid: 'dev-white' }] }],
        zone: [{ id: 'zone-1', services: [{ rtype: 'grouped_light', rid: 'uuid-zone' }], children: [{ rtype: 'light', rid: 'uuid-plug' }] }],
        device: [
            { id: 'dev-ambiance', services: [{ rtype: 'light', rid: 'uuid-ambiance' }] },
            { id: 'dev-white', services: [{ rtype: 'light', rid: 'uuid-white' }] }
        ]
    });

    try {
        let outputsXml = '';
        await getRouteHandler('/api/download/outputs')({ query: {} }, { set() {}, send(c) { outputsXml = c; } });
        const pathsFor = name => [...outputsXml.matchAll(new RegExp(`CmdOn="/${name}/([^"]*)"`, 'g'))].map(m => m[1]);

        // Genau ein Eintrag pro Lampe, passend zur Fähigkeit
        assert.deepStrictEqual(pathsFor('farbe'), ['rgbw/&lt;v&gt;']);
        assert.deepStrictEqual(pathsFor('ambiance'), ['ct/&lt;v&gt;']);
        assert.deepStrictEqual(pathsFor('weiss'), ['dim/&lt;v&gt;']);
        assert.deepStrictEqual(pathsFor('stecker'), ['switch/&lt;v&gt;']);
        assert.ok(outputsXml.includes('Title="Farbe (Hue) RGBW"'));
        // Unbekannte Fähigkeiten: alle Varianten als Fallback
        assert.deepStrictEqual(pathsFor('unbekannt'), ['&lt;v&gt;', 'dim/&lt;v&gt;', 'rgbw/&lt;v&gt;', 'ct/&lt;v&gt;']);
        // Gruppen vereinen die Fähigkeiten ihrer Lampen, Zonen auch mit direkten Lampen-Kindern
        assert.deepStrictEqual(pathsFor('raum'), ['ct/&lt;v&gt;']);
        assert.deepStrictEqual(pathsFor('zone'), ['switch/&lt;v&gt;']);
        assert.deepStrictEqual(pathsFor('all'), ['rgbw/&lt;v&gt;']);

        let inputsXml = '';
        getRouteHandler('/api/download/inputs')({ query: {} }, { set() {}, send(c) { inputsXml = c; } });
        for (const key of ['on', 'bri', 'mirek', 'kelvin', 'rgb', 'lumitech']) {
            assert.ok(inputsXml.includes(`Check="hue.farbe.${key} \\v"`), `hue.farbe.${key} fehlt`);
        }
        assert.ok(inputsXml.includes('Check="hue.raum.on \\v"'));
        assert.ok(inputsXml.includes('Check="hue.raum.bri \\v"'));
        assert.strictEqual(inputsXml.includes('hue.raum.rgb'), false);
        assert.strictEqual(inputsXml.includes('hue.weiss.'), false);
    } finally {
        axiosGetResponses.length = 0;
    }
});

function renameMappingRequest(loxoneName, newName) {
    const handler = getRouteHandler('/api/mapping/:loxoneName/settings');
    const result = { statusCode: 200, payload: null };
    const res = {
        status(code) { result.statusCode = code; return this; },
        json(content) { result.payload = content; return this; }
    };
    handler({
        params: { loxoneName },
        body: {
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: true,
            multi_sync_group: 'b',
            sync_cluster: 'Decke',
            sync_offset_ms: 30,
            ...(newName === undefined ? {} : { loxone_name: newName })
        }
    }, res);
    return result;
}

function setupRenameMappings() {
    configManager.mapping = [
        { loxone_name: 'kueche', hue_uuid: 'uuid-kueche', hue_name: 'Hue Küche', hue_type: 'light', sync_offset_ms: 0 },
        { loxone_name: 'flur', hue_uuid: 'uuid-flur', hue_name: 'Hue Flur', hue_type: 'light', sync_offset_ms: 0 }
    ];
    configManager.statusCache = { kueche: { on: 1, bri: 40 } };
    configManager.detectedItems = [{ type: 'command', name: 'kueche_neu', id: 'cmd_kueche_neu' }];
}

test('Routes - Mapping Settings benennt Loxone Namen um und behält Einstellungen', () => {
    setupRenameMappings();
    const { statusCode, payload } = renameMappingRequest('kueche', '  Kueche_Neu ');

    assert.strictEqual(statusCode, 200);
    assert.strictEqual(payload.success, true);
    assert.strictEqual(payload.mapping.loxone_name, 'kueche_neu');
    const entry = configManager.mapping.find(m => m.hue_uuid === 'uuid-kueche');
    assert.strictEqual(entry.loxone_name, 'kueche_neu');
    assert.strictEqual(entry.hue_name, 'Hue Küche');
    assert.strictEqual(entry.multi_sync_group, 'b');
    assert.strictEqual(entry.sync_cluster, 'Decke');
    assert.strictEqual(entry.sync_offset_ms, 30);
    assert.deepStrictEqual(configManager.statusCache.kueche_neu, { on: 1, bri: 40 });
    assert.strictEqual(configManager.statusCache.kueche, undefined);
    assert.strictEqual(configManager.detectedItems.length, 0);
});

test('Routes - Mapping Settings lehnt doppelte, reservierte und ungültige Loxone Namen ab', () => {
    for (const name of ['flur', 'all', 'Alles', 'api', 'gruppe_a', 'group_b', 'a/b', 'a b', 'a.b', '', '   ', 'x'.repeat(65), 42]) {
        setupRenameMappings();
        const { statusCode, payload } = renameMappingRequest('kueche', name);
        assert.strictEqual(statusCode, 400, `Name ${JSON.stringify(name)}`);
        assert.strictEqual(payload.success, false);
        assert.strictEqual(configManager.mapping[0].loxone_name, 'kueche');
        assert.strictEqual(configManager.mapping[0].multi_sync_group, undefined);
    }
});

test('Routes - Mapping Settings ohne loxone_name behält den Namen', () => {
    setupRenameMappings();
    const { statusCode, payload } = renameMappingRequest('kueche');
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(payload.mapping.loxone_name, 'kueche');
    assert.deepStrictEqual(configManager.statusCache.kueche, { on: 1, bri: 40 });
});

test('Routes - unveränderter älterer Loxone Name bleibt gültig', () => {
    const entry = { loxone_name: 'alter name' };
    configManager.mapping = [entry];
    assert.strictEqual(routes._internals.parseLoxoneNameSetting(' Alter Name ', entry), 'alter name');
});

test('Routes - Szenen: /<name>/1 und /<name>/0 rufen executeScene auf, andere Werte nicht', async () => {
    const hueManager = require('../lib/hue');
    const originalExecuteScene = hueManager.executeScene;
    const calls = [];
    hueManager.executeScene = async (entry, value) => { calls.push([entry.loxone_name, value]); return true; };
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'scene-1', hue_name: 'Büro: Lesen', loxone_name: 'buero_lesen', hue_type: 'scene', scene_group_rid: 'room-1', scene_group_rtype: 'room' }
    ];

    let statusCode = null;
    let body = null;
    const res = {
        status(code) { statusCode = code; return this; },
        send(content) { body = content; return this; }
    };
    try {
        const valueHandler = getRouteHandler('/:name/:value');
        await valueHandler({ params: { name: 'buero_lesen', value: '1' } }, res);
        assert.strictEqual(statusCode, 200);
        assert.strictEqual(body, 'OK Scene');
        await valueHandler({ params: { name: 'buero_lesen', value: '0' } }, res);
        assert.strictEqual(body, 'OK Scene Off');
        assert.deepStrictEqual(calls, [['buero_lesen', '1'], ['buero_lesen', '0']]);

        for (const value of ['candle', 'alert', 'abc', '-1']) {
            statusCode = null;
            await valueHandler({ params: { name: 'buero_lesen', value } }, res);
            assert.strictEqual(statusCode, 400, value);
        }

        statusCode = null;
        await getRouteHandler('/:name/:type/:value')({ params: { name: 'buero_lesen', type: 'dim', value: '50' } }, res, () => {});
        assert.strictEqual(statusCode, 400);

        statusCode = null;
        await getRouteHandler('/:name/sunrise/:seconds')({ params: { name: 'buero_lesen', seconds: '30' } }, res);
        assert.strictEqual(statusCode, 400);
        assert.strictEqual(calls.length, 2);
    } finally {
        hueManager.executeScene = originalExecuteScene;
    }
});

test('Routes - Szenen: XML Export erzeugt digitale Befehle und escaped Namen', () => {
    configManager.mapping = [
        { hue_uuid: 'scene-1', hue_name: 'Büro & "Lesen"', loxone_name: 'buero_lesen', hue_type: 'scene' },
        { hue_uuid: 'light-1', hue_name: 'Lampe', loxone_name: 'lampe', hue_type: 'light' }
    ];
    let xml = '';
    const headers = {};
    getRouteHandler('/api/download/scenes')({ query: {} }, { set: (k, v) => { headers[k] = v; }, send: content => { xml = content; } });

    assert.strictEqual(headers['Content-Disposition'], 'attachment; filename="lox_scenes.xml"');
    assert.ok(xml.includes('<VirtualOut Title="LoxHueBridge Scenes"'));
    assert.ok(xml.includes('CmdOn="/buero_lesen/1" CmdOff="/buero_lesen/0" Analog="false"'));
    assert.ok(xml.includes('Comment="Büro &amp; &quot;Lesen&quot;"'));
    assert.strictEqual(xml.includes('lampe'), false);
});

test('Routes - Szenen: /api/scenes antwortet ohne Setup mit 503', async () => {
    configManager.isConfigured = false;
    let statusCode = null;
    let payload = null;
    await getRouteHandler('/api/scenes')({}, {
        status(code) { statusCode = code; return this; },
        json(content) { payload = content; return this; }
    });
    assert.strictEqual(statusCode, 503);
    assert.deepStrictEqual(payload, []);
    configManager.isConfigured = true;
});

test('Routes - Szenen: Details speichern nur den Loxone Namen', () => {
    configManager.mapping = [
        { hue_uuid: 'scene-1', hue_name: 'Büro: Lesen', loxone_name: 'buero_lesen', hue_type: 'scene', scene_group_rid: 'room-1', scene_group_rtype: 'room' }
    ];
    let payload = null;
    getRouteHandler('/api/mapping/:loxoneName/settings')({ params: { loxoneName: 'buero_lesen' }, body: { loxone_name: 'buero_lesen2', sync_lox: true } }, {
        status() { return this; },
        json(content) { payload = content; return this; }
    });
    assert.strictEqual(payload.success, true);
    assert.deepStrictEqual(payload.mapping, { hue_uuid: 'scene-1', hue_name: 'Büro: Lesen', loxone_name: 'buero_lesen2', hue_type: 'scene', scene_group_rid: 'room-1', scene_group_rtype: 'room' });
});
