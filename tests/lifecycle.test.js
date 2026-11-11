import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleInstalled,
  registerBackgroundListeners,
} from '../src/background/lifecycle.js';
import { ALARM_NAMES, runDailyCheck } from '../src/background/worker.js';
import { STORAGE_KEYS, storageGet } from '../src/services/storage.js';

function createPersistentChromeStorage(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    store,
    local: {
      get: (keys, cb) => {
        const result = {};
        for (const k of keys) {
          if (store.has(k)) result[k] = store.get(k);
        }
        cb(result);
      },
      set: (obj, cb) => {
        for (const [k, v] of Object.entries(obj)) {
          store.set(k, v);
        }
        if (cb) cb();
      },
    },
  };
}

function createListenerRegistry() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
    listeners,
  };
}

describe('Background Workflows (registerBackgroundListeners)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.chrome;
  });

  it('initializes DNR rules on startup and reacts to Focus Mode storage changes', async () => {
    const syncLeetCode = vi.fn().mockResolvedValue({ ok: true });
    const syncFocus = vi.fn().mockResolvedValue({ ok: true });
    const storageChanged = createListenerRegistry();

    registerBackgroundListeners(
      {
        storage: { onChanged: storageChanged },
      },
      {
        syncLeetCodeNetworkRules: syncLeetCode,
        syncFocusModeNetworkRules: syncFocus,
        getFocusModeEnabled: async () => true,
      }
    );

    await vi.runAllTicks();
    expect(syncLeetCode).toHaveBeenCalledTimes(1);
    expect(syncFocus).toHaveBeenCalledWith(true);

    // Unrelated area or key does not trigger sync
    await storageChanged.emit({ [STORAGE_KEYS.FOCUS_MODE]: { newValue: false } }, 'sync');
    await storageChanged.emit({ other_key: { newValue: true } }, 'local');
    expect(syncFocus).toHaveBeenCalledTimes(1);

    // Local FOCUS_MODE change triggers DNR rule update
    await storageChanged.emit({ [STORAGE_KEYS.FOCUS_MODE]: { newValue: false } }, 'local');
    expect(syncFocus).toHaveBeenCalledWith(false);
  });

  it('debounces leetcode cookie updates and triggers daily check only on explicit LEETCODE_SESSION change', async () => {
    const syncLeetCode = vi.fn().mockResolvedValue({ ok: true });
    const checkDaily = vi.fn().mockResolvedValue({});
    const cookiesChanged = createListenerRegistry();

    registerBackgroundListeners(
      {
        cookies: { onChanged: cookiesChanged },
      },
      {
        syncLeetCodeNetworkRules: syncLeetCode,
        syncFocusModeNetworkRules: vi.fn().mockResolvedValue({ ok: true }),
        getFocusModeEnabled: async () => false,
        runDailyCheck: checkDaily,
      }
    );

    syncLeetCode.mockClear();

    // Non-LeetCode cookies are ignored completely
    await cookiesChanged.emit({
      cause: 'explicit',
      cookie: { domain: '.youtube.com', name: 'LEETCODE_SESSION', value: 'x' },
    });
    vi.advanceTimersByTime(3000);
    expect(syncLeetCode).not.toHaveBeenCalled();

    // Multiple rapid csrftoken + session events debounce into a single sync + explicit daily check
    await cookiesChanged.emit({
      cause: 'overwrite',
      cookie: { domain: '.leetcode.com', name: 'csrftoken', value: 'csrf_1' },
    });
    await cookiesChanged.emit({
      cause: 'explicit',
      cookie: { domain: '.leetcode.com', name: 'LEETCODE_SESSION', value: 'sess_1' },
    });

    vi.advanceTimersByTime(1999);
    expect(syncLeetCode).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(syncLeetCode).toHaveBeenCalledTimes(1);
    expect(checkDaily).toHaveBeenCalledTimes(1);
  });

  it('routes alarms, notification clicks, and REFRESH_DATA messages correctly', async () => {
    const syncLeetCode = vi.fn().mockResolvedValue({ ok: true });
    const checkDaily = vi.fn().mockResolvedValue({ user: { username: 'dev' } });
    const checkContest = vi.fn().mockResolvedValue([{ title: 'Weekly Contest 480' }]);
    const alarmsOnAlarm = createListenerRegistry();
    const notificationsOnClicked = createListenerRegistry();
    const runtimeOnMessage = createListenerRegistry();
    const tabsCreate = vi.fn();
    const setupAlarmsMock = vi.fn();

    registerBackgroundListeners(
      {
        alarms: { onAlarm: alarmsOnAlarm },
        notifications: { onClicked: notificationsOnClicked },
        tabs: { create: tabsCreate },
        runtime: { onMessage: runtimeOnMessage },
      },
      {
        setupAlarms: setupAlarmsMock,
        syncLeetCodeNetworkRules: syncLeetCode,
        syncFocusModeNetworkRules: vi.fn().mockResolvedValue({ ok: true }),
        getFocusModeEnabled: async () => false,
        runDailyCheck: checkDaily,
        runContestCheck: checkContest,
      }
    );

    expect(setupAlarmsMock).toHaveBeenCalledTimes(1);

    // Daily alarm syncs rules before daily check
    await alarmsOnAlarm.emit({ name: ALARM_NAMES.DAILY_CHECK });
    await Promise.resolve();
    expect(checkDaily).toHaveBeenCalledTimes(1);

    // Contest alarm runs contest check
    await alarmsOnAlarm.emit({ name: ALARM_NAMES.CONTEST_CHECK });
    expect(checkContest).toHaveBeenCalledTimes(1);

    // Notification clicks open contest page or home fallback
    await notificationsOnClicked.emit('contest_weekly-contest-480');
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://leetcode.com/contest/weekly-contest-480' });

    await notificationsOnClicked.emit('general_alert');
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://leetcode.com' });

    // REFRESH_DATA runtime message returns async success payload
    const sendResponse = vi.fn();
    const keepChannelOpen = runtimeOnMessage.listeners[0]({ type: 'REFRESH_DATA' }, {}, sendResponse);
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        dailyData: { user: { username: 'dev' } },
        contests: [{ title: 'Weekly Contest 480' }],
      });
    });
  });
});

