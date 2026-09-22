// CommonJS on purpose: a sandboxed preload cannot be an ES module, and the
// sandbox is worth more than the syntax. Not compiled by tsc either - there is
// nothing here to typecheck beyond the bridge itself.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  searchNames: (kind, query) => ipcRenderer.invoke("names:search", { kind, query }),
  nameOf: (kind, id) => ipcRenderer.invoke("names:of", { kind, id }),
  checkHealth: () => ipcRenderer.invoke("health:check"),
  listSounds: () => ipcRenderer.invoke("sound:list"),
  addSound: () => ipcRenderer.invoke("sound:add"),
  soundData: (file) => ipcRenderer.invoke("sound:data", file),
  testRule: (ruleId) => ipcRenderer.invoke("rule:test", ruleId),
  setOwn: (name, own) => ipcRenderer.invoke("own:set", { name, own }),
  mergeRules: (into, sources, mode) => ipcRenderer.invoke("rules:merge", { into, sources, mode }),

  onFightUpdate: on("fight:update"),
  onFightEvent: on("fight:event"),
  onAlertSound: on("alert:sound"),
  onAlertLog: on("alert:log"),
  onOverlayShow: on("overlay:show"),
});
