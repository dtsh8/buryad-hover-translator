const GOOGLE_ORIGIN = ["https://translate.googleapis.com/*"];
const DEFAULTS = {
  enabled: true,
  direction: "bua-ru",
  hoverDelay: 300,
  modifier: "none",
  googleFallback: false,
  googleDailyCap: 100,
};
const $ = (id) => document.getElementById(id);
const status = (msg) => {
  $("status").textContent = msg;
  setTimeout(() => ($("status").textContent = ""), 1500);
};

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const [k, v] of Object.entries(s)) {
    const e = $(k);
    if (e.type === "checkbox") e.checked = v;
    else e.value = v;
  }
}

for (const k of Object.keys(DEFAULTS)) {
  $(k).addEventListener("change", async (ev) => {
    const e = ev.target;
    let v = e.type === "checkbox" ? e.checked : e.type === "number" ? Number(e.value) : e.value;
    if (k === "googleFallback" && v) {
      // optional host permission must be requested from a user gesture
      const granted = await chrome.permissions.request({ origins: GOOGLE_ORIGIN });
      if (!granted) {
        e.checked = false;
        return;
      }
    }
    await chrome.storage.sync.set({ [k]: v });
    status("Saved");
  });
}

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearCache" });
  status("Cache cleared");
});

load();
