import {
  ALARM_NAMES,
  setupAlarms,
  runDailyCheck,
  runContestCheck,
} from './worker.js';
import { syncLeetCodeNetworkRules, syncFocusModeNetworkRules } from '../services/network.js';
import {
  getFocusModeEnabled,
  storageSet,
  STORAGE_KEYS,
} from '../services/storage.js';

/**
 * Handle extension installation or version upgrade while preserving all persisted user data.
 */
export async function handleInstalled(details = {}, customDeps = {}) {
  const syncLeetCode = customDeps.syncLeetCodeNetworkRules || syncLeetCodeNetworkRules;
  const syncFocus = customDeps.syncFocusModeNetworkRules || syncFocusModeNetworkRules;
  const readFocusEnabled = customDeps.getFocusModeEnabled || getFocusModeEnabled;
  const checkDaily = customDeps.runDailyCheck || runDailyCheck;
  const checkContest = customDeps.runContestCheck || runContestCheck;
  const setStorage = customDeps.storageSet || storageSet;

  // Restore focus DNR rules immediately from preserved storage
  const focusEnabled = await readFocusEnabled();
  await syncFocus(Boolean(focusEnabled));

  // Record non-destructive upgrade metadata without altering user settings or caches
  if (details?.reason === 'update') {
    await setStorage(STORAGE_KEYS.EXTENSION_META, {
      previousVersion: details.previousVersion || 'unknown',
      currentVersion: customDeps.currentVersion || '1.0.9',
      updatedAt: Date.now(),
    });
  }

  await syncLeetCode();
  await Promise.all([checkDaily(), checkContest()]);
}

/**
 * Register background service worker listeners across Chrome, Edge, and Firefox MV3.
 */
export function registerBackgroundListeners(customApis = {}, customDeps = {}) {
  const chromeGlobal = typeof chrome !== 'undefined' ? chrome : null;
  const browserGlobal = typeof browser !== 'undefined' ? browser : null;
  const ext = chromeGlobal || browserGlobal;

  const alarms = customApis.alarms ?? ext?.alarms ?? null;
  const runtime = customApis.runtime ?? ext?.runtime ?? null;
  const notifications = customApis.notifications ?? ext?.notifications ?? null;
  const tabs = customApis.tabs ?? ext?.tabs ?? null;
  const cookies = customApis.cookies ?? ext?.cookies ?? null;
  const storage = customApis.storage ?? ext?.storage ?? null;

  const syncLeetCode = customDeps.syncLeetCodeNetworkRules || syncLeetCodeNetworkRules;
  const syncFocus = customDeps.syncFocusModeNetworkRules || syncFocusModeNetworkRules;
  const readFocusEnabled = customDeps.getFocusModeEnabled || getFocusModeEnabled;
  const checkDaily = customDeps.runDailyCheck || runDailyCheck;
  const checkContest = customDeps.runContestCheck || runContestCheck;
  const initAlarms = customDeps.setupAlarms || setupAlarms;

  // Initialize network header modification and focus mode rules on worker startup
  syncLeetCode();
  Promise.resolve(readFocusEnabled()).then((enabled) => syncFocus(Boolean(enabled)));

  // Keep Focus Mode DNR rules in sync whenever toggled in storage
  if (storage?.onChanged) {
    storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEYS.FOCUS_MODE]) {
        syncFocus(Boolean(changes[STORAGE_KEYS.FOCUS_MODE].newValue));
      }
    });
  }

  // Only re-sync DNR rules when LeetCode session/CSRF cookies change (debounced, no loops)
  let cookieSyncTimer = null;
  if (cookies?.onChanged) {
    cookies.onChanged.addListener((changeInfo) => {
      const cookie = changeInfo?.cookie;
      if (!cookie || !cookie.domain || !cookie.domain.includes('leetcode.com')) return;
      if (cookie.name !== 'LEETCODE_SESSION' && cookie.name !== 'csrftoken') return;

      if (cookieSyncTimer) clearTimeout(cookieSyncTimer);
      cookieSyncTimer = setTimeout(() => {
        syncLeetCode();
        if (cookie.name === 'LEETCODE_SESSION' && changeInfo.cause === 'explicit') {
          checkDaily();
        }
      }, 2000);
    });
  }

  // Run initial check and preserve data cleanly on install/update
  if (runtime?.onInstalled) {
    runtime.onInstalled.addListener((details) => {
      const manifestVersion = runtime.getManifest?.()?.version || '1.0.9';
      handleInstalled(details, {
        ...customDeps,
        currentVersion: manifestVersion,
      });
    });
  }

  // Initialize periodic alarms
  if (alarms) {
    initAlarms(alarms);

    if (alarms.onAlarm) {
      alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAMES.DAILY_CHECK) {
          Promise.resolve(syncLeetCode()).then(() => checkDaily());
        } else if (alarm.name === ALARM_NAMES.CONTEST_CHECK) {
          checkContest();
        }
      });
    }
  }

  // Handle contest notification clicks
  if (notifications?.onClicked && tabs?.create) {
    notifications.onClicked.addListener((notificationId) => {
      if (notificationId.startsWith('contest_')) {
        const slug = notificationId.replace('contest_', '');
        tabs.create({ url: `https://leetcode.com/contest/${slug}` });
      } else {
        tabs.create({ url: 'https://leetcode.com' });
      }
    });
  }

  // Handle manual refresh requests from popup UI
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'REFRESH_DATA') {
        Promise.resolve(syncLeetCode())
          .then(() => Promise.all([checkDaily(), checkContest()]))
          .then(([dailyData, contests]) => {
            sendResponse({ success: true, dailyData, contests });
          })
          .catch((err) => {
            console.error('Refresh error:', err);
            sendResponse({ success: false, error: err?.message || 'Refresh failed' });
          });
        return true;
      }
    });
  }
}
