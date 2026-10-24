const DEFAULTS = { endpoint: "https://proteocast.ijm.fr/data/api/{fbpp}.json" };
const $ = (id) => document.getElementById(id);
// Same rule as background.js: predictions end up in FlyBase's page, so only accept an encrypted endpoint
// (plain http only for a local test server).
const allowed = (u) => /^https:\/\/[^/]+\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u);
chrome.storage.sync.get(DEFAULTS, (s) => { $("endpoint").value = s.endpoint; });
chrome.storage.sync.remove("demo"); // setting from versions before 0.3.0
$("save").addEventListener("click", () => {
  const endpoint = $("endpoint").value.trim() || DEFAULTS.endpoint;
  if (!allowed(endpoint) || !endpoint.includes("{fbpp}")) {
    $("status").style.color = "#b30000";
    $("status").textContent = "Use an https:// address containing {fbpp}.";
    return;
  }
  chrome.storage.sync.set({ endpoint }, () => {
    $("status").style.color = "";
    $("status").textContent = "Saved — reload the FlyBase page.";
    setTimeout(() => ($("status").textContent = ""), 2500);
  });
});
