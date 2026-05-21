import {
    eventSource,
    event_types,
    main_api,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import {
    oai_settings,
    openai_setting_names,
    openai_settings,
    promptManager,
} from '../../../openai.js';

const MODULE_NAME = 'presetQuickNote';
const BUTTON_ID = 'pqnMenuButton';
const MODAL_ID = 'pqnModal';
const NOTE_OPEN = '<本次内容注意>';
const NOTE_CLOSE = '</本次内容注意>';

const defaultSettings = {
    bindings: [],
    modules: [
        { id: 'role', title: '角色', text: '角色相关注意事项：', enabled: true },
        { id: 'rules', title: '规则', text: '规则相关注意事项：', enabled: true },
        { id: 'notes', title: '注意事项', text: '本次内容注意事项：', enabled: true },
    ],
    bindingState: {},
    lastBindingId: '',
    activeTab: 'quick',
};

function uid(prefix = 'pqn') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    settings.bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
    settings.modules = Array.isArray(settings.modules) ? settings.modules : structuredClone(defaultSettings.modules);
    settings.bindingState = settings.bindingState && typeof settings.bindingState === 'object' ? settings.bindingState : {};
    settings.lastBindingId = settings.lastBindingId || '';
    settings.activeTab = settings.activeTab || 'quick';

    if (settings.modules.length === 0) {
        settings.modules = structuredClone(defaultSettings.modules);
    }

    return settings;
}

function saveExtensionSettings() {
    saveSettingsDebounced();
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function notify(message, type = 'info') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message);
    } else {
        console[type === 'error' ? 'error' : 'log'](`[preset-quick-note] ${message}`);
    }
}

function isOpenAiApi() {
    return main_api === 'openai';
}

function getOpenAiPresetManager() {
    return getPresetManager('openai');
}

function getCurrentPresetName() {
    const manager = getOpenAiPresetManager();
    return manager?.getSelectedPresetName?.() || oai_settings.preset_settings_openai || '';
}

function getCurrentPresetObject() {
    const manager = getOpenAiPresetManager();
    const name = getCurrentPresetName();
    const listIndex = openai_setting_names?.[name];
    const listPreset = listIndex !== undefined ? openai_settings?.[listIndex] : null;
    const managerPreset = manager?.getCompletionPresetByName?.(name);
    return listPreset || managerPreset || manager?.getPresetSettings?.(name) || oai_settings;
}

function getPromptList() {
    const prompts = promptManager?.serviceSettings?.prompts || oai_settings.prompts || [];
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

    const inner = text.slice(openIndex + NOTE_OPEN.length, closeIndex).trim();
    const settings = ensureSettings();
    let body = inner;

    for (const module of settings.modules) {
        const moduleText = String(module.text || '').trim();
        if (moduleText && body.startsWith(moduleText)) {
            body = body.slice(moduleText.length).trimStart();
        }
    }

    return body.trim();
}

function getSelectedBinding() {
    const settings = ensureSettings();
    return settings.bindings.find(binding => binding.id === settings.lastBindingId) || settings.bindings[0] || null;
}

function getBindingState(bindingId) {
    const settings = ensureSettings();
    if (!settings.bindingState[bindingId]) {
        settings.bindingState[bindingId] = {
            content: '',
            moduleIds: settings.modules.filter(module => module.enabled !== false).map(module => module.id),
        };
    }
    return settings.bindingState[bindingId];
}

function composeContent(bindingId, body) {
    const text = String(body || '').trim();
    if (!text) return '';

    const settings = ensureSettings();
    const state = getBindingState(bindingId);
    const moduleIds = Array.isArray(state.moduleIds) ? state.moduleIds : [];
    const parts = settings.modules
        .filter(module => module.enabled !== false && moduleIds.includes(module.id))
        .map(module => String(module.text || '').trim())
        .filter(Boolean);

    parts.push(text);
    return `${NOTE_OPEN}\n${parts.join('\n')}\n${NOTE_CLOSE}`;
}

