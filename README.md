# Preset Quick Notex

SillyTavern third-party extension for quickly editing Prompt Manager entries in the current Chat Completion preset.

## Features

- Exposes `window.openPresetQuickNotex()` for external launch buttons; the extension itself does not create a persistent launcher.
- Includes `tavern-helper-button.js`, a companion Tavern Helper script that adds a lightweight button without DOM observers.
- Binds multiple quick-edit profiles to Chat Completion Prompt Manager entries by `identifier`.
- Saves edits back to the currently selected Chat Completion preset without reloading the page.
- Builds non-empty content as:

```text
<本次内容注意>
[enabled pre-input modules]
[current note]
</本次内容注意>
```

- Saves empty content as an empty prompt entry.

## Install

Install as a SillyTavern third-party extension from:

```text
https://github.com/relax-sketch/preset-quick-notex.git
```

Restart or reload SillyTavern after installing.

## Optional Tavern Helper Button

If the built-in wand-menu entry is not visible on mobile, import `tavern-helper-button.json` into Tavern Helper, or paste the contents of `tavern-helper-button.js` into a script. It adds:

- a wand-menu entry after the character-card manager button when present;
- a compact note icon in the chat input button area.

The helper uses a short retry loop only. It does not use `MutationObserver`.
