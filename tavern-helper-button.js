'use strict';

(function () {
    const MODULE_NAME = 'presetQuickNote';
    const NOTE_OPEN = '<本次内容注意>';
    const NOTE_CLOSE = '</本次内容注意>';
    const ROOT_ID = 'pqnFloatingRoot';
    const FAB_ID = 'pqnFloatingButton';
    const PANEL_ID = 'pqnFloatingPanel';
    const STYLE_ID = 'pqnFloatingStyle';
    const FAB_POSITION_KEY = 'presetQuickNotex:floatingPosition';
    const PANEL_SIZE_KEY = 'presetQuickNotex:panelSize';
    const PANEL_POSITION_KEY = 'presetQuickNotex:panelPosition';
    const DEFAULT_TAG_GROUP_ID = 'default';

    const defaultSettings = {
        bindings: [],
        modules: [
            { id: 'role', title: '角色', text: '角色相关注意事项：', enabled: true },
            { id: 'rules', title: '规则', text: '规则相关注意事项：', enabled: true },
            { id: 'notes', title: '注意事项', text: '本次内容注意事项：', enabled: true },
        ],
        tagGroups: [
            { id: DEFAULT_TAG_GROUP_ID, name: '默认组', labelA: '名称', labelB: '内容', enabled: true },
        ],
        bindingState: {},
        lastBindingId: '',
        activeTab: 'quick',
    };

    let doc = document;
    let hostWin = window;

    try {
        if (window.parent && window.parent.document) {
            doc = window.parent.document;
            hostWin = window.parent;
        }
    } catch (_) {
        doc = document;
        hostWin = window;
    }

    if (typeof hostWin.__PresetQuickNotexFloatingCleanup === 'function') {
        hostWin.__PresetQuickNotexFloatingCleanup();
    }

    const disposers = [];
    const runtime = {
        loading: false,
        loaded: false,
        error: '',
        context: null,
        script: null,
        openai: null,
        presetManager: null,
        extensions: null,
        worldInfo: null,
        worldEntryCache: {},
    };
    const state = {
        open: false,
        mobile: isMobile(),
        fabDragging: false,
        panelDragging: false,
        fabPosition: loadJson(FAB_POSITION_KEY, null),
        panelPosition: loadJson(PANEL_POSITION_KEY, null),
        panelSize: normalizePanelSize(loadJson(PANEL_SIZE_KEY, null)),
    };

    let root;
    let fab;
    let panel;
    let resizeHandle;

    function cloneDefaults() {
        return JSON.parse(JSON.stringify(defaultSettings));
    }

    function loadJson(key, fallback) {
        try {
            const raw = hostWin.localStorage?.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        try {
            hostWin.localStorage?.setItem(key, JSON.stringify(value));
        } catch (_) {
            // Storage can be disabled in private or embedded contexts.
        }
    }

    function normalizePanelSize(value) {
        const width = Number(value?.width || value?.w || 760);
        const height = Number(value?.height || value?.h || 620);
        return {
            width: clamp(width, 420, 1120),
            height: clamp(height, 340, 900),
        };
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function isMobile() {
        return Number(hostWin.innerWidth || 0) <= 768;
    }

    function getViewportHeight() {
        return Math.floor(hostWin.visualViewport?.height || hostWin.innerHeight || doc.documentElement?.clientHeight || 800);
    }

    function getViewportWidth() {
        return Math.floor(hostWin.innerWidth || doc.documentElement?.clientWidth || 1280);
    }

    function setId(element, id) {
        element.setAttribute('id', id);
        return element;
    }

    function setClass(element, className) {
        element.setAttribute('class', className);
        return element;
    }

    function listen(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        disposers.push(() => target.removeEventListener?.(type, handler, options));
    }

    function notify(message, type = 'info') {
        const toastr = hostWin.toastr || window.toastr;
        if (toastr && typeof toastr[type] === 'function') {
            toastr[type](message);
            return;
        }
        console[type === 'error' ? 'error' : 'log'](`[PresetQuickNotex] ${message}`);
    }

    function escapeHtml(value) {
        const div = doc.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    function uid(prefix = 'pqn') {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    async function importModule(path) {
        if (!hostWin.location && !window.location) return null;
        try {
            return await import(path);
        } catch (error) {
            console.warn(`[PresetQuickNotex] Unable to import ${path}`, error);
            return null;
        }
    }

    async function loadRuntime() {
        if (runtime.loaded || runtime.loading) return runtime;

        runtime.loading = true;
        runtime.error = '';

        try {
            runtime.context = hostWin.SillyTavern?.getContext?.() || window.SillyTavern?.getContext?.() || null;

            const [scriptModule, openaiModule, presetManagerModule, extensionsModule, worldInfoModule] = await Promise.all([
                importModule('/script.js'),
                importModule('/scripts/openai.js'),
                importModule('/scripts/preset-manager.js'),
                importModule('/scripts/extensions.js'),
                importModule('/scripts/world-info.js'),
            ]);

            runtime.script = scriptModule;
            runtime.openai = openaiModule;
            runtime.presetManager = presetManagerModule;
            runtime.extensions = extensionsModule;
            runtime.worldInfo = worldInfoModule;
            runtime.loaded = true;
            bindPresetChanged();
        } catch (error) {
            runtime.error = error?.message || String(error);
            console.error('[PresetQuickNotex] Runtime initialization failed:', error);
        } finally {
            runtime.loading = false;
        }

        return runtime;
    }

    function getExtensionSettings() {
        return runtime.extensions?.extension_settings || runtime.context?.extensionSettings || null;
    }

    function getSaveSettingsDebounced() {
        return runtime.script?.saveSettingsDebounced || runtime.context?.saveSettingsDebounced || runtime.extensions?.saveSettingsDebounced || null;
    }

    function getMainApi() {
        return runtime.script?.main_api || runtime.context?.mainApi || '';
    }

    function getOpenAiModule() {
        return runtime.openai || {};
    }

    function getPresetManagerFn() {
        return runtime.presetManager?.getPresetManager || runtime.context?.getPresetManager || null;
    }

    function getEventSource() {
        return runtime.script?.eventSource || runtime.context?.eventSource || null;
    }

    function getEventTypes() {
        return runtime.script?.event_types || runtime.context?.eventTypes || runtime.context?.event_types || {};
    }

    function ensureSettings() {
        const extensionSettings = getExtensionSettings();
        if (!extensionSettings) {
            throw new Error('无法读取 Tavern Helper / SillyTavern 设置上下文');
        }

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = cloneDefaults();
        }

        const settings = extensionSettings[MODULE_NAME];
        const defaults = cloneDefaults();
        settings.bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
        settings.modules = Array.isArray(settings.modules) && settings.modules.length ? settings.modules : defaults.modules;
        settings.tagGroups = normalizeTagGroups(settings.tagGroups, defaults.tagGroups);
        settings.bindingState = settings.bindingState && typeof settings.bindingState === 'object' ? settings.bindingState : {};
        settings.lastBindingId = settings.lastBindingId || '';
        settings.activeTab = ['quick', 'modules', 'tags'].includes(settings.activeTab) ? settings.activeTab : 'quick';

        return settings;
    }

    function normalizeTagGroups(value, fallback) {
        const source = Array.isArray(value) && value.length ? value : fallback;
        const seen = new Set();
        return source.map((group, index) => {
            const rawId = String(group?.id || (index === 0 ? DEFAULT_TAG_GROUP_ID : uid('tag')));
            const id = seen.has(rawId) ? uid('tag') : rawId;
            seen.add(id);
            return {
                id,
                name: String(group?.name || group?.title || (id === DEFAULT_TAG_GROUP_ID ? '默认组' : '新标签组')),
                labelA: String(group?.labelA || '名称'),
                labelB: String(group?.labelB || '内容'),
                enabled: group?.enabled !== false,
            };
        });
    }

    function saveExtensionSettings() {
        const save = getSaveSettingsDebounced();
        if (typeof save === 'function') {
            save();
        }
    }

    function isOpenAiApi() {
        return getMainApi() === 'openai';
    }

    function getOpenAiPresetManager() {
        return getPresetManagerFn()?.('openai') || null;
    }

    function getCurrentPresetName() {
        const openai = getOpenAiModule();
        const manager = getOpenAiPresetManager();
        return manager?.getSelectedPresetName?.() || openai.oai_settings?.preset_settings_openai || runtime.context?.chatCompletionSettings?.preset_settings_openai || '';
    }

    function getCurrentPresetObject() {
        const openai = getOpenAiModule();
        const manager = getOpenAiPresetManager();
        const name = getCurrentPresetName();
        const index = openai.openai_setting_names?.[name];
        const listPreset = index !== undefined ? openai.openai_settings?.[index] : null;
        const managerPreset = manager?.getCompletionPresetByName?.(name);
        return listPreset || managerPreset || manager?.getPresetSettings?.(name) || openai.oai_settings || runtime.context?.chatCompletionSettings || null;
    }

    function getPromptList() {
        const openai = getOpenAiModule();
        const prompts = openai.promptManager?.serviceSettings?.prompts || openai.oai_settings?.prompts || runtime.context?.chatCompletionSettings?.prompts || [];
        return Array.isArray(prompts) ? prompts : [];
    }

    function getPromptByIdentifier(identifier) {
        return getPromptList().find(prompt => prompt?.identifier === identifier) || null;
    }

    function getPromptDisplayName(prompt) {
        return prompt?.name || prompt?.identifier || '(未命名提示词)';
    }

    function parseBodyFromWrappedContent(content) {
        const text = String(content || '').trim();
        if (!text) return '';

        const openIndex = text.indexOf(NOTE_OPEN);
        const closeIndex = text.lastIndexOf(NOTE_CLOSE);
        if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
            return text;
        }

        const settings = ensureSettings();
        let body = text.slice(openIndex + NOTE_OPEN.length, closeIndex).trim();
        for (const module of settings.modules) {
            const moduleText = String(module.text || '').trim();
            if (moduleText && body.startsWith(moduleText)) {
                body = body.slice(moduleText.length).trimStart();
            }
        }
        return body.trim();
    }

    function getEnabledTagGroups() {
        return ensureSettings().tagGroups.filter(group => group.enabled !== false);
    }

    function getDefaultTagGroup() {
        const settings = ensureSettings();
        return settings.tagGroups.find(group => group.id === DEFAULT_TAG_GROUP_ID) || settings.tagGroups[0] || null;
    }

    function getSelectedBinding() {
        const settings = ensureSettings();
        return settings.bindings.find(binding => binding.id === settings.lastBindingId) || settings.bindings[0] || null;
    }

    function getBindingState(bindingId) {
        const settings = ensureSettings();
        const binding = settings.bindings.find(item => item.id === bindingId) || null;
        if (!settings.bindingState[bindingId]) {
            settings.bindingState[bindingId] = {
                moduleIds: settings.modules.filter(module => module.enabled !== false).map(module => module.id),
                tagValues: {},
                quickGroupId: getDefaultTagGroup()?.id || DEFAULT_TAG_GROUP_ID,
            };
        }
        const stateForBinding = settings.bindingState[bindingId];
        stateForBinding.moduleIds = Array.isArray(stateForBinding.moduleIds)
            ? stateForBinding.moduleIds
            : settings.modules.filter(module => module.enabled !== false).map(module => module.id);
        stateForBinding.tagValues = stateForBinding.tagValues && typeof stateForBinding.tagValues === 'object' ? stateForBinding.tagValues : {};
        stateForBinding.quickGroupId = settings.tagGroups.some(group => group.id === stateForBinding.quickGroupId)
            ? stateForBinding.quickGroupId
            : getDefaultTagGroup()?.id || DEFAULT_TAG_GROUP_ID;

        for (const group of settings.tagGroups) {
            if (!stateForBinding.tagValues[group.id] || typeof stateForBinding.tagValues[group.id] !== 'object') {
                stateForBinding.tagValues[group.id] = { a: '', b: '' };
            }
            stateForBinding.tagValues[group.id].a = String(stateForBinding.tagValues[group.id].a ?? '');
            stateForBinding.tagValues[group.id].b = String(stateForBinding.tagValues[group.id].b ?? '');
        }

        migrateLegacyContentToTagValues(stateForBinding, binding);
        return stateForBinding;
    }

    function migrateLegacyContentToTagValues(stateForBinding, binding) {
        if (!Object.prototype.hasOwnProperty.call(stateForBinding, 'content')) return;

        const group = getDefaultTagGroup();
        if (group) {
            const values = stateForBinding.tagValues[group.id] || { a: '', b: '' };
            if (!String(values.a || '').trim()) {
                values.a = binding?.name || binding?.identifier || '';
            }
            if (!String(values.b || '').trim()) {
                values.b = String(stateForBinding.content || '');
            }
            stateForBinding.tagValues[group.id] = values;
            stateForBinding.quickGroupId = group.id;
        }
        delete stateForBinding.content;
    }

    function setBodyOnBindingState(binding, body) {
        const settings = ensureSettings();
        const stateForBinding = getBindingState(binding.id);
        const parsed = parseTagValuesFromBody(body);
        for (const group of settings.tagGroups) {
            const values = stateForBinding.tagValues[group.id] || { a: '', b: '' };
            values.a = parsed[group.id]?.a ?? (group.id === DEFAULT_TAG_GROUP_ID ? binding.name || binding.identifier || '' : values.a || '');
            values.b = parsed[group.id]?.b ?? '';
            stateForBinding.tagValues[group.id] = values;
        }

        if (!Object.keys(parsed).length) {
            const group = getDefaultTagGroup();
            if (group) {
                stateForBinding.quickGroupId = group.id;
                stateForBinding.tagValues[group.id] = {
                    a: binding.name || binding.identifier || '',
                    b: String(body || '').trim(),
                };
            }
        }
    }

    function parseTagValuesFromBody(body) {
        const lines = String(body || '').split(/\r?\n/);
        const parsed = {};
        const groups = ensureSettings().tagGroups;
        const matchesLabel = (line, label) => {
            const text = String(line || '');
            const prefix = String(label || '').trim();
            if (!prefix) return null;
            if (text.startsWith(`${prefix}：`)) return text.slice(prefix.length + 1).trim();
            if (text.startsWith(`${prefix}:`)) return text.slice(prefix.length + 1).trim();
            return null;
        };

        for (let index = 0; index < lines.length - 1; index++) {
            for (const group of groups) {
                const valueA = matchesLabel(lines[index], group.labelA);
                const valueB = matchesLabel(lines[index + 1], group.labelB);
                if (valueA !== null && valueB !== null) {
                    parsed[group.id] = { a: valueA, b: valueB };
                    index++;
                    break;
                }
            }
        }
        return parsed;
    }

    function composeContent(bindingId) {
        const settings = ensureSettings();
        const stateForBinding = getBindingState(bindingId);
        const moduleIds = Array.isArray(stateForBinding.moduleIds) ? stateForBinding.moduleIds : [];
        const parts = settings.modules
            .filter(module => module.enabled !== false && moduleIds.includes(module.id))
            .map(module => String(module.text || '').trim())
            .filter(Boolean);
        const tagParts = [];

        for (const group of getEnabledTagGroups()) {
            const values = stateForBinding.tagValues[group.id] || {};
            const valueB = String(values.b || '').trim();
            if (!valueB) continue;

            const labelA = String(group.labelA || '名称').trim();
            const labelB = String(group.labelB || '内容').trim();
            const valueA = String(values.a || '').trim();
            tagParts.push(`${labelA}：${valueA}`);
            tagParts.push(`${labelB}：${valueB}`);
        }

        if (!tagParts.length) return '';
        parts.push(...tagParts);
        return `${NOTE_OPEN}\n${parts.join('\n')}\n${NOTE_CLOSE}`;
    }

    function syncPresetPrompt(identifier, content) {
        const openai = getOpenAiModule();
        const prompt = getPromptByIdentifier(identifier);
        if (!prompt) {
            throw new Error(`找不到提示词条目：${identifier}`);
        }

        prompt.content = content;

        const promptCollections = [
            openai.oai_settings?.prompts,
            openai.promptManager?.serviceSettings?.prompts,
            getCurrentPresetObject()?.prompts,
        ];

        const presetName = getCurrentPresetName();
        const presetIndex = openai.openai_setting_names?.[presetName];
        if (presetIndex !== undefined) {
            promptCollections.push(openai.openai_settings?.[presetIndex]?.prompts);
        }

        for (const collection of promptCollections) {
            if (!Array.isArray(collection)) continue;
            const target = collection.find(item => item?.identifier === identifier);
            if (target) {
                target.content = content;
            }
        }

        return prompt;
    }

    async function saveCurrentPresetWithoutRefresh() {
        const manager = getOpenAiPresetManager();
        if (!manager) {
            throw new Error('找不到对话补全预设管理器');
        }

        const name = getCurrentPresetName();
        if (!name) {
            throw new Error('当前没有选中的对话补全预设');
        }

        const preset = getCurrentPresetObject();
        await manager.savePreset(name, preset, { skipUpdate: true });
    }

    function getWorldInfoModule() {
        return runtime.worldInfo || {};
    }

    function getWorldNames() {
        const names = getWorldInfoModule().world_names;
        return Array.isArray(names) ? names : [];
    }

    function getCachedWorldEntries(worldName) {
        const data = runtime.worldEntryCache?.[worldName];
        if (!data?.entries) return [];
        return Object.values(data.entries).sort((a, b) => Number(a.uid) - Number(b.uid));
    }

    function getWorldEntryDisplayName(entry) {
        const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
        return entry?.comment || keys || `UID ${entry?.uid ?? ''}`;
    }

    async function loadWorldEntries(worldName) {
        if (!worldName) return null;
        const worldInfo = getWorldInfoModule();
        if (!getWorldNames().includes(worldName)) {
            throw new Error(`找不到世界书：${worldName}`);
        }
        if (runtime.worldEntryCache[worldName]) {
            return runtime.worldEntryCache[worldName];
        }
        if (typeof worldInfo.loadWorldInfo !== 'function') {
            throw new Error('当前 SillyTavern 环境无法读取世界书');
        }
        const data = await worldInfo.loadWorldInfo(worldName);
        if (!data?.entries) {
            throw new Error(`无法读取世界书条目：${worldName}`);
        }
        runtime.worldEntryCache[worldName] = data;
        return data;
    }

    async function validateWorldBinding(worldBinding) {
        if (!worldBinding) return null;
        const worldName = worldBinding.worldName;
        const uidValue = String(worldBinding.uid ?? '');
        const data = await loadWorldEntries(worldName);
        const entry = data?.entries?.[uidValue];
        if (!entry) {
            throw new Error(`找不到世界书条目：${worldName} / UID ${uidValue}`);
        }
        return { data, entry };
    }

    async function syncWorldInfoEntry(worldBinding, content) {
        if (!worldBinding) return;
        const worldInfo = getWorldInfoModule();
        if (typeof worldInfo.saveWorldInfo !== 'function') {
            throw new Error('当前 SillyTavern 环境无法保存世界书');
        }
        const { data, entry } = await validateWorldBinding(worldBinding);
        entry.content = content;
        await worldInfo.saveWorldInfo(worldBinding.worldName, data, true);
    }

    function injectStyle() {
        doc.getElementById(STYLE_ID)?.remove();

        const style = setId(doc.createElement('style'), STYLE_ID);
        style.textContent = `
#${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; }
#${FAB_ID} {
    position: fixed;
    width: 48px;
    height: 48px;
    border-radius: 999px;
    border: 1px solid rgba(105, 229, 205, 0.38);
    background: linear-gradient(145deg, rgba(8, 17, 24, 0.96), rgba(11, 29, 36, 0.94));
    color: #6ee7d8;
    box-shadow: 0 0 18px rgba(105, 229, 205, 0.2), 0 8px 24px rgba(0, 0, 0, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: grab;
    z-index: 99999;
    touch-action: none;
    user-select: none;
    backdrop-filter: blur(10px);
    transition: transform 160ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
#${FAB_ID}:hover {
    transform: scale(1.06);
    border-color: rgba(251, 191, 36, 0.55);
    box-shadow: 0 0 24px rgba(105, 229, 205, 0.28), 0 10px 28px rgba(0, 0, 0, 0.48);
}
#${FAB_ID}.is-dragging {
    cursor: grabbing;
    transform: scale(1);
}
#${FAB_ID} svg {
    width: 22px;
    height: 22px;
}
#${PANEL_ID} {
    position: fixed;
    z-index: 99999;
    display: none;
    flex-direction: column;
    color: rgba(245, 250, 252, 0.92);
    background: rgba(5, 12, 18, 0.96);
    border: 1px solid rgba(105, 229, 205, 0.24);
    border-radius: 12px;
    box-shadow: 0 0 34px rgba(105, 229, 205, 0.1), 0 16px 48px rgba(0, 0, 0, 0.56);
    overflow: hidden;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    letter-spacing: 0;
    backdrop-filter: blur(12px);
}
#${PANEL_ID}.is-open { display: flex; }
#${PANEL_ID}.is-mobile {
    left: 0 !important;
    width: 100vw !important;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 16px 16px 0 0;
}
.pqn-float-grip {
    display: none;
    justify-content: center;
    padding: 8px 0 3px;
    touch-action: none;
}
.pqn-float-grip::before {
    content: "";
    width: 38px;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.24);
}
#${PANEL_ID}.is-mobile .pqn-float-grip { display: flex; }
.pqn-float-header {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 46px;
    padding: 9px 12px;
    border-bottom: 1px solid rgba(105, 229, 205, 0.18);
    background: rgba(4, 10, 15, 0.78);
    cursor: grab;
    user-select: none;
    touch-action: none;
}
#${PANEL_ID}.is-mobile .pqn-float-header {
    cursor: default;
    padding-right: max(12px, env(safe-area-inset-right));
    padding-left: max(12px, env(safe-area-inset-left));
}
.pqn-float-header.is-dragging { cursor: grabbing; }
.pqn-float-title {
    font-size: 14px;
    font-weight: 700;
    color: #7ddfd2;
    white-space: nowrap;
}
.pqn-float-preset {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: rgba(245, 250, 252, 0.54);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.pqn-float-icon-btn {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: rgba(245, 250, 252, 0.58);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}
.pqn-float-icon-btn:hover,
.pqn-float-icon-btn:focus-visible {
    background: rgba(105, 229, 205, 0.12);
    color: #7ddfd2;
    outline: none;
}
.pqn-float-tabs {
    display: flex;
    flex: 0 0 auto;
    background: rgba(8, 20, 27, 0.7);
    border-bottom: 1px solid rgba(105, 229, 205, 0.16);
}
.pqn-float-tab {
    flex: 1;
    min-width: 0;
    min-height: 38px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: rgba(245, 250, 252, 0.56);
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
}
.pqn-float-tab:hover { background: rgba(105, 229, 205, 0.06); color: rgba(245, 250, 252, 0.86); }
.pqn-float-tab.is-active {
    color: #7ddfd2;
    border-bottom-color: #7ddfd2;
    background: rgba(105, 229, 205, 0.12);
}
.pqn-float-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 12px;
    overscroll-behavior: contain;
}
#${PANEL_ID}.is-mobile .pqn-float-body {
    padding-right: max(10px, env(safe-area-inset-right));
    padding-left: max(10px, env(safe-area-inset-left));
    -webkit-overflow-scrolling: touch;
}
.pqn-float-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(190px, 260px);
    gap: 12px;
    align-items: start;
}
.pqn-float-stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
}
.pqn-float-card {
    border: 1px solid rgba(105, 229, 205, 0.16);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    padding: 10px;
}
.pqn-float-label {
    margin-bottom: 5px;
    color: rgba(245, 250, 252, 0.9);
    font-size: 12px;
    font-weight: 700;
}
.pqn-float-muted {
    color: rgba(245, 250, 252, 0.58);
    font-size: 12px;
    line-height: 1.5;
}
.pqn-float-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.pqn-float-input,
.pqn-float-select,
.pqn-float-textarea {
    width: 100%;
    min-width: 0;
    border: 1px solid rgba(105, 229, 205, 0.2);
    border-radius: 7px;
    background: rgba(1, 7, 12, 0.72);
    color: rgba(245, 250, 252, 0.92);
    font: inherit;
    font-size: 13px;
    outline: none;
}
.pqn-float-input,
.pqn-float-select {
    min-height: 34px;
    padding: 5px 8px;
}
.pqn-float-textarea {
    min-height: 190px;
    padding: 8px;
    resize: vertical;
    line-height: 1.45;
}
.pqn-float-input:focus,
.pqn-float-select:focus,
.pqn-float-textarea:focus {
    border-color: rgba(251, 191, 36, 0.6);
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.12);
}
.pqn-float-btn {
    min-height: 34px;
    border: 1px solid rgba(105, 229, 205, 0.22);
    border-radius: 7px;
    background: rgba(105, 229, 205, 0.1);
    color: rgba(245, 250, 252, 0.92);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
}
.pqn-float-btn:hover,
.pqn-float-btn:focus-visible {
    border-color: rgba(251, 191, 36, 0.5);
    background: rgba(251, 191, 36, 0.12);
    outline: none;
}
.pqn-float-mini-btn {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(105, 229, 205, 0.18);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(245, 250, 252, 0.74);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}
.pqn-float-mini-btn:hover { color: #7ddfd2; border-color: rgba(105, 229, 205, 0.42); }
.pqn-float-binding,
.pqn-float-module {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 8px;
    border: 1px solid rgba(105, 229, 205, 0.14);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
}
.pqn-float-binding.is-selected {
    border-color: rgba(251, 191, 36, 0.48);
    background: rgba(251, 191, 36, 0.08);
}
.pqn-float-binding-name,
.pqn-float-module-main {
    flex: 1;
    min-width: 0;
}
.pqn-float-binding-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
}
.pqn-float-inline {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: rgba(245, 250, 252, 0.82);
    font-size: 13px;
}
.pqn-float-inline input { accent-color: #7ddfd2; }
.pqn-float-module-list,
.pqn-float-binding-list,
.pqn-float-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.pqn-float-tag-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.pqn-float-tag-row {
    display: grid;
    grid-template-columns: minmax(120px, 0.9fr) minmax(110px, 0.7fr) minmax(110px, 0.7fr) minmax(160px, 1fr) auto;
    gap: 8px;
    align-items: start;
    min-width: 0;
    padding: 8px;
    border: 1px solid rgba(105, 229, 205, 0.14);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
}
.pqn-float-world-badge {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    max-width: 100%;
    padding: 2px 7px;
    border-radius: 7px;
    background: rgba(105, 229, 205, 0.1);
    color: rgba(245, 250, 252, 0.78);
    font-size: 12px;
}
.pqn-float-module-text { min-height: 78px; }
.pqn-float-status {
    border: 1px solid rgba(251, 191, 36, 0.24);
    border-radius: 8px;
    background: rgba(251, 191, 36, 0.08);
    color: rgba(245, 250, 252, 0.78);
    padding: 12px;
    line-height: 1.55;
    font-size: 13px;
}
.pqn-float-footer {
    display: none;
    flex: 0 0 auto;
    padding: 8px 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    border-top: 1px solid rgba(105, 229, 205, 0.16);
    background: rgba(4, 10, 15, 0.88);
}
#${PANEL_ID}.is-mobile .pqn-float-footer { display: flex; }
.pqn-float-footer .pqn-float-btn { width: 100%; }
.pqn-float-resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
}
.pqn-float-resize::after {
    content: "";
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 8px;
    height: 8px;
    border-right: 2px solid rgba(105, 229, 205, 0.35);
    border-bottom: 2px solid rgba(105, 229, 205, 0.35);
}
#${PANEL_ID}.is-mobile .pqn-float-resize { display: none; }
@media (max-width: 768px) {
    #${FAB_ID} {
        width: 46px;
        height: 46px;
    }
    .pqn-float-grid {
        grid-template-columns: 1fr;
    }
    .pqn-float-tab {
        min-height: 42px;
        font-size: 13px;
    }
    .pqn-float-binding,
    .pqn-float-module {
        align-items: stretch;
        flex-wrap: wrap;
        padding: 10px;
    }
    .pqn-float-tag-row {
        grid-template-columns: 1fr;
    }
    .pqn-float-binding-name {
        white-space: normal;
    }
    .pqn-float-textarea {
        min-height: 150px;
        max-height: 36dvh;
    }
    .pqn-float-module-text {
        min-height: 92px;
    }
}`;

        doc.head.appendChild(style);
    }

    function createRoot() {
        doc.getElementById(ROOT_ID)?.remove();

        root = setId(doc.createElement('div'), ROOT_ID);
        fab = setId(doc.createElement('button'), FAB_ID);
        panel = setId(doc.createElement('div'), PANEL_ID);
        resizeHandle = setClass(doc.createElement('div'), 'pqn-float-resize');

        fab.type = 'button';
        fab.title = '预设快捷提示词';
        fab.setAttribute('aria-label', '预设快捷提示词');
        fab.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3.5c-4.7 0-8.5 3.8-8.5 8.5s3.8 8.5 8.5 8.5 8.5-3.8 8.5-8.5-3.8-8.5-8.5-8.5Z"></path>
                <path d="M8.4 12c0-2.2 1.3-3.8 3.6-3.8s3.6 1.6 3.6 3.8-1.3 3.8-3.6 3.8-3.6-1.6-3.6-3.8Z" opacity="0.5"></path>
                <path d="M12 10.3v3.4M10.3 12h3.4"></path>
            </svg>`;

        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '预设快捷提示词');
        panel.appendChild(resizeHandle);
        root.append(fab, panel);
        doc.body.appendChild(root);

        listen(fab, 'pointerdown', handleFabPointerDown);
        listen(panel, 'click', handlePanelClick);
        listen(panel, 'pointerdown', handlePanelPointerDown);
        listen(panel, 'input', handlePanelInput);
        listen(panel, 'change', handlePanelChange);
        listen(resizeHandle, 'pointerdown', handleResizePointerDown);
        listen(hostWin, 'resize', handleViewportChange);
        listen(hostWin.visualViewport, 'resize', handleViewportChange);
        listen(hostWin, 'pagehide', cleanup);

        applyFabPosition();
        renderPanel();
    }

    function getDefaultFabPosition() {
        const size = 48;
        const margin = 16;
        return {
            x: getViewportWidth() - size - margin,
            y: Math.floor(getViewportHeight() * 0.35),
        };
    }

    function clampFabPosition(position) {
        const size = state.mobile ? 46 : 48;
        const margin = 10;
        return {
            x: clamp(Number(position?.x ?? 0), margin, Math.max(margin, getViewportWidth() - size - margin)),
            y: clamp(Number(position?.y ?? 0), margin, Math.max(margin, getViewportHeight() - size - margin)),
        };
    }

    function applyFabPosition() {
        state.mobile = isMobile();
        state.fabPosition = clampFabPosition(state.fabPosition || getDefaultFabPosition());
        fab.style.left = `${state.fabPosition.x}px`;
        fab.style.top = `${state.fabPosition.y}px`;
        fab.style.display = state.open ? 'none' : 'flex';
        saveJson(FAB_POSITION_KEY, state.fabPosition);
    }

    function getDefaultPanelPosition() {
        return {
            x: Math.max(12, Math.floor((getViewportWidth() - state.panelSize.width) / 2)),
            y: Math.max(12, Math.floor((getViewportHeight() - state.panelSize.height) / 2)),
        };
    }

    function clampPanelPosition(position) {
        const margin = 12;
        const maxX = Math.max(margin, getViewportWidth() - state.panelSize.width - margin);
        const maxY = Math.max(margin, getViewportHeight() - state.panelSize.height - margin);
        return {
            x: clamp(Number(position?.x ?? getDefaultPanelPosition().x), margin, maxX),
            y: clamp(Number(position?.y ?? getDefaultPanelPosition().y), margin, maxY),
        };
    }

    function applyPanelGeometry() {
        state.mobile = isMobile();
        panel.classList.toggle('is-mobile', state.mobile);
        panel.classList.toggle('is-open', state.open);

        if (!state.open) {
            fab.style.display = 'flex';
            return;
        }

        fab.style.display = 'none';

        if (state.mobile) {
            const height = Math.floor(getViewportHeight() * 0.92);
            panel.style.left = '0px';
            panel.style.top = `${getViewportHeight() - height}px`;
            panel.style.width = '100vw';
            panel.style.height = `${height}px`;
            return;
        }

        state.panelSize = normalizePanelSize(state.panelSize);
        state.panelPosition = clampPanelPosition(state.panelPosition || getDefaultPanelPosition());
        panel.style.left = `${state.panelPosition.x}px`;
        panel.style.top = `${state.panelPosition.y}px`;
        panel.style.width = `${state.panelSize.width}px`;
        panel.style.height = `${Math.min(state.panelSize.height, Math.floor(getViewportHeight() * 0.92))}px`;
        saveJson(PANEL_POSITION_KEY, state.panelPosition);
        saveJson(PANEL_SIZE_KEY, state.panelSize);
    }

    function openPanel() {
        state.open = true;
        loadRuntime().then(() => {
            try {
                ensureSettings();
            } catch (error) {
                runtime.error = error?.message || String(error);
            }
            renderPanel();
        });
        renderPanel();
    }

    function canAutosaveOnClose() {
        if (!runtime.loaded || runtime.loading || runtime.error || !isOpenAiApi()) {
            return false;
        }

        try {
            return Boolean(getSelectedBinding());
        } catch (_) {
            return false;
        }
    }

    async function closePanel() {
        if (state.open && canAutosaveOnClose()) {
            try {
                await saveContent({ silent: true, rerender: false });
            } catch (error) {
                console.error('[PresetQuickNotex] Autosave before close failed:', error);
                notify(error?.message || '关闭前自动保存失败', 'error');
                return;
            }
        }
        state.open = false;
        renderPanel();
    }

    function renderPanel() {
        applyPanelGeometry();
        if (!state.open) return;

        let settings;
        try {
            settings = ensureSettings();
        } catch (error) {
            settings = cloneDefaults();
            runtime.error = runtime.error || error?.message || String(error);
        }

        const activeTab = settings.activeTab || 'quick';
        const presetName = runtime.loaded ? getCurrentPresetName() : '加载中';

        panel.innerHTML = `
            <div class="pqn-float-grip" data-pqn-action="close"></div>
            <div class="pqn-float-header" data-pqn-drag-handle="panel">
                <div class="pqn-float-title">预设快捷提示词</div>
                <div class="pqn-float-preset" title="${escapeHtml(presetName || '未选择')}">${escapeHtml(presetName || '未选择')}</div>
                <button type="button" class="pqn-float-icon-btn" data-pqn-action="refresh" title="刷新">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button type="button" class="pqn-float-icon-btn" data-pqn-action="close" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="pqn-float-tabs">
                ${renderTab('quick', '快捷输入', activeTab)}
                ${renderTab('modules', '预输入片段', activeTab)}
                ${renderTab('tags', '标签设置', activeTab)}
            </div>
            <div class="pqn-float-body">
                ${renderPanelBody(activeTab)}
            </div>
            <div class="pqn-float-footer">
                <button type="button" class="pqn-float-btn" data-pqn-action="close">
                    <i class="fa-solid fa-down-left-and-up-right-to-center"></i>
                    <span>收起面板</span>
                </button>
            </div>`;
        panel.appendChild(resizeHandle);

    }

    function renderPanelBody(activeTab) {
        if (runtime.loading) {
            return '<div class="pqn-float-status">正在连接 SillyTavern 上下文...</div>';
        }
        if (runtime.error) {
            return `<div class="pqn-float-status">${escapeHtml(runtime.error)}</div>`;
        }
        if (!runtime.loaded) {
            return '<div class="pqn-float-status">点击刷新后读取 SillyTavern 上下文。</div>';
        }
        if (!isOpenAiApi()) {
            return `<div class="pqn-float-status">当前 API 不是对话补全 OpenAI 模式。此助手只编辑“对话补全预设”的 Prompt Manager 条目。当前 API：${escapeHtml(getMainApi() || '未知')}</div>`;
        }
        if (activeTab === 'modules') return renderModulesSection();
        if (activeTab === 'tags') return renderTagsSection();
        return renderQuickSection();
    }

    function renderTab(id, label, activeTab) {
        return `
            <button type="button" class="pqn-float-tab ${activeTab === id ? 'is-active' : ''}" data-pqn-tab="${id}">
                ${escapeHtml(label)}
            </button>`;
    }

    function renderQuickSection() {
        const prompts = getPromptList();
        const settings = ensureSettings();
        const binding = getSelectedBinding();
        const stateForBinding = binding ? getBindingState(binding.id) : null;
        const prompt = binding ? getPromptByIdentifier(binding.identifier) : null;
        if (binding && prompt && !stateForBinding.__loadedFromPrompt) {
            setBodyOnBindingState(binding, parseBodyFromWrappedContent(prompt.content || ''));
            stateForBinding.__loadedFromPrompt = true;
        }
        const quickGroup = stateForBinding ? settings.tagGroups.find(group => group.id === stateForBinding.quickGroupId) || getDefaultTagGroup() : null;
        const content = quickGroup ? stateForBinding.tagValues[quickGroup.id]?.b || '' : '';

        return `
            <div class="pqn-float-grid">
                <div class="pqn-float-card">
                    ${binding ? renderEditor(binding, prompt, content) : '<div class="pqn-float-muted">请选择或添加一个绑定。</div>'}
                </div>
                <div class="pqn-float-stack">
                    <div class="pqn-float-card">
                        <div class="pqn-float-label">当前预设</div>
                        <div class="pqn-float-muted">${escapeHtml(getCurrentPresetName() || '未选择')}</div>
                    </div>
                    <div class="pqn-float-card pqn-float-stack">
                        <div>
                            <div class="pqn-float-label">添加绑定</div>
                            <select class="pqn-float-select" data-pqn-field="promptToBind">
                                ${prompts.map(item => `<option value="${escapeHtml(item.identifier)}">${escapeHtml(getPromptDisplayName(item))}</option>`).join('')}
                            </select>
                        </div>
                        <button type="button" class="pqn-float-btn" data-pqn-action="addBinding">
                            <i class="fa-solid fa-plus"></i>
                            <span>添加当前条目</span>
                        </button>
                    </div>
                    <div class="pqn-float-card pqn-float-stack">
                        <div class="pqn-float-label">已绑定条目</div>
                        <div class="pqn-float-binding-list">
                            ${settings.bindings.length ? settings.bindings.map(item => renderBindingRow(item, binding?.id)).join('') : '<div class="pqn-float-muted">还没有绑定。先从上方选择一个提示词条目添加。</div>'}
                        </div>
                    </div>
                    ${binding ? renderWorldBindingSection(binding, stateForBinding) : ''}
                </div>
            </div>`;
    }

    function renderBindingRow(binding, selectedId) {
        const found = getPromptByIdentifier(binding.identifier);
        const name = found ? getPromptDisplayName(found) : binding.name;
        return `
            <div class="pqn-float-binding ${binding.id === selectedId ? 'is-selected' : ''}" data-pqn-binding="${escapeHtml(binding.id)}">
                <div class="pqn-float-binding-name" title="${escapeHtml(binding.identifier)}">${escapeHtml(name)}</div>
                <button type="button" class="pqn-float-mini-btn" data-pqn-action="selectBinding" title="选择"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="pqn-float-mini-btn" data-pqn-action="removeBinding" title="删除绑定"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
    }

    function renderEditor(binding, prompt, content) {
        const settings = ensureSettings();
        const stateForBinding = getBindingState(binding.id);
        const selectedModules = new Set(Array.isArray(stateForBinding.moduleIds) ? stateForBinding.moduleIds : []);
        const quickGroup = settings.tagGroups.find(group => group.id === stateForBinding.quickGroupId) || getDefaultTagGroup();

        return `
            <div class="pqn-float-stack">
                <div>
                    <div class="pqn-float-label">正在编辑</div>
                    <div class="pqn-float-muted">${escapeHtml(prompt ? getPromptDisplayName(prompt) : `${binding.name}（未找到）`)}</div>
                </div>
                <div>
                    <div class="pqn-float-label">快捷输入组</div>
                    <select class="pqn-float-select" data-pqn-field="quickGroup">
                        ${settings.tagGroups.map(group => `<option value="${escapeHtml(group.id)}" ${quickGroup?.id === group.id ? 'selected' : ''}>${escapeHtml(group.name || '未命名组')}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <div class="pqn-float-label">预输入片段</div>
                    <div class="pqn-float-picker">
                        ${settings.modules.map(module => `
                            <label class="pqn-float-inline">
                                <input type="checkbox" data-pqn-module-pick="${escapeHtml(module.id)}" ${selectedModules.has(module.id) ? 'checked' : ''} ${module.enabled === false ? 'disabled' : ''}>
                                <span>${escapeHtml(module.title || '未命名片段')}</span>
                                ${module.enabled === false ? '<span class="pqn-float-muted">已停用</span>' : ''}
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div>
                    <div class="pqn-float-label">${escapeHtml(quickGroup?.labelB || '内容')}</div>
                    <textarea class="pqn-float-textarea" data-pqn-field="quickBContent" placeholder="留空则此组不会写入目标条目">${escapeHtml(content)}</textarea>
                </div>
                <div class="pqn-float-row">
                    <button type="button" class="pqn-float-btn" data-pqn-action="saveContent">
                        <i class="fa-solid fa-floppy-disk"></i>
                        <span>保存到绑定目标</span>
                    </button>
                    <button type="button" class="pqn-float-btn" data-pqn-action="reloadContent">
                        <i class="fa-solid fa-rotate-left"></i>
                        <span>从条目重新读取</span>
                    </button>
                    <span class="pqn-float-muted">只写入 B 内容非空的标签组。</span>
                </div>
            </div>`;
    }

    function renderWorldBindingSection(binding, stateForBinding) {
        const worldNames = getWorldNames();
        const selectedWorld = stateForBinding.worldDraftName || binding.worldBinding?.worldName || worldNames[0] || '';
        const entries = selectedWorld ? getCachedWorldEntries(selectedWorld) : [];
        const selectedUid = String(stateForBinding.worldDraftUid ?? binding.worldBinding?.uid ?? entries[0]?.uid ?? '');
        const boundText = binding.worldBinding
            ? `${binding.worldBinding.worldName} / ${binding.worldBinding.name || `UID ${binding.worldBinding.uid}`}`
            : '未绑定世界书条目';

        return `
            <div class="pqn-float-card pqn-float-stack">
                <div>
                    <div class="pqn-float-label">世界书同步</div>
                    <div class="pqn-float-world-badge" title="${escapeHtml(boundText)}">${escapeHtml(boundText)}</div>
                </div>
                <select class="pqn-float-select" data-pqn-field="worldToBind" ${worldNames.length ? '' : 'disabled'}>
                    ${worldNames.length ? worldNames.map(name => `<option value="${escapeHtml(name)}" ${selectedWorld === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('') : '<option value="">未读取到世界书</option>'}
                </select>
                <select class="pqn-float-select" data-pqn-field="worldEntryToBind" ${entries.length ? '' : 'disabled'}>
                    ${entries.length ? entries.map(entry => `<option value="${escapeHtml(entry.uid)}" ${String(entry.uid) === selectedUid ? 'selected' : ''}>${escapeHtml(getWorldEntryDisplayName(entry))}</option>`).join('') : '<option value="">选择世界书后读取条目</option>'}
                </select>
                <div class="pqn-float-row">
                    <button type="button" class="pqn-float-btn" data-pqn-action="loadWorldEntries" ${selectedWorld ? '' : 'disabled'}>
                        <i class="fa-solid fa-book-open"></i>
                        <span>读取条目</span>
                    </button>
                    <button type="button" class="pqn-float-btn" data-pqn-action="bindWorldEntry" ${entries.length ? '' : 'disabled'}>
                        <i class="fa-solid fa-link"></i>
                        <span>绑定</span>
                    </button>
                    <button type="button" class="pqn-float-btn" data-pqn-action="unbindWorldEntry" ${binding.worldBinding ? '' : 'disabled'}>
                        <i class="fa-solid fa-link-slash"></i>
                        <span>解绑</span>
                    </button>
                </div>
            </div>`;
    }

    function renderTagsSection() {
        const settings = ensureSettings();
        const binding = getSelectedBinding();
        const stateForBinding = binding ? getBindingState(binding.id) : null;

        return `
            <div class="pqn-float-stack">
                <div class="pqn-float-row">
                    <button type="button" class="pqn-float-btn" data-pqn-action="addTagGroup">
                        <i class="fa-solid fa-plus"></i>
                        <span>新增标签组</span>
                    </button>
                    <span class="pqn-float-muted">${binding ? `当前绑定：${escapeHtml(binding.name || binding.identifier)}` : '请先在快捷输入页添加或选择绑定。'}</span>
                </div>
                <div class="pqn-float-tag-list">
                    ${settings.tagGroups.map(group => renderTagGroupRow(group, stateForBinding)).join('')}
                </div>
            </div>`;
    }

    function renderTagGroupRow(group, stateForBinding) {
        const values = stateForBinding?.tagValues?.[group.id] || { a: '', b: '' };
        const removeDisabled = group.id === DEFAULT_TAG_GROUP_ID ? 'disabled' : '';
        return `
            <div class="pqn-float-tag-row" data-pqn-tag-group="${escapeHtml(group.id)}">
                <div>
                    <div class="pqn-float-label">组名</div>
                    <input class="pqn-float-input" data-pqn-tag-name="${escapeHtml(group.id)}" value="${escapeHtml(group.name || '')}" placeholder="组名">
                </div>
                <div>
                    <div class="pqn-float-label">标签 A</div>
                    <input class="pqn-float-input" data-pqn-tag-label-a="${escapeHtml(group.id)}" value="${escapeHtml(group.labelA || '')}" placeholder="名称">
                </div>
                <div>
                    <div class="pqn-float-label">标签 B</div>
                    <input class="pqn-float-input" data-pqn-tag-label-b="${escapeHtml(group.id)}" value="${escapeHtml(group.labelB || '')}" placeholder="内容">
                </div>
                <div>
                    <div class="pqn-float-label">A 内容</div>
                    <input class="pqn-float-input" data-pqn-tag-a-value="${escapeHtml(group.id)}" value="${escapeHtml(values.a || '')}" placeholder="通常为名称" ${stateForBinding ? '' : 'disabled'}>
                </div>
                <div class="pqn-float-row">
                    <label class="pqn-float-inline" title="启用">
                        <input type="checkbox" data-pqn-tag-enabled="${escapeHtml(group.id)}" ${group.enabled !== false ? 'checked' : ''}>
                        <span>启用</span>
                    </label>
                    <button type="button" class="pqn-float-mini-btn" data-pqn-action="tagGroupUp" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="pqn-float-mini-btn" data-pqn-action="tagGroupDown" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="pqn-float-mini-btn" data-pqn-action="removeTagGroup" title="删除" ${removeDisabled}><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`;
    }

    function renderModulesSection() {
        const settings = ensureSettings();
        return `
            <div class="pqn-float-stack">
                <div class="pqn-float-row">
                    <button type="button" class="pqn-float-btn" data-pqn-action="addModule">
                        <i class="fa-solid fa-plus"></i>
                        <span>新增预输入片段</span>
                    </button>
                    <span class="pqn-float-muted">片段按这里的顺序组合；可用上下按钮调整。</span>
                </div>
                <div class="pqn-float-module-list">
                    ${settings.modules.map(module => renderModuleRow(module)).join('')}
                </div>
            </div>`;
    }

    function renderModuleRow(module) {
        return `
            <div class="pqn-float-module" data-pqn-module="${escapeHtml(module.id)}">
                <div class="pqn-float-module-main pqn-float-stack">
                    <input class="pqn-float-input" data-pqn-module-title="${escapeHtml(module.id)}" value="${escapeHtml(module.title || '')}" placeholder="片段名称">
                    <textarea class="pqn-float-textarea pqn-float-module-text" data-pqn-module-text="${escapeHtml(module.id)}" placeholder="片段内容">${escapeHtml(module.text || '')}</textarea>
                </div>
                <label class="pqn-float-inline" title="启用">
                    <input type="checkbox" data-pqn-module-enabled="${escapeHtml(module.id)}" ${module.enabled !== false ? 'checked' : ''}>
                    <span>启用</span>
                </label>
                <button type="button" class="pqn-float-mini-btn" data-pqn-action="moduleUp" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="pqn-float-mini-btn" data-pqn-action="moduleDown" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="pqn-float-mini-btn" data-pqn-action="removeModule" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
    }

    function closest(target, selector) {
        return target?.closest?.(selector) || null;
    }

    function handlePanelClick(event) {
        const tab = closest(event.target, '[data-pqn-tab]')?.dataset.pqnTab;
        if (tab) {
            const settings = ensureSettings();
            settings.activeTab = tab;
            saveExtensionSettings();
            renderPanel();
            return;
        }

        const action = closest(event.target, '[data-pqn-action]')?.dataset.pqnAction;
        if (!action) return;

        const actions = {
            close: closePanel,
            refresh: refreshPanel,
            addBinding,
            selectBinding,
            removeBinding,
            saveContent: () => saveContent(),
            reloadContent,
            addModule,
            removeModule,
            moduleUp,
            moduleDown,
            addTagGroup,
            removeTagGroup,
            tagGroupUp,
            tagGroupDown,
            loadWorldEntries: () => loadSelectedWorldEntries(),
            bindWorldEntry,
            unbindWorldEntry,
        };

        Promise.resolve(actions[action]?.(event)).catch(error => {
            console.error('[PresetQuickNotex] Action failed:', error);
            notify(error?.message || '操作失败', 'error');
            renderPanel();
        });
    }

    function handlePanelInput(event) {
        const settings = ensureSettings();
        const binding = getSelectedBinding();

        if (event.target.matches?.('[data-pqn-field="quickBContent"]') && binding) {
            const stateForBinding = getBindingState(binding.id);
            const groupId = stateForBinding.quickGroupId || getDefaultTagGroup()?.id;
            if (groupId) {
                stateForBinding.tagValues[groupId] = stateForBinding.tagValues[groupId] || { a: '', b: '' };
                stateForBinding.tagValues[groupId].b = event.target.value;
            }
            saveExtensionSettings();
            return;
        }

        const titleId = event.target.dataset?.pqnModuleTitle;
        if (titleId) {
            const module = settings.modules.find(item => item.id === titleId);
            if (module) {
                module.title = event.target.value;
                saveExtensionSettings();
            }
            return;
        }

        const textId = event.target.dataset?.pqnModuleText;
        if (textId) {
            const module = settings.modules.find(item => item.id === textId);
            if (module) {
                module.text = event.target.value;
                saveExtensionSettings();
            }
            return;
        }

        const tagNameId = event.target.dataset?.pqnTagName;
        const tagLabelAId = event.target.dataset?.pqnTagLabelA;
        const tagLabelBId = event.target.dataset?.pqnTagLabelB;
        const tagAValueId = event.target.dataset?.pqnTagAValue;
        if (tagNameId || tagLabelAId || tagLabelBId) {
            const id = tagNameId || tagLabelAId || tagLabelBId;
            const group = settings.tagGroups.find(item => item.id === id);
            if (group) {
                if (tagNameId) group.name = event.target.value;
                if (tagLabelAId) group.labelA = event.target.value;
                if (tagLabelBId) group.labelB = event.target.value;
                saveExtensionSettings();
            }
            return;
        }

        if (tagAValueId && binding) {
            const stateForBinding = getBindingState(binding.id);
            stateForBinding.tagValues[tagAValueId] = stateForBinding.tagValues[tagAValueId] || { a: '', b: '' };
            stateForBinding.tagValues[tagAValueId].a = event.target.value;
            saveExtensionSettings();
        }
    }

    function handlePanelChange(event) {
        const settings = ensureSettings();
        const binding = getSelectedBinding();

        const pickId = event.target.dataset?.pqnModulePick;
        if (pickId && binding) {
            const stateForBinding = getBindingState(binding.id);
            const moduleIds = new Set(Array.isArray(stateForBinding.moduleIds) ? stateForBinding.moduleIds : []);
            if (event.target.checked) {
                moduleIds.add(pickId);
            } else {
                moduleIds.delete(pickId);
            }
            stateForBinding.moduleIds = settings.modules.filter(module => moduleIds.has(module.id)).map(module => module.id);
            saveExtensionSettings();
            return;
        }

        if (event.target.matches?.('[data-pqn-field="quickGroup"]') && binding) {
            getBindingState(binding.id).quickGroupId = event.target.value;
            saveExtensionSettings();
            renderPanel();
            return;
        }

        if (event.target.matches?.('[data-pqn-field="worldToBind"]') && binding) {
            const stateForBinding = getBindingState(binding.id);
            stateForBinding.worldDraftName = event.target.value;
            stateForBinding.worldDraftUid = '';
            saveExtensionSettings();
            loadSelectedWorldEntries().catch(error => {
                console.error('[PresetQuickNotex] World entries load failed:', error);
                notify(error?.message || '读取世界书条目失败', 'error');
                renderPanel();
            });
            return;
        }

        if (event.target.matches?.('[data-pqn-field="worldEntryToBind"]') && binding) {
            getBindingState(binding.id).worldDraftUid = event.target.value;
            saveExtensionSettings();
            return;
        }

        const enabledId = event.target.dataset?.pqnModuleEnabled;
        if (enabledId) {
            const module = settings.modules.find(item => item.id === enabledId);
            if (module) {
                module.enabled = event.target.checked;
                saveExtensionSettings();
                renderPanel();
            }
            return;
        }

        const tagEnabledId = event.target.dataset?.pqnTagEnabled;
        if (tagEnabledId) {
            const group = settings.tagGroups.find(item => item.id === tagEnabledId);
            if (group) {
                group.enabled = event.target.checked;
                saveExtensionSettings();
                renderPanel();
            }
        }
    }

    function addBinding() {
        const select = panel.querySelector('[data-pqn-field="promptToBind"]');
        const identifier = select?.value;
        const prompt = getPromptByIdentifier(identifier);
        if (!prompt) {
            notify('请先选择一个可绑定的提示词条目。', 'warning');
            return;
        }

        const settings = ensureSettings();
        let binding = settings.bindings.find(item => item.identifier === identifier);
        if (!binding) {
            binding = {
                id: uid('binding'),
                identifier,
                name: getPromptDisplayName(prompt),
            };
            settings.bindings.push(binding);
        } else {
            binding.name = getPromptDisplayName(prompt);
        }

        settings.lastBindingId = binding.id;
        setBodyOnBindingState(binding, parseBodyFromWrappedContent(prompt.content || ''));
        saveExtensionSettings();
        renderPanel();
    }

    function selectBinding(event) {
        const id = closest(event.target, '[data-pqn-binding]')?.dataset.pqnBinding;
        if (!id) return;
        ensureSettings().lastBindingId = id;
        saveExtensionSettings();
        renderPanel();
    }

    function removeBinding(event) {
        const id = closest(event.target, '[data-pqn-binding]')?.dataset.pqnBinding;
        if (!id) return;

        const settings = ensureSettings();
        settings.bindings = settings.bindings.filter(binding => binding.id !== id);
        delete settings.bindingState[id];
        if (settings.lastBindingId === id) {
            settings.lastBindingId = settings.bindings[0]?.id || '';
        }
        saveExtensionSettings();
        renderPanel();
    }

    async function saveContent(options = {}) {
        const { silent = false, rerender = true } = options;
        const binding = getSelectedBinding();
        if (!binding) return false;

        const textarea = panel.querySelector('[data-pqn-field="quickBContent"]');
        if (textarea) {
            const stateForBinding = getBindingState(binding.id);
            const groupId = stateForBinding.quickGroupId || getDefaultTagGroup()?.id;
            if (groupId) {
                stateForBinding.tagValues[groupId] = stateForBinding.tagValues[groupId] || { a: '', b: '' };
                stateForBinding.tagValues[groupId].b = textarea.value || '';
            }
        }

        if (binding.worldBinding) {
            await validateWorldBinding(binding.worldBinding);
        }

        const composed = composeContent(binding.id);
        const prompt = syncPresetPrompt(binding.identifier, composed);
        binding.name = getPromptDisplayName(prompt);
        if (binding.worldBinding) {
            await syncWorldInfoEntry(binding.worldBinding, composed);
        }
        await saveCurrentPresetWithoutRefresh();
        saveExtensionSettings();
        if (!silent) {
            notify(binding.worldBinding ? '已同步到当前预设和世界书条目。' : '已保存到当前对话补全预设。', 'success');
        }
        if (rerender) {
            renderPanel();
        }
        return true;
    }

    function reloadContent() {
        const binding = getSelectedBinding();
        if (!binding) return;

        const prompt = getPromptByIdentifier(binding.identifier);
        if (!prompt) {
            notify('找不到绑定的提示词条目。', 'warning');
            return;
        }

        setBodyOnBindingState(binding, parseBodyFromWrappedContent(prompt.content || ''));
        saveExtensionSettings();
        renderPanel();
    }

    function addModule() {
        const settings = ensureSettings();
        const module = {
            id: uid('module'),
            title: '新片段',
            text: '',
            enabled: true,
        };

        settings.modules.push(module);
        for (const stateForBinding of Object.values(settings.bindingState)) {
            if (Array.isArray(stateForBinding.moduleIds)) {
                stateForBinding.moduleIds.push(module.id);
            }
        }
        saveExtensionSettings();
        renderPanel();
    }

    function removeModule(event) {
        const id = closest(event.target, '[data-pqn-module]')?.dataset.pqnModule;
        if (!id) return;

        const settings = ensureSettings();
        settings.modules = settings.modules.filter(module => module.id !== id);
        for (const stateForBinding of Object.values(settings.bindingState)) {
            if (Array.isArray(stateForBinding.moduleIds)) {
                stateForBinding.moduleIds = stateForBinding.moduleIds.filter(moduleId => moduleId !== id);
            }
        }
        saveExtensionSettings();
        renderPanel();
    }

    function moveModule(event, direction) {
        const id = closest(event.target, '[data-pqn-module]')?.dataset.pqnModule;
        if (!id) return;

        const settings = ensureSettings();
        const index = settings.modules.findIndex(module => module.id === id);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= settings.modules.length) return;

        const [module] = settings.modules.splice(index, 1);
        settings.modules.splice(nextIndex, 0, module);
        saveExtensionSettings();
        renderPanel();
    }

    function moduleUp(event) {
        moveModule(event, -1);
    }

    function moduleDown(event) {
        moveModule(event, 1);
    }

    function addTagGroup() {
        const settings = ensureSettings();
        const group = {
            id: uid('tag'),
            name: '新标签组',
            labelA: '名称',
            labelB: '内容',
            enabled: true,
        };
        settings.tagGroups.push(group);
        for (const stateForBinding of Object.values(settings.bindingState)) {
            if (stateForBinding?.tagValues) {
                stateForBinding.tagValues[group.id] = { a: '', b: '' };
            }
        }
        saveExtensionSettings();
        renderPanel();
    }

    function removeTagGroup(event) {
        const id = closest(event.target, '[data-pqn-tag-group]')?.dataset.pqnTagGroup;
        if (!id || id === DEFAULT_TAG_GROUP_ID) return;

        const settings = ensureSettings();
        settings.tagGroups = settings.tagGroups.filter(group => group.id !== id);
        for (const stateForBinding of Object.values(settings.bindingState)) {
            delete stateForBinding?.tagValues?.[id];
            if (stateForBinding?.quickGroupId === id) {
                stateForBinding.quickGroupId = getDefaultTagGroup()?.id || DEFAULT_TAG_GROUP_ID;
            }
        }
        saveExtensionSettings();
        renderPanel();
    }

    function moveTagGroup(event, direction) {
        const id = closest(event.target, '[data-pqn-tag-group]')?.dataset.pqnTagGroup;
        if (!id) return;

        const settings = ensureSettings();
        const index = settings.tagGroups.findIndex(group => group.id === id);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= settings.tagGroups.length) return;

        const [group] = settings.tagGroups.splice(index, 1);
        settings.tagGroups.splice(nextIndex, 0, group);
        saveExtensionSettings();
        renderPanel();
    }

    function tagGroupUp(event) {
        moveTagGroup(event, -1);
    }

    function tagGroupDown(event) {
        moveTagGroup(event, 1);
    }

    async function loadSelectedWorldEntries() {
        const binding = getSelectedBinding();
        if (!binding) return;
        const stateForBinding = getBindingState(binding.id);
        const select = panel.querySelector('[data-pqn-field="worldToBind"]');
        const worldName = select?.value || stateForBinding.worldDraftName || binding.worldBinding?.worldName || getWorldNames()[0] || '';
        if (!worldName) {
            notify('请先选择世界书。', 'warning');
            return;
        }
        stateForBinding.worldDraftName = worldName;
        await loadWorldEntries(worldName);
        saveExtensionSettings();
        renderPanel();
    }

    async function bindWorldEntry() {
        const binding = getSelectedBinding();
        if (!binding) return;
        const stateForBinding = getBindingState(binding.id);
        const worldName = panel.querySelector('[data-pqn-field="worldToBind"]')?.value || stateForBinding.worldDraftName;
        const uidValue = panel.querySelector('[data-pqn-field="worldEntryToBind"]')?.value || stateForBinding.worldDraftUid;
        if (!worldName || uidValue === undefined || uidValue === '') {
            notify('请先选择世界书和条目。', 'warning');
            return;
        }
        const data = await loadWorldEntries(worldName);
        const entry = data?.entries?.[String(uidValue)];
        if (!entry) {
            throw new Error(`找不到世界书条目：${worldName} / UID ${uidValue}`);
        }
        binding.worldBinding = {
            worldName,
            uid: String(entry.uid),
            name: getWorldEntryDisplayName(entry),
        };
        stateForBinding.worldDraftName = worldName;
        stateForBinding.worldDraftUid = String(entry.uid);
        saveExtensionSettings();
        notify('已绑定世界书条目。', 'success');
        renderPanel();
    }

    function unbindWorldEntry() {
        const binding = getSelectedBinding();
        if (!binding) return;
        delete binding.worldBinding;
        saveExtensionSettings();
        renderPanel();
    }

    async function refreshPanel() {
        runtime.loaded = false;
        runtime.loading = false;
        runtime.error = '';
        runtime.worldEntryCache = {};
        await loadRuntime();
        renderPanel();
    }

    function handleFabPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault?.();

        const start = { x: event.clientX || 0, y: event.clientY || 0 };
        const initial = { ...state.fabPosition };
        let moved = false;

        const onMove = moveEvent => {
            const dx = (moveEvent.clientX || 0) - start.x;
            const dy = (moveEvent.clientY || 0) - start.y;
            if (!moved && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
            moved = true;
            state.fabDragging = true;
            fab.classList.add('is-dragging');
            state.fabPosition = clampFabPosition({ x: initial.x + dx, y: initial.y + dy });
            applyFabPosition();
        };

        const onUp = () => {
            hostWin.removeEventListener?.('pointermove', onMove);
            hostWin.removeEventListener?.('pointerup', onUp);
            fab.classList.remove('is-dragging');
            state.fabDragging = false;
            if (!moved) {
                openPanel();
            }
        };

        hostWin.addEventListener?.('pointermove', onMove);
        hostWin.addEventListener?.('pointerup', onUp);
    }

    function handlePanelPointerDown(event) {
        if (state.mobile || (event.button !== undefined && event.button !== 0)) return;
        if (!closest(event.target, '[data-pqn-drag-handle="panel"]')) return;
        if (closest(event.target, 'button, input, textarea, select, label')) return;
        event.preventDefault?.();

        const start = { x: event.clientX || 0, y: event.clientY || 0 };
        const initial = { ...(state.panelPosition || getDefaultPanelPosition()) };
        let moved = false;

        const onMove = moveEvent => {
            const dx = (moveEvent.clientX || 0) - start.x;
            const dy = (moveEvent.clientY || 0) - start.y;
            if (!moved && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
            moved = true;
            state.panelDragging = true;
            panel.querySelector('.pqn-float-header')?.classList.add('is-dragging');
            state.panelPosition = clampPanelPosition({ x: initial.x + dx, y: initial.y + dy });
            applyPanelGeometry();
        };

        const onUp = () => {
            hostWin.removeEventListener?.('pointermove', onMove);
            hostWin.removeEventListener?.('pointerup', onUp);
            panel.querySelector('.pqn-float-header')?.classList.remove('is-dragging');
            state.panelDragging = false;
        };

        hostWin.addEventListener?.('pointermove', onMove);
        hostWin.addEventListener?.('pointerup', onUp);
    }

    function handleResizePointerDown(event) {
        if (state.mobile || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault?.();
        event.stopPropagation?.();

        const start = { x: event.clientX || 0, y: event.clientY || 0 };
        const initial = { ...state.panelSize };

        const onMove = moveEvent => {
            const dx = (moveEvent.clientX || 0) - start.x;
            const dy = (moveEvent.clientY || 0) - start.y;
            state.panelSize = normalizePanelSize({
                width: initial.width + dx,
                height: initial.height + dy,
            });
            applyPanelGeometry();
        };

        const onUp = () => {
            hostWin.removeEventListener?.('pointermove', onMove);
            hostWin.removeEventListener?.('pointerup', onUp);
            saveJson(PANEL_SIZE_KEY, state.panelSize);
        };

        hostWin.addEventListener?.('pointermove', onMove);
        hostWin.addEventListener?.('pointerup', onUp);
    }

    function handleViewportChange() {
        state.mobile = isMobile();
        applyFabPosition();
        applyPanelGeometry();
    }

    function bindPresetChanged() {
        const eventSource = getEventSource();
        const presetChanged = getEventTypes().PRESET_CHANGED;
        if (!eventSource?.on || !presetChanged || eventSource.__pqnFloatingBound) return;

        const handler = event => {
            if (!event || event.apiId === 'openai') {
                renderPanel();
            }
        };
        eventSource.on(presetChanged, handler);
        eventSource.__pqnFloatingBound = true;
        disposers.push(() => {
            eventSource.off?.(presetChanged, handler);
            eventSource.removeListener?.(presetChanged, handler);
            eventSource.__pqnFloatingBound = false;
        });
    }

    function cleanup() {
        while (disposers.length) {
            try {
                disposers.pop()();
            } catch (_) {
                // Continue cleanup.
            }
        }
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(STYLE_ID)?.remove();
        if (hostWin.openPresetQuickNotex === openPanel) {
            delete hostWin.openPresetQuickNotex;
        }
        if (hostWin.closePresetQuickNotex === closePanel) {
            delete hostWin.closePresetQuickNotex;
        }
        if (hostWin.__PresetQuickNotexFloatingCleanup === cleanup) {
            delete hostWin.__PresetQuickNotexFloatingCleanup;
        }
    }

    function init() {
        injectStyle();
        createRoot();
        hostWin.openPresetQuickNotex = openPanel;
        hostWin.closePresetQuickNotex = closePanel;
        hostWin.__PresetQuickNotexFloatingCleanup = cleanup;
        loadRuntime().then(() => {
            if (state.open) renderPanel();
        });
    }

    init();
})();