function syncPresetPrompt(identifier, content) {
    const prompt = getPromptByIdentifier(identifier);
    if (!prompt) {
        throw new Error(`找不到提示词条目：${identifier}`);
    }

    prompt.content = content;
    if (Array.isArray(oai_settings.prompts)) {
        const settingsPrompt = oai_settings.prompts.find(item => item?.identifier === identifier);
        if (settingsPrompt) {
            settingsPrompt.content = content;
        }
    }

    const preset = getCurrentPresetObject();
    if (preset && Array.isArray(preset.prompts)) {
        const presetPrompt = preset.prompts.find(item => item?.identifier === identifier);
        if (presetPrompt) {
            presetPrompt.content = content;
        }
    }

    const presetName = getCurrentPresetName();
    const presetIndex = openai_setting_names?.[presetName];
    const cachedPreset = presetIndex !== undefined ? openai_settings?.[presetIndex] : null;
    if (cachedPreset && Array.isArray(cachedPreset.prompts)) {
        const cachedPrompt = cachedPreset.prompts.find(item => item?.identifier === identifier);
        if (cachedPrompt) {
            cachedPrompt.content = content;
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
    const preset = getCurrentPresetObject();
    await manager.savePreset(name, preset, { skipUpdate: true });
}

function createMenuButton() {
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
        button = document.createElement('div');
        button.id = BUTTON_ID;
        button.className = 'list-group-item flex-container flexGap5 interactable';
        button.tabIndex = 0;
        button.innerHTML = '<span class="fa-solid fa-note-sticky"></span><span>预设快捷提示词</span>';
        button.addEventListener('click', openModal);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openModal();
            }
        });
    }

    placeMenuButton(button);
}

function placeMenuButton(button = document.getElementById(BUTTON_ID)) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || !button) return;

    const charButton = document.getElementById('charManagerBtn');
    if (charButton && charButton.parentElement === menu) {
        charButton.insertAdjacentElement('afterend', button);
    } else if (!menu.contains(button)) {
        menu.prepend(button);
    }
}

function observeMenuPlacement() {
    const observer = new MutationObserver(() => placeMenuButton());
    observer.observe(document.body, { childList: true, subtree: true });
}

function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
        <div class="pqn-panel">
            <div class="pqn-header">
                <div class="pqn-title">预设快捷提示词</div>
                <button type="button" class="menu_button menu_button_icon" data-pqn-action="close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="pqn-body"></div>
            <div class="pqn-footer">
                <button type="button" class="menu_button" data-pqn-action="close">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', event => {
        if (event.target === modal) closeModal();
    });
    modal.addEventListener('click', handleModalClick);
    modal.addEventListener('input', handleModalInput);
    modal.addEventListener('change', handleModalChange);
    return modal;
}

function openModal() {
    const modal = ensureModal();
    renderModal();
    modal.classList.add('pqn-open');
}

function closeModal() {
    document.getElementById(MODAL_ID)?.classList.remove('pqn-open');
}

function renderModal() {
    const modal = ensureModal();
    const body = modal.querySelector('.pqn-body');
    const settings = ensureSettings();
    const tab = settings.activeTab;
    body.innerHTML = `
        <div class="pqn-tabs">
            ${renderTab('quick', '快捷输入', tab)}
            ${renderTab('modules', '预输入编辑', tab)}
            ${renderTab('future', '预留功能', tab)}
        </div>
        <div class="pqn-section ${tab === 'quick' ? 'pqn-active' : ''}" data-pqn-section="quick">${renderQuickSection()}</div>
        <div class="pqn-section ${tab === 'modules' ? 'pqn-active' : ''}" data-pqn-section="modules">${renderModulesSection()}</div>
        <div class="pqn-section ${tab === 'future' ? 'pqn-active' : ''}" data-pqn-section="future">${renderFutureSection()}</div>
    `;
}

function renderTab(id, label, activeTab) {
    return `<div class="pqn-tab ${activeTab === id ? 'pqn-active' : ''}" data-pqn-tab="${id}">${escapeHtml(label)}</div>`;
}

