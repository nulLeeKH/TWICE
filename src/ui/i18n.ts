import { messages } from "./messages";
export type UiLanguage = "ko" | "en";
interface Preferences {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<unknown>;
}
export const isUiLanguage = (value: unknown): value is UiLanguage => value === "ko" || value === "en";
export function browserLanguage(language: string): UiLanguage { return /^ko(?:-|$)/i.test(language) ? "ko" : "en"; }

// Only catalogue templates are matched. Platform errors outside our copy stay intact.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = Object.entries(messages).filter(([source]) => source.includes("{")).map(([source, target]) => {
  const parts = source.split(/(\{\w+\})/);
  const keys = parts.filter(part => /^\{\w+\}$/.test(part)).map(part => part.slice(1, -1));
  const pattern = new RegExp("^" + parts.map(part => /^\{\w+\}$/.test(part) ? "([\\s\\S]+?)" : escape(part)).join("") + "$");
  return { pattern, target, keys, weight: source.replace(/\{\w+\}/g, "").length };
}).sort((a, b) => b.weight - a.weight);
export function translate(source: string, language: UiLanguage, depth = 0): string {
  if (language === "ko" || !source || depth > 8) return source;
  if (Object.hasOwn(messages, source)) return messages[source]!;
  for (const { pattern, target, keys } of templates) {
    const match = pattern.exec(source);
    if (!match) continue;
    const values = Object.fromEntries(keys.map((key, index) => [key, translate(match[index + 1]!, language, depth + 1)]));
    return target.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
  }
  // Composed labels (position, action, guards) retain their machine values.
  for (const separator of [" · ", " + "]) if (source.includes(separator)) return source.split(separator).map(part => translate(part, language, depth + 1)).join(separator);
  return source;
}

/** Language is a presentation preference. It never owns or resets a reader/model/audio session. */
export class I18n {
  language: UiLanguage = "ko";
  private storage?: Preferences;
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async load(storage: Preferences, browserLocale: string) {
    this.storage = storage;
    let preferred: unknown;
    try { preferred = (await storage.get("uiLanguage")).uiLanguage; } catch { /* Browser locale still works when storage is unavailable. */ }
    this.update(isUiLanguage(preferred) ? preferred : browserLanguage(browserLocale));
  }
  private update(language: UiLanguage) {
    if (this.language === language) return;
    this.language = language; this.listeners.forEach(listener => listener());
  }
  setLanguage(language: UiLanguage): Promise<unknown> {
    this.update(language);
    this.writes = this.writes.catch(() => {}).then(() => this.storage?.set({ uiLanguage: language }));
    return this.writes;
  }
}
export const i18n = new I18n();
export const t = (source: string) => translate(source, i18n.language);

/** Bind only the initial UI markup. Dynamic copy is translated explicitly by AppView. */
export function bindStaticCopy(root: HTMLElement): () => void {
  const bindings: (() => void)[] = [];
  const elements = new Set<Element>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text, parent = text.parentElement;
    if (!parent || parent.closest("script,style,pre,code,option") || !/[가-힣]/.test(text.data)) continue;
    const original = text.data;
    if (!parent.childElementCount) {
      if (elements.has(parent)) continue;
      elements.add(parent);
      const source = parent.textContent ?? "";
      bindings.push(() => { if (parent.isConnected) parent.textContent = t(source); });
    } else bindings.push(() => { if (text.isConnected) text.data = t(original.trim()) === original.trim() ? original : original.replace(original.trim(), t(original.trim())); });
  }
  for (const element of root.querySelectorAll("[aria-label],[title],[placeholder]")) for (const attribute of ["aria-label", "title", "placeholder"]) {
    const source = element.getAttribute(attribute);
    if (source && /[가-힣]/.test(source)) bindings.push(() => element.setAttribute(attribute, t(source)));
  }
  return () => {
    document.documentElement.lang = i18n.language;
    document.title = "TWICE";
    bindings.forEach(apply => apply());
    document.documentElement.removeAttribute("data-ui-loading");
  };
}
