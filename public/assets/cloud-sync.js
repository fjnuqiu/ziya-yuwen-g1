import { STORAGE_KEY, importState } from './learning-engine.js';
import { APP_ID, initialState, mergeStates, normalizeState, stateDelta, validateSettingsPatch } from './sync-model.js';

export const CLOUD_PREFIX = `${APP_ID}:cloud:v1:`;
const uuid = () => crypto.randomUUID();

/** Per-account cache, immutable per-change outbox, and idempotent server receipts. */
export class ProgressSync {
  constructor({ storage, ownerId, knownIds, fetcher = (...args) => fetch(...args), onState = () => {}, onStatus = () => {}, makeId = uuid, schedule = true, namespace = '', loginMessage = '请用原来的 ChatGPT 账号登录后继续同步。' }) {
    if (!ownerId) throw new Error('请登录后打开字芽。');
    Object.assign(this, { storage, ownerId, knownIds, fetcher, onState, onStatus, makeId, schedule, loginMessage });
    this.abort = new AbortController();
    this.prefix = `${CLOUD_PREFIX}${namespace?encodeURIComponent(namespace)+':':''}${encodeURIComponent(ownerId)}:`;
    this.cacheKey = `${this.prefix}cache`;
    this.outboxPrefix = `${this.prefix}outbox:`;
    this.state = initialState(); this.revision = 0; this.updatedAt = null;
    const cache = this.readCache();
    if (cache) { this.state = cache.state; this.revision = cache.revision; this.updatedAt = cache.updatedAt; }
    const legacy = storage.getItem(STORAGE_KEY);
    const claimedBy = storage.getItem(`${CLOUD_PREFIX}legacy-owner`);
    if (legacy && !claimedBy) {
      const oldState = normalizeState(importState(legacy, knownIds), knownIds);
      // Preserve the original backup; claim it only after its outbox entry is durable.
      this.enqueue(oldState, {}, oldState.settings);
      storage.setItem(`${CLOUD_PREFIX}legacy-owner`, ownerId);
      this.state = mergeStates(this.state, oldState, cache ? {} : oldState.settings, knownIds);
    }
    this.applyPending();
    this.writeCache();
  }
  readCache() {
    const raw = this.storage.getItem(this.cacheKey);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error('本机同步记录需要恢复，请先导出备份。');
    return { ...value, state: normalizeState(value.state, this.knownIds) };
  }
  writeCache() {
    this.storage.setItem(this.cacheKey, JSON.stringify({ state: this.state, revision: this.revision, updatedAt: this.updatedAt }));
  }
  pending() {
    const entries = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(this.outboxPrefix)) {
        const entry = JSON.parse(this.storage.getItem(key));
        if (key !== `${this.outboxPrefix}${entry.requestId}` || entry.app !== APP_ID) throw new Error('待同步记录需要恢复，请先导出备份。');
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
  }
  enqueue(state, settingsPatch, legacySettings) {
    const lastTime = this.pending().at(-1)?.createdAt;
    const createdAt = new Date(Math.max(Date.now(), lastTime ? Date.parse(lastTime) + 1 : 0)).toISOString();
    const entry = { app: APP_ID, requestId: this.makeId(), state, settingsPatch, createdAt, ...(legacySettings ? { legacySettings } : {}) };
    this.storage.setItem(`${this.outboxPrefix}${entry.requestId}`, JSON.stringify(entry));
    return entry;
  }
  applyPending() {
    for (const entry of this.pending()) this.state = mergeStates(this.state, entry.state, { ...(this.revision === 0 ? entry.legacySettings : {}), ...entry.settingsPatch }, this.knownIds);
  }
  commit(next, settingsPatch = {}) {
    if (this.closed) throw new Error('这个账号已退出，请重新登录。');
    const patch = validateSettingsPatch(settingsPatch);
    const merged = mergeStates(this.state, next, patch, this.knownIds);
    const delta = stateDelta(this.state, merged, this.knownIds);
    if (Object.keys(delta.records).length || delta.sessions.length || Object.keys(patch).length) this.enqueue(delta, patch);
    this.state = merged;
    // Once enqueued, a failed cache write cannot discard the durable outbox.
    this.writeCache();
    this.emit('pending');
    this.soon();
    return this.state;
  }
  emit(phase, message = '') {
    if(this.closed)return;
    this.status = { phase, message, pending: this.pending().length, updatedAt: this.updatedAt };
    this.onStatus(this.status);
  }
  soon() {
    if (!this.schedule || this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), 700);
  }
  async request(options = {}) {
    const response = await this.fetcher('/api/progress', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', ...options, signal: AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)]) });
    if(this.closed)throw new Error('账号已退出。');
    if ([0, 401, 403].includes(response.status) || response.type === 'opaqueredirect') throw Object.assign(new Error(this.loginMessage), { login: true });
    if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('登录已过期，请重新登录。'), { login: true });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '同步暂未完成，本机记录会保留。');
    if (data.app !== APP_ID || data.userId !== this.ownerId) throw Object.assign(new Error('登录账号已变化，请重新打开页面。原账号记录已留在本机。'), { login: true });
    if (!Number.isInteger(data.revision) || data.revision < 0) throw new Error('云端记录格式不正确，请稍后重试。');
    data.state = normalizeState(data.state, this.knownIds);
    return data;
  }
  receive(data) {
    if(this.closed)return;
    if (data.revision >= this.revision) {
      this.state = mergeStates(data.state, this.state, {}, this.knownIds);
      this.revision = data.revision; this.updatedAt = data.updatedAt;
    }
    this.applyPending();
    this.writeCache();
    this.onState(this.state);
  }
  async syncNow() {
    if (this.closed) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = this.performSync();
    try { await this.running; }
    finally { this.running = null; if (this.again) { this.again = false; this.soon(); } }
  }
  async performSync() {
    try {
      this.emit('syncing');
      const remote = await this.request();
      this.receive(remote);
      for (const entry of this.pending()) {
        if(this.closed)return;
        // The server checks emptiness atomically, including simultaneous migrations.
        const data = await this.request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: APP_ID, requestId: entry.requestId, state: entry.state, settingsPatch: entry.settingsPatch, ...(entry.legacySettings ? { initialSettings: entry.legacySettings } : {}) }) });
        this.storage.removeItem(`${this.outboxPrefix}${entry.requestId}`);
        this.receive(data);
      }
      const pending = this.pending().length;
      this.emit(pending ? 'pending' : 'synced');
      if (pending) this.soon();
    } catch (error) {
      this.emit(error.login ? 'login' : 'offline', error.message);
    }
  }
  refreshLocal() {
    const cache = this.readCache();
    if (cache) this.receive({ ...cache });
    else { this.applyPending(); this.onState(this.state); }
    this.soon();
  }
  close() { this.closed = true; this.abort.abort(); clearTimeout(this.timer); }
}