function renderQuickSection() {
    if (!isOpenAiApi()) {
        return '<div class="pqn-muted">当前不是对话补全 API。此扩展只编辑“对话补全预设”的提示词条目。</div>';
    }

    const prompts = getPromptList();
    const settings = ensureSettings();
    const binding = getSelectedBinding();
    const state = binding ? getBindingState(binding.id) : null;
    const prompt = binding ? getPromptByIdentifier(binding.identifier) : null;
    const currentContent = state?.content || parseBodyFromWrappedContent(prompt?.content || '');

    return `
        <div class="pqn-grid">
            <div class="pqn-column pqn-stack">
                <div>
                    <div class="pqn-label">当前预设</div>
                    <div class="pqn-muted">${escapeHtml(getCurrentPresetName() || '未选择')}</div>
                </div>
                <div class="pqn-stack">
                    <div class="pqn-label">添加绑定</div>
                    <select class="text_pole pqn-select" data-pqn-field="promptToBind">
                        ${prompts.map(prompt => `<option value="${escapeHtml(prompt.identifier)}">${escapeHtml(getPromptDisplayName(prompt))}</option>`).join('')}
                    </select>
                    <button type="button" class="menu_button" data-pqn-action="addBinding">添加当前条目</button>
                </div>
                <div class="pqn-stack">
                    <div class="pqn-label">已绑定条目</div>
                    <div class="pqn-binding-list">
                        ${settings.bindings.length ? settings.bindings.map(item => renderBindingRow(item, binding?.id)).join('') : '<div class="pqn-muted">还没有绑定。先从上方选择一个提示词条目添加。</div>'}
                    </div>
                </div>
            </div>
            <div class="pqn-column pqn-stack">
                ${binding ? renderEditor(binding, prompt, currentContent) : '<div class="pqn-muted">请选择或添加一个绑定。</div>'}
            </div>
        </div>
    `;
}

function renderBindingRow(binding, selectedId) {
    const found = getPromptByIdentifier(binding.identifier);
    const name = found ? getPromptDisplayName(found) : binding.name;
    return `
        <div class="pqn-binding-row ${binding.id === selectedId ? 'pqn-selected' : ''}" data-pqn-binding="${escapeHtml(binding.id)}">
            <div class="pqn-binding-name" title="${escapeHtml(binding.identifier)}">${escapeHtml(name)}</div>
            <button type="button" class="menu_button menu_button_icon" data-pqn-action="selectBinding" title="选择"><i class="fa-solid fa-check"></i></button>
            <button type="button" class="menu_button menu_button_icon" data-pqn-action="removeBinding" title="删除绑定"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    `;
}

function renderEditor(binding, prompt, content) {
    const settings = ensureSettings();
    const state = getBindingState(binding.id);
    const selectedModules = new Set(Array.isArray(state.moduleIds) ? state.moduleIds : []);

    return `
        <div class="pqn-stack">
            <div>
                <div class="pqn-label">正在编辑</div>
                <div class="pqn-muted">${escapeHtml(prompt ? getPromptDisplayName(prompt) : `${binding.name}（未找到）`)}</div>
            </div>
            <div class="pqn-stack">
                <div class="pqn-label">预输入片段</div>
                <div class="pqn-module-picker">
                    ${settings.modules.map(module => `
                        <label class="pqn-inline">
                            <input type="checkbox" data-pqn-module-pick="${escapeHtml(module.id)}" ${selectedModules.has(module.id) ? 'checked' : ''} ${module.enabled === false ? 'disabled' : ''}>
                            <span>${escapeHtml(module.title || '未命名片段')}</span>
                            ${module.enabled === false ? '<span class="pqn-muted">已停用</span>' : ''}
                        </label>
                    `).join('')}
                </div>
            </div>
            <div class="pqn-stack">
                <div class="pqn-label">本次内容</div>
                <textarea class="text_pole pqn-textarea" data-pqn-field="content" placeholder="留空保存会清空目标提示词条目">${escapeHtml(content)}</textarea>
            </div>
            <div class="pqn-row">
                <button type="button" class="menu_button" data-pqn-action="saveContent">保存到当前预设条目</button>
                <button type="button" class="menu_button" data-pqn-action="reloadContent">从条目重新读取</button>
                <span class="pqn-muted">空内容会清空目标条目。</span>
            </div>
        </div>
    `;
}

