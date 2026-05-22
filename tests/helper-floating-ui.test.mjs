import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

class FakeClassList {
    constructor(element) {
        this.element = element;
        this.items = new Set();
    }

    add(...names) {
        for (const name of names) {
            this.items.add(name);
        }
        this.sync();
    }

    remove(...names) {
        for (const name of names) {
            this.items.delete(name);
        }
        this.sync();
    }

    contains(name) {
        return this.items.has(name);
    }

    toggle(name, force) {
        const enabled = force ?? !this.items.has(name);
        if (enabled) {
            this.items.add(name);
        } else {
            this.items.delete(name);
        }
        this.sync();
        return enabled;
    }

    sync() {
        this.element.className = [...this.items].join(' ');
    }
}

class FakeElement {
    constructor(tagName, document) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.parentElement = null;
        this.attributes = {};
        this.style = {};
        this.dataset = {};
        this.eventListeners = {};
        this.className = '';
        this.classList = new FakeClassList(this);
        this.textContent = '';
        this.innerHTML = '';
        this.id = '';
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        this.ownerDocument.register(child);
        return child;
    }

    append(...children) {
        for (const child of children) {
            this.appendChild(child);
        }
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') {
            this.id = String(value);
            this.ownerDocument.register(this);
        }
        if (name === 'class') {
            this.className = String(value);
            this.classList.items = new Set(this.className.split(/\s+/).filter(Boolean));
        }
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    addEventListener(type, handler) {
        if (!this.eventListeners[type]) {
            this.eventListeners[type] = new Set();
        }
        this.eventListeners[type].add(handler);
    }

    removeEventListener(type, handler) {
        this.eventListeners[type]?.delete(handler);
    }

    dispatchEvent(event) {
        event.target = event.target || this;
        for (const handler of this.eventListeners[event.type] || []) {
            handler(event);
        }
    }

    matches(selector) {
        if (selector.startsWith('#')) {
            return this.id === selector.slice(1);
        }
        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }
        return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = element => {
            for (const child of element.children) {
                if (child.matches(selector)) {
                    matches.push(child);
                }
                visit(child);
            }
        };
        visit(this);
        return matches;
    }
}

class FakeDocument {
    constructor() {
        this.elementsById = new Map();
        this.documentElement = new FakeElement('html', this);
        this.head = new FakeElement('head', this);
        this.body = new FakeElement('body', this);
        this.documentElement.append(this.head, this.body);
    }

    createElement(tagName) {
        return new FakeElement(tagName, this);
    }

    getElementById(id) {
        return this.elementsById.get(id) || null;
    }

    querySelector(selector) {
        return this.documentElement.querySelector(selector);
    }

    querySelectorAll(selector) {
        return this.documentElement.querySelectorAll(selector);
    }

    addEventListener() {}

    removeEventListener() {}

    register(element) {
        if (element.id) {
            this.elementsById.set(element.id, element);
        }
        for (const child of element.children) {
            this.register(child);
        }
    }
}

function createSandbox() {
    const document = new FakeDocument();
    const localStorage = new Map();
    const window = {
        document,
        parent: null,
        innerWidth: 1280,
        innerHeight: 800,
        visualViewport: { height: 800, addEventListener() {}, removeEventListener() {} },
        localStorage: {
            getItem: key => localStorage.get(key) || null,
            setItem: (key, value) => localStorage.set(key, String(value)),
        },
        SillyTavern: {
            getContext: () => ({
                extensionSettings: {},
                saveSettingsDebounced() {},
                eventSource: { on() {} },
                eventTypes: { PRESET_CHANGED: 'preset_changed' },
            }),
        },
        toastr: { info() {}, warning() {}, error() {}, success() {} },
        addEventListener() {},
        removeEventListener() {},
        setTimeout: callback => {
            callback();
            return 1;
        },
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {},
        console,
    };
    window.parent = window;

    return {
        window,
        document,
        globalThis: window,
        console,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout,
        setInterval: window.setInterval,
        clearInterval: window.clearInterval,
    };
}

