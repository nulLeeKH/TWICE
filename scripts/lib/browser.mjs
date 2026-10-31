import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Browser {
  pending = new Map(); errors = []; sequence = 0; buffer = ''; stderr = '';
  async start() {
    const chrome = process.env.CHROME ?? path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-152.0.7977.42/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (!fs.existsSync(chrome)) throw new Error('Chrome for Testing을 찾지 못했습니다. CHROME 환경 변수에 실행 파일을 지정해 주세요.');
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'twice-browser-'));
    this.process = spawn(chrome, [ ...(process.env.HEADED ? [] : ['--headless=new']), `--user-data-dir=${this.profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1200,1000', 'about:blank' ], { stdio: ['ignore','ignore','pipe','pipe','pipe'] });
    this.process.stdio[2].on('data', data => { this.stderr += data; });
    this.process.on('error', error => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
    this.process.stdio[4].setEncoding('utf8');
    this.process.stdio[4].on('data', data => {
      this.buffer += data;
      for (let at; (at = this.buffer.indexOf('\0')) >= 0; this.buffer = this.buffer.slice(at + 1)) {
        const message = JSON.parse(this.buffer.slice(0, at));
        if (message.method === 'Runtime.exceptionThrown') this.errors.push({ session: message.sessionId, message: message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text });
        const pending = this.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(`${pending.method}: ${message.error.message}`)) : pending.resolve(message.result); }
      }
    });
    await this.call('Browser.getVersion'); return this;
  }
  call(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, 30000);
      this.pending.set(id, { method, timer, resolve, reject });
      this.process.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async open(url = 'about:blank', initialize, newWindow = true) {
    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank', newWindow });
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    const page = { targetId, sessionId };
    await this.call('Runtime.enable', {}, sessionId); await this.call('Page.enable', {}, sessionId);
    if (initialize) await this.call('Page.addScriptToEvaluateOnNewDocument', { source: initialize }, sessionId);
    await this.call('Page.navigate', { url }, sessionId); return page;
  }
  async evaluate(page, expression, userGesture = false) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, page.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(page, expression, label, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await this.evaluate(page, expression).catch(() => null);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timeout: ${label}`);
  }
  async screenshot(page, file, width = 390, height = 1100) {
    await this.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await sleep(100);
    const shot = await this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
  async close(page) { await this.call('Target.closeTarget', { targetId: page.targetId }).catch(() => {}); }
  async dispose() {
    this.process?.kill(); for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('browser closed')); } this.pending.clear();
    await sleep(200); if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true });
  }
}