function renderModulesSection() {
    const settings = ensureSettings();
    return `
        <div class="pqn-stack">
            <div class="pqn-row">
                <button type="button" class="menu_button" data-pqn-action="addModule">新增预输入片段</button>
                <span class="pqn-muted">片段按这里的顺序组合；可用上下按钮调整。</span>
            </div>
            <div class="pqn-module-list">
                ${settings.modules.map(module => renderModuleRow(module)).join('')}
            </div>
        </div>
    `;
}

function renderModuleRow(module) {
    return `
        <div class="pqn-module-row" data-pqn-module="${escapeHtml(module.id)}">
            <div class="pqn-module-main pqn-stack">
                <input class="text_pole pqn-input" data-pqn-module-title="${escapeHtml(module.id)}" value="${escapeHtml(module.title || '')}" placeholder="片段名称">
                <textarea class="text_pole pqn-textarea pqn-module-text" data-pqn-module-text="${escapeHtml(module.id)}" placeholder="片段内容">${escapeHtml(module.text || '')}</textarea>
            </div>
            <label class="pqn-inline" title="启用">
                <input type="checkbox" data-pqn-module-enabled="${escapeHtml(module.id)}" ${module.enabled !== false ? 'checked' : ''}>
                <span>启用</span>
            </label>
            <button type="button" class="menu_button menu_button_icon" data-pqn-action="moduleUp" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" class="menu_button menu_button_icon" data-pqn-action="moduleDown" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
            <button type="button" class="menu_button menu_button_icon" data-pqn-action="removeModule" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    `;
}

function renderFutureSection() {
    return '<div class="pqn-muted">这里先预留给后续功能。</div>';
}

function handleModalClick(event) {
    const action = event.target.closest('[data-pqn-action]')?.dataset.pqnAction;
    if (!action) {
        const tab = event.target.closest('[data-pqn-tab]')?.dataset.pqnTab;
        if (tab) {
            ensureSettings().activeTab = tab;
            saveExtensionSettings();
            renderModal();
        }
        return;
    }

    const actionHandlers = {
        close: closeModal,
        addBinding,
        selectBinding,
        removeBinding,
        saveContent,
        reloadContent,
        addModule,
        removeModule,
        moduleUp,
        moduleDown,
    };

    actionHandlers[action]?.(event);
}

function handleModalInput(event) {
    const settings = ensureSettings();
    const binding = getSelectedBinding();

    if (event.target.matches('[data-pqn-field="content"]') && binding) {
        getBindingState(binding.id).content = event.target.value;
        saveExtensionSettings();
        return;
    }

    const titleId = event.target.dataset.pqnModuleTitle;
    if (titleId) {
        const module = settings.modules.find(item => item.id === titleId);
        if (module) {
            module.title = event.target.value;
            saveExtensionSettings();
        }
        return;
    }

    const textId = event.target.dataset.pqnModuleText;
    if (textId) {
        const module = settings.modules.find(item => item.id === textId);
        if (module) {
            module.text = event.target.value;
            saveExtensionSettings();
        }
    }
}

function handleModalChange(event) {
    const settings = ensureSettings();
    const binding = getSelectedBinding();

    const pickId = event.target.dataset.pqnModulePick;
    if (pickId && binding) {
        const state = getBindingState(binding.id);
        const moduleIds = new Set(Array.isArray(state.moduleIds) ? state.moduleIds : []);
        if (event.target.checked) {
            moduleIds.add(pickId);
        } else {
            moduleIds.delete(pickId);
        }
        state.moduleIds = settings.modules.filter(module => moduleIds.has(module.id)).map(module => module.id);
        saveExtensionSettings();
        return;
    }

    const enabledId = event.target.dataset.pqnModuleEnabled;
    if (enabledId) {
        const module = settings.modules.find(item => item.id === enabledId);
        if (module) {
            module.enabled = event.target.checked;
            saveExtensionSettings();
            renderModal();
        }
    }
}