describe('Upgrade Data Preservation (v1.0.8 -> v1.0.9)', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('preserves all v1.0.8 stored preferences, caches, coins, and focus lock across upgrade', async () => {
    const preUpgradeData = {
      [STORAGE_KEYS.FOCUS_MODE]: true,
      [STORAGE_KEYS.SOLVE_BEFORE_SCROLL]: true,
      [STORAGE_KEYS.AUTO_FOCUS_LOCKED]: true,
      [STORAGE_KEYS.LAST_COIN_CLAIM]: '2026-11-11',
      [STORAGE_KEYS.NOTIFIED_CONTESTS]: { 'weekly-contest-450': 1794400000000 },
      [STORAGE_KEYS.CACHED_USER]: {
        isSignedIn: true,
        username: 'The-Boss',
        points: 1894,
        currentStreak: 4,
      },
      [STORAGE_KEYS.CACHED_DAILY]: {
        date: '2026-11-11',
        title: 'Two Sum',
        isSolved: false,
      },
    };

    const persistentStorage = createPersistentChromeStorage(preUpgradeData);
    globalThis.chrome = {
      storage: { local: persistentStorage.local },
      runtime: { lastError: null, getManifest: () => ({ version: '1.0.9' }) },
    };

    const syncLeetCode = vi.fn().mockResolvedValue({ ok: true });
    const syncFocus = vi.fn().mockResolvedValue({ ok: true });

    // Even if LeetCode API fails right after upgrade (e.g. offline), cached state & prefs must survive
    await handleInstalled(
      { reason: 'update', previousVersion: '1.0.8' },
      {
        currentVersion: '1.0.9',
        syncLeetCodeNetworkRules: syncLeetCode,
        syncFocusModeNetworkRules: syncFocus,
        runDailyCheck: () =>
          runDailyCheck({
            fetchDailyChallenge: vi.fn().mockRejectedValue(new Error('Offline during update')),
            fetchUserStatus: vi.fn().mockRejectedValue(new Error('Offline during update')),
            updateBadge: vi.fn().mockResolvedValue(undefined),
            syncFocusRules: syncFocus,
          }),
        runContestCheck: vi.fn().mockResolvedValue([]),
      }
    );

    // Every single pre-existing v1.0.8 key must remain intact
    expect(await storageGet(STORAGE_KEYS.FOCUS_MODE)).toBe(true);
    expect(await storageGet(STORAGE_KEYS.SOLVE_BEFORE_SCROLL)).toBe(true);
    expect(await storageGet(STORAGE_KEYS.AUTO_FOCUS_LOCKED)).toBe(true);
    expect(await storageGet(STORAGE_KEYS.LAST_COIN_CLAIM)).toBe('2026-11-11');
    expect(await storageGet(STORAGE_KEYS.NOTIFIED_CONTESTS)).toEqual({
      'weekly-contest-450': 1794400000000,
    });
    expect(await storageGet(STORAGE_KEYS.CACHED_DAILY)).toEqual(preUpgradeData[STORAGE_KEYS.CACHED_DAILY]);

    const upgradedUser = await storageGet(STORAGE_KEYS.CACHED_USER);
    expect(upgradedUser.username).toBe('The-Boss');
    expect(upgradedUser.currentStreak).toBe(4);
    expect(upgradedUser.points).toBe(1894);

    // Focus rules re-synced immediately on update
    expect(syncFocus).toHaveBeenCalledWith(true);

    // Non-destructive upgrade metadata recorded
    const meta = await storageGet(STORAGE_KEYS.EXTENSION_META);
    expect(meta.previousVersion).toBe('1.0.8');
    expect(meta.currentVersion).toBe('1.0.9');
  });
});
