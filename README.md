# Buryad Hover Translator

Chrome extension (Manifest V3) that translates Buryad words and phrases in a tooltip when you hover over them or select them.

## How it works

Lookups go through these layers, cheapest first:

1. **Cache**: in-memory plus `chrome.storage.local`. Hits last 30 days, misses 3 days, capped at 5,000 entries. Concurrent identical requests are merged.
2. **[burlang.ru API](https://burlang.ru/api/v1)** (free, dictionary-based): `buryat-word/translate` and `russian-word/translate`. If an exact form is missing, up to 4 shorter stems are tried, because Buryad is agglutinative. The tooltip marks a stem match with `≈`.
3. **Google Translate** (opt-in, off by default): used only for multi-word phrases where the dictionary missed at least one word. It is throttled to 1 call/s, has a configurable daily cap (default 100), is cached, and backs off for an hour on a 429 or CAPTCHA. Selected text is sent to Google only when you enable this.

Phrases are tried whole first (idioms), then word by word.

## Usage

- **Hover** over a Cyrillic word to see its translation.
- **Select** a word or phrase (up to 200 characters) to translate it.
- `Esc` hides the tooltip. Clicking the toolbar icon toggles the extension. Right-click the icon → *Options* for direction, modifier key, delay, and Google settings.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.

## Layout

```
manifest.json
src/background.js   cache, burlang + Google lookups
src/content.js      hover/selection detection, tooltip (Shadow DOM)
options/            settings page
icons/
```

Dictionary data comes from [burlang.ru](https://burlang.ru). Please be considerate with request volume; the cache exists for that reason.
