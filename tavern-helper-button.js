'use strict';

(function () {
    let doc = document;
    let parentWin = window;

    try {
        if (window.parent && window.parent.document !== document) {
            doc = window.parent.document;
            parentWin = window.parent;
        }
    } catch (_) {
        // Cross-frame access can be blocked in unusual embeds. Fall back to current window.
    }

    const MENU_BUTTON_ID = 'pqnHelperMenuButton';
    const CHAT_BUTTON_ID = 'pqnHelperChatButton';
    const COMPOSER_BAR_ID = 'pqnHelperComposerBar';
    const COMPOSER_BUTTON_ID = 'pqnHelperComposerButton';
    const MAX_ATTEMPTS = 20;
    const INTERVAL_MS = 500;

    function notify(message, type = 'info') {
        try {
            const toastr = parentWin.toastr || window.toastr;
            if (toastr && typeof toastr[type] === 'function') {
                toastr[type](message);
                return;
            }
        } catch (_) {}
        console.log('[PresetQuickNotex]', message);
    }

    function openPresetQuickNotex() {
        const open =
            parentWin.openPresetQuickNotex ||
            window.openPresetQuickNotex ||
            parentWin.SillyTavern?.openPresetQuickNotex;

        if (typeof open === 'function') {
            open();
            return;
        }

        const pluginButton = doc.getElementById('pqnMenuButton');
        if (pluginButton) {
            pluginButton.click();
            return;
        }

        notify('预设快捷提示词插件还没有加载。请确认扩展已安装并启用。', 'warning');
    }

    function buildMenuButton() {
        const button = doc.createElement('div');
        button.id = MENU_BUTTON_ID;
        button.className = 'list-group-item flex-container flexGap5 interactable';
        button.tabIndex = 0;
        button.innerHTML = '<span class="fa-solid fa-note-sticky"></span><span>预设快捷提示词</span>';
        button.addEventListener('click', openPresetQuickNotex);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPresetQuickNotex();
            }
        });
        return button;
    }

    function buildChatButton() {
        const button = doc.createElement('div');
        button.id = CHAT_BUTTON_ID;
        button.className = 'fa-solid fa-note-sticky interactable';
        button.title = '预设快捷提示词';
        button.style.cssText = 'display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;margin-left:4px;';
        button.addEventListener('click', openPresetQuickNotex);
        return button;
    }

    function buildComposerButton() {
        const button = doc.createElement('button');
        button.type = 'button';
        button.id = COMPOSER_BUTTON_ID;
        button.className = 'menu_button interactable';
        button.title = '预设快捷提示词';
        button.innerHTML = '<span class="fa-solid fa-note-sticky"></span><span>预设快捷提示词</span>';
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:4px 10px;white-space:nowrap;';
        button.addEventListener('click', openPresetQuickNotex);
        return button;
    }

    function getSendForm() {
        const sendTextarea = doc.getElementById('send_textarea') || doc.querySelector('[name="send_textarea"]');
        return (
            doc.getElementById('leftSendForm') ||
            sendTextarea?.closest('form, .flex-container, .send-form, .send_form')
        );
    }

    function placeMenuButton() {
        const menu = doc.getElementById('extensionsMenu') || doc.getElementById('extensions_menu');
        if (!menu) return false;

        const button = doc.getElementById(MENU_BUTTON_ID) || buildMenuButton();
        const charButton = doc.getElementById('charManagerBtn');

        if (charButton && charButton.parentElement === menu) {
            if (charButton.nextElementSibling !== button) {
                charButton.insertAdjacentElement('afterend', button);
            }
        } else if (!menu.contains(button)) {
            menu.prepend(button);
        }

        return true;
    }

    function placeComposerButton() {
        const sendForm = getSendForm();
        if (!sendForm) return false;

        const bar = doc.getElementById(COMPOSER_BAR_ID) || doc.createElement('div');
        bar.id = COMPOSER_BAR_ID;
        bar.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1 0 100%;width:100%;order:-1000;margin:0 0 6px 0;';

        const button = doc.getElementById(COMPOSER_BUTTON_ID) || buildComposerButton();
        if (!bar.contains(button)) {
            bar.appendChild(button);
        }

        if (bar.parentElement !== sendForm) {
            sendForm.prepend(bar);
        }

        return true;
    }

    function placeChatButton() {
        const leftSendForm = doc.getElementById('leftSendForm');
        if (!leftSendForm) return false;

        const button = doc.getElementById(CHAT_BUTTON_ID) || buildChatButton();
        if (!leftSendForm.contains(button)) {
            leftSendForm.appendChild(button);
        }

        return true;
    }

    function tryInstallButtons() {
        let attempts = 0;
        let menuPlaced = false;
        let composerPlaced = false;
        let chatPlaced = false;
        let timer = null;

        const tick = () => {
            attempts += 1;
            menuPlaced = placeMenuButton() || menuPlaced;
            composerPlaced = placeComposerButton() || composerPlaced;
            chatPlaced = placeChatButton() || chatPlaced;

            if (timer && ((menuPlaced && composerPlaced && chatPlaced) || attempts >= MAX_ATTEMPTS)) {
                clearInterval(timer);
            }
        };

        timer = setInterval(tick, INTERVAL_MS);
        tick();
    }

    setTimeout(tryInstallButtons, 500);
})();