function addBinding() {
    const select = document.querySelector(`#${MODAL_ID} [data-pqn-field="promptToBind"]`);
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
    const state = getBindingState(binding.id);
    state.content = state.content || parseBodyFromWrappedContent(prompt.content || '');
    saveExtensionSettings();
    renderModal();
}

function selectBinding(event) {
    const id = event.target.closest('[data-pqn-binding]')?.dataset.pqnBinding;
    if (!id) return;
    ensureSettings().lastBindingId = id;
    saveExtensionSettings();
    renderModal();
}

function removeBinding(event) {
    const id = event.target.closest('[data-pqn-binding]')?.dataset.pqnBinding;
    if (!id) return;

    const settings = ensureSettings();
    settings.bindings = settings.bindings.filter(binding => binding.id !== id);
    delete settings.bindingState[id];
    if (settings.lastBindingId === id) {
        settings.lastBindingId = settings.bindings[0]?.id || '';
    }
    saveExtensionSettings();
    renderModal();
}

async function saveContent() {
    const binding = getSelectedBinding();
    if (!binding) return;

    try {
        const textarea = document.querySelector(`#${MODAL_ID} [data-pqn-field="content"]`);
        const rawContent = textarea?.value || '';
        const state = getBindingState(binding.id);
        state.content = rawContent;
        const composed = composeContent(binding.id, rawContent);
        const prompt = syncPresetPrompt(binding.identifier, composed);
        binding.name = getPromptDisplayName(prompt);
        await saveCurrentPresetWithoutRefresh();
        saveExtensionSettings();
        notify('已保存到当前对话补全预设。', 'success');
        renderModal();
    } catch (error) {
        console.error('[preset-quick-note] save failed:', error);
        notify(error.message || '保存失败', 'error');
    }
}

function reloadContent() {
    const binding = getSelectedBinding();
    if (!binding) return;

    const prompt = getPromptByIdentifier(binding.identifier);
    if (!prompt) {
        notify('找不到绑定的提示词条目。', 'warning');
        return;
    }

    getBindingState(binding.id).content = parseBodyFromWrappedContent(prompt.content || '');
    saveExtensionSettings();
    renderModal();
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
    for (const state of Object.values(settings.bindingState)) {
        if (Array.isArray(state.moduleIds)) {
            state.moduleIds.push(module.id);
        }
    }
    saveExtensionSettings();
    renderModal();
}

function removeModule(event) {
    const id = event.target.closest('[data-pqn-module]')?.dataset.pqnModule;
    if (!id) return;

    const settings = ensureSettings();
    settings.modules = settings.modules.filter(module => module.id !== id);
    for (const state of Object.values(settings.bindingState)) {
        if (Array.isArray(state.moduleIds)) {
            state.moduleIds = state.moduleIds.filter(moduleId => moduleId !== id);
        }
    }
    saveExtensionSettings();
    renderModal();
}

function moveModule(event, direction) {
    const id = event.target.closest('[data-pqn-module]')?.dataset.pqnModule;
    if (!id) return;

    const settings = ensureSettings();
    const index = settings.modules.findIndex(module => module.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= settings.modules.length) return;
    const [module] = settings.modules.splice(index, 1);
    settings.modules.splice(nextIndex, 0, module);
    saveExtensionSettings();
    renderModal();
}

function moduleUp(event) {
    moveModule(event, -1);
}

function moduleDown(event) {
    moveModule(event, 1);
}

function init() {
    ensureSettings();
    createMenuButton();
    observeMenuPlacement();
    eventSource.on(event_types.PRESET_CHANGED, event => {
        if (event?.apiId === 'openai' && document.getElementById(MODAL_ID)?.classList.contains('pqn-open')) {
            renderModal();
        }
    });
}

jQuery(init);
