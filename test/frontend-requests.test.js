const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createUi(statusCode, payload) {
    const alerts = [];
    const timers = [];
    const elements = {
        inName: { value: 'new' },
        hueTarget: { value: 'uuid', selectedIndex: 0, options: [{ text: 'Light', dataset: { type: 'light' } }] }
    };
    let reader;
    const context = vm.createContext({
        console, alert: text => alerts.push(text), confirm: () => true,
        document: { getElementById: id => elements[id] },
        fetch: async () => ({ ok: statusCode < 400, status: statusCode, text: async () => JSON.stringify(payload) }),
        setTimeout: callback => timers.push(callback),
        FileReader: class { constructor() { reader = this; } readAsText() {} }
    });
    const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
    vm.runInContext(source, context);
    return { context, alerts, timers, elements, getReader: () => reader };
}

test('F11: abgelehnter Restore zeigt Fehler und startet keinen Reload', async () => {
    const ui = createUi(400, { success: false, error: 'Redigiertes Backup ist nicht wiederherstellbar.' });
    await ui.context.restoreBackup({ files: [{}] });
    await ui.getReader().onload({ target: { result: '{"config":{},"mapping":[]}' } });
    assert.match(ui.alerts[0], /Redigiertes Backup/);
    assert.equal(ui.timers.length, 0);
    assert.ok(!ui.alerts.some(text => text.includes('Wiederhergestellt!')));
});

test('F11: fehlgeschlagenes Hinzufuegen und Loeschen erhalten Mappings und Eingaben', async () => {
    const ui = createUi(500, { success: false, error: 'Datenträger voll' });
    vm.runInContext('mappings = [{loxone_name:"old"}]', ui.context);
    await ui.context.addMapping();
    await ui.context.deleteMapping('old');
    assert.equal(vm.runInContext('JSON.stringify(mappings)', ui.context), '[{"loxone_name":"old"}]');
    assert.equal(ui.elements.inName.value, 'new');
    assert.equal(ui.alerts.length, 2);
});

test('F11: auch HTTP 200 mit success false wird abgelehnt', async () => {
    const ui = createUi(200, { success: false, error: 'Nicht gespeichert' });
    await assert.rejects(ui.context.apiRequest('/api/settings', { method: 'POST' }), /Nicht gespeichert/);
});

test('Loeschen-Button in der Geraeteliste loescht statt Details zu oeffnen', async () => {
    const requests = [];
    const listeners = {};
    const deleteButton = { addEventListener: (type, fn) => { listeners[type] = fn; } };
    const createdDiv = { querySelector: selector => (selector === '.del-btn' ? deleteButton : null) };
    const context = vm.createContext({
        console, alert: () => {}, confirm: () => true,
        document: { getElementById: () => null, createElement: () => createdDiv },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
        },
        setTimeout: () => {},
        FileReader: class {}
    });
    const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
    vm.runInContext(source, context);
    vm.runInContext(`
        mappings = [{ loxone_name: 'wohn"zimmer', hue_name: 'Lampe', hue_uuid: 'u1', hue_type: 'light' }, { loxone_name: 'kueche', hue_name: 'K', hue_uuid: 'u2', hue_type: 'light' }];
        var detailsOpened = false;
        showDetails = () => { detailsOpened = true; };
        loadMappings = () => {}; loadTargets = () => {};
    `, context);

    const div = vm.runInContext('createMappingItem(mappings[0])', context);
    assert.doesNotMatch(div.innerHTML, /onclick=/);
    assert.equal(typeof listeners.click, 'function');

    let stopped = false;
    await listeners.click({ stopPropagation: () => { stopped = true; } });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(stopped, true);
    assert.equal(vm.runInContext('detailsOpened', context), false);
    const post = requests.find(r => r.url === '/api/mapping' && r.options?.method === 'POST');
    assert.ok(post, 'Mapping-Speicherung fehlt');
    assert.deepEqual(JSON.parse(post.options.body).map(m => m.loxone_name), ['kueche']);
});
