import { browser } from "wxt/browser";
import { i18n, isUiLanguage, t } from "./ui/i18n";
import { listModels, NanoClient } from "./model/nano";
import { ReaderRuntime } from "./session/runtime";
import { AppView } from "./ui/view";

async function start() {
  await i18n.load(browser.storage.local, navigator.language);
  const model = new NanoClient();
  const runtime = new ReaderRuntime(model);
  const view = new AppView(model, runtime);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const listeners = new AbortController();
  function click(id: string, fn: () => void | Promise<void>, report = (message: string) => { runtime.state.message = message; view.schedule(); }) {
    $(id).addEventListener("click", () => { Promise.resolve(fn()).catch(error => report(error instanceof Error ? error.message : String(error))); }, { signal: listeners.signal });
  }
  // Model settings report next to their own fields.
  const note = (message: string) => { $("model-note").textContent = t(message); };
  $("ui-language").addEventListener("change", event => {
    const language = (event.target as HTMLSelectElement).value;
    if (isUiLanguage(language)) void i18n.setLanguage(language).catch(() => {
      runtime.state.message = "언어 설정 저장 실패"; view.schedule();
    });
  }, { signal: listeners.signal });
  // Analysis model: on-device Nano by default, or an OpenAI-compatible API connected here. Choices apply at once.
  type SavedModel = { provider: "nano" | "openai"; baseURL: string; apiKey: string; model: string };
  const field = (id: string) => $<HTMLInputElement>(id);
  let saved: SavedModel = { provider: "nano", baseURL: "", apiKey: "", model: "" };
  const form = (provider: SavedModel["provider"]): SavedModel => ({ provider, baseURL: field("external-url").value.trim(), apiKey: field("external-key").value.trim(), model: field("external-model").value.trim() });
  const originOf = (baseURL: string) => {
    try { const url = new URL(baseURL); if (/^https?:$/.test(url.protocol)) return url.origin; } catch { /* reported below */ }
    throw new Error("Base URL을 확인해 주세요.");
  };
  const fillModels = (ids: string[]) => $("external-models").replaceChildren(...ids.map(id => Object.assign(document.createElement("option"), { value: id })));
  const showProvider = (provider: SavedModel["provider"]) => {
    $("use-nano").setAttribute("aria-checked", String(provider === "nano"));
    $("use-external").setAttribute("aria-checked", String(provider === "openai"));
    $("external-fields").hidden = provider !== "openai";
    document.body.dataset.provider = provider; // hides the Nano setup card while the API tab is chosen
  };
  const describe = (config: SavedModel) => config.provider === "openai" ? `연결됨 · ${new URL(config.baseURL).host} · ${config.model}` : "온디바이스 AI 사용";
  async function apply(next: SavedModel) {
    saved = next; showProvider(next.provider);
    model.setExternal(next.provider === "openai" ? next : null);
    note(describe(next));
    await browser.storage.local.set({ model: next }).catch(() => note("모델 설정 저장 실패"));
  }
  try {
    const stored = (await browser.storage.local.get("model")).model as Partial<SavedModel> | undefined;
    if (stored) saved = { ...saved, ...stored };
  } catch { /* Nano stays in use. */ }
  field("external-url").value = saved.baseURL; field("external-key").value = saved.apiKey; field("external-model").value = saved.model;
  if (saved.model) fillModels([saved.model]);
  showProvider(saved.provider);
  if (saved.provider === "openai" && saved.baseURL && saved.model) { model.setExternal(saved); note(describe(saved)); }
  click("use-nano", () => apply(form("nano")), note);
  click("use-external", async () => {
    showProvider("openai");
    const next = form("openai");
    if (next.baseURL && next.model && await browser.permissions.contains({ origins: [`${originOf(next.baseURL)}/*`] })) return apply(next);
    note("Base URL과 API 키를 입력하고 연결해 주세요.");
    field(next.baseURL ? "external-key" : "external-url").focus();
  }, note);
  click("connect-api", async () => {
    const next = form("openai");
    // Requested first, inside the click, so Chrome shows the prompt.
    if (!(await browser.permissions.request({ origins: [`${originOf(next.baseURL)}/*`] }))) throw new Error("API 서버 접근 권한이 필요합니다.");
    note("모델 목록을 불러오는 중…");
    try {
      const ids = await listModels(next);
      fillModels(ids);
      if (!next.model) next.model = ids[0]!;
    } catch (error) {
      // Some servers have no /models: a typed model name still works.
      if (!next.model) throw new Error(`${error instanceof Error ? error.message : String(error)} · 모델 이름을 직접 입력해 주세요.`);
    }
    field("external-model").value = next.model;
    await apply(next);
  }, note);
  field("external-model").addEventListener("change", () => {
    if (saved.provider === "openai" && saved.baseURL && field("external-model").value.trim()) void apply(form("openai"));
  }, { signal: listeners.signal });
  const openExternal = () => {
    view.toggleSettings(true); showProvider("openai"); view.schedule();
    field(field("external-url").value ? "external-key" : "external-url").focus();
  };
  click("switch-external", openExternal);
  click("alert-settings", openExternal);
  click("alert-retry", () => runtime.retry());
  click("start", () => {
    // One button: start, pause, resume; after leaving the tab it restarts on the current page.
    if (runtime.connected && !runtime.state.away) {
      runtime.togglePause();
      return;
    }
    return runtime.connect();
  });
  click("gear", () => { view.toggleSettings(); view.schedule(); });
  click("close-settings", () => { view.toggleSettings(false); view.schedule(); });
  click("recheck-model", () => model.inspect().then(() => {}));
  click("prepare-model", () => model.prepare());
  click("cancel-model", () => model.cancelPreparation());
  click("stop", () => runtime.stop());
  click("copy-device", async () => {
    try { await navigator.clipboard.writeText("chrome://on-device-internals"); $("copy-device").textContent = t("복사됨"); }
    catch { $("copy-device").textContent = t("복사 실패"); }
  });
  click("copy-debug", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify({ model: model.state, ...runtime.diagnostics() }, null, 2)); $("copy-debug").textContent = t("복사됨"); }
    catch { $("copy-debug").textContent = t("복사 실패"); }
  });
  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-bus]")) slider.addEventListener("input", () => runtime.setVolume(slider.dataset.bus as "music" | "ambience" | "sfx" | "master", Number(slider.value) / 100), { signal: listeners.signal });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mute]")) button.addEventListener("click", event => { event.preventDefault(); runtime.toggleMute(button.dataset.mute as "music" | "ambience" | "sfx" | "master"); }, { signal: listeners.signal });
  $("debug").addEventListener("toggle", () => view.renderDebug(), { signal: listeners.signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { view.toggleSettings(false); view.schedule(); } }, { signal: listeners.signal });
  document.querySelector(".brand")?.addEventListener("click", event => { event.preventDefault(); view.toggleSettings(false); view.schedule(); }, { signal: listeners.signal });
  void runtime.loadPreferences();
  if (!model.ready) void model.inspect();
  const dispose = () => { listeners.abort(); view.dispose(); void runtime.dispose(); };
  window.addEventListener("pagehide", dispose, { once: true });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
void start();