test('helper script creates floating launcher without old SillyTavern buttons', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const sandbox = createSandbox();

    vm.runInNewContext(source, sandbox, { filename: 'tavern-helper-button.js' });

    assert.ok(sandbox.document.getElementById('pqnFloatingRoot'));
    assert.ok(sandbox.document.getElementById('pqnFloatingButton'));
    assert.equal(sandbox.document.getElementById('pqnHelperMenuButton'), null);
    assert.equal(sandbox.document.getElementById('pqnHelperComposerButton'), null);
    assert.equal(sandbox.document.getElementById('pqnHelperChatButton'), null);
});

test('tavern helper json embeds the current helper script', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const json = JSON.parse(await readFile(new URL('../tavern-helper-button.json', import.meta.url), 'utf8'));

    assert.equal(json.type, 'script');
    assert.equal(json.enabled, true);
    assert.equal(json.content, source);
    assert.match(json.name, /悬浮球/);
});

test('closing the panel autosaves the current quick input silently', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const closeStart = source.indexOf('async function closePanel()');
    const closeEnd = source.indexOf('function renderPanel()', closeStart);
    const closeSource = source.slice(closeStart, closeEnd);

    assert.notEqual(closeStart, -1);
    assert.match(closeSource, /await\s+saveContent\(\{\s*silent:\s*true,\s*rerender:\s*false\s*}\)/);
});

test('quick input editor is rendered before binding management controls', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const quickStart = source.indexOf('function renderQuickSection()');
    const quickEnd = source.indexOf('function renderBindingRow', quickStart);
    const quickSource = source.slice(quickStart, quickEnd);

    const editorIndex = quickSource.indexOf('renderEditor(binding, prompt, content)');
    const addBindingIndex = quickSource.indexOf('data-pqn-field="promptToBind"');

    assert.notEqual(editorIndex, -1);
    assert.notEqual(addBindingIndex, -1);
    assert.ok(editorIndex < addBindingIndex);
});

test('legacy free text is migrated into the default tag group', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');

    assert.match(source, /function migrateLegacyContentToTagValues/);
    assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(stateForBinding,\s*'content'\)/);
    assert.match(source, /values\.b = String\(stateForBinding\.content \|\| ''\)/);
    assert.match(source, /delete stateForBinding\.content/);
});

test('empty tag group B values are skipped when composing content', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const composeStart = source.indexOf('function composeContent(bindingId)');
    const composeEnd = source.indexOf('function syncPresetPrompt', composeStart);
    const composeSource = source.slice(composeStart, composeEnd);

    assert.notEqual(composeStart, -1);
    assert.match(composeSource, /const valueB = String\(values\.b \|\| ''\)\.trim\(\)/);
    assert.match(composeSource, /if \(!valueB\) continue/);
    assert.match(composeSource, /if \(!tagParts\.length\) return ''/);
    assert.match(composeSource, /tagParts\.push\(`\$\{labelA\}：\$\{valueA\}`\)/);
    assert.match(composeSource, /tagParts\.push\(`\$\{labelB\}：\$\{valueB\}`\)/);
});

test('worldbook binding is validated before preset sync and saved alongside preset content', async () => {
    const source = await readFile(new URL('../tavern-helper-button.js', import.meta.url), 'utf8');
    const saveStart = source.indexOf('async function saveContent');
    const saveEnd = source.indexOf('function reloadContent()', saveStart);
    const saveSource = source.slice(saveStart, saveEnd);

    assert.notEqual(saveStart, -1);
    assert.match(saveSource, /await validateWorldBinding\(binding\.worldBinding\)/);
    assert.match(saveSource, /const prompt = syncPresetPrompt\(binding\.identifier, composed\)/);
    assert.match(saveSource, /await syncWorldInfoEntry\(binding\.worldBinding, composed\)/);
    assert.ok(saveSource.indexOf('await validateWorldBinding(binding.worldBinding)') < saveSource.indexOf('syncPresetPrompt(binding.identifier, composed)'));
});
