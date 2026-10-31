import { describe, expect, it, vi } from "vitest";
import { I18n, browserLanguage, translate } from "../src/ui/i18n";
import { messages } from "../src/ui/messages";
const preferences = (uiLanguage?: unknown) => ({ get: vi.fn(async () => ({ uiLanguage })), set: vi.fn(async (_: Record<string, unknown>) => {}) });
describe("Korean and English presentation", () => {
  it("uses browser language only when a valid preference is absent", async () => {
    expect(browserLanguage("ko-KR")).toBe("ko"); expect(browserLanguage("en-GB")).toBe("en"); expect(browserLanguage("fr-FR")).toBe("en");
    const language = new I18n(); await language.load(preferences("ja"), "en-US"); expect(language.language).toBe("en");
    await language.load(preferences("en"), "ko-KR"); expect(language.language).toBe("en");
    await language.load(preferences("ko"), "en-US"); expect(language.language).toBe("ko");
  });
  it("keeps functioning when preference storage is unavailable", async () => {
    const store = preferences(); store.get.mockRejectedValue(new Error("offline"));
    const language = new I18n(); await language.load(store, "en-US"); expect(language.language).toBe("en");
  });
  it("switches immediately and stores only the interface preference", async () => {
    const store = preferences("ko"), language = new I18n(); await language.load(store, "ko-KR");
    const changed = vi.fn(); language.subscribe(changed); const saved = language.setLanguage("en");
    expect(language.language).toBe("en"); expect(changed).toHaveBeenCalledOnce(); await saved;
    expect(store.set).toHaveBeenCalledExactlyOnceWith({ uiLanguage: "en" });
    const reopened = new I18n(); await reopened.load(preferences("en"), "ko-KR"); expect(reopened.language).toBe("en");
  });
  it("preserves the chosen presentation after a failed save and allows retry", async () => {
    const store = preferences(), language = new I18n(); await language.load(store, "ko-KR");
    store.set.mockRejectedValueOnce(new Error("denied")); await expect(language.setLanguage("en")).rejects.toThrow("denied");
    expect(language.language).toBe("en"); await language.setLanguage("ko"); expect(store.set).toHaveBeenLastCalledWith({ uiLanguage: "ko" });
  });
  it("localizes existing states and nested dynamic failures at render time", () => {
    expect(translate("Gemini Nano 사용 불가", "en")).toBe("Gemini Nano unavailable");
    expect(translate("스크롤 · 120–900", "en")).toBe("Scroll · 120–900");
    expect(translate("판단 완료 · 현재 3 + 누적 8문단", "en")).toBe("Decision complete · 3 current + 8 queued paragraphs");
    expect(translate("AI 오류: 모델 준비 실패 마지막 소리는 유지합니다.", "en")).toBe("AI error: Model setup failed Keeping previous sound.");
    expect(translate("보류 · 최소 8초 간격", "en")).toBe("Held · Min 8s gap");
  });
  it("keeps Korean source copy and unknown external errors intact", () => {
    expect(translate("준비", "ko")).toBe("준비");
    expect(translate("NetworkError: unavailable", "en")).toBe("NetworkError: unavailable");
    expect(translate("constructor", "en")).toBe("constructor");
  });
  it("has complete English copy for every catalogue entry and template", () => {
    for (const source of Object.keys(messages)) {
      const concrete = source.replace(/\{\w+\}/g, "12");
      expect(translate(concrete, "en"), source).not.toMatch(/[가-힣]/);
    }
  });
});
