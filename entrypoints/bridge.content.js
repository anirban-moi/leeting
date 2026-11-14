import { defineContentScript } from 'wxt/sandbox';

export default defineContentScript({
  matches: [
    'http://localhost:3000/*',
    'http://localhost:3001/*',
    'http://127.0.0.1:3000/*',
    'https://*.leeting.dev/*',
    'https://*.vercel.app/*',
  ],
  runAt: 'document_start',
  main() {
    console.log('[Leeting Extension Bridge] Content script initialized on web companion.');

    // Helper to detect current browser
    const getBrowserName = () => {
      const ua = navigator.userAgent;
      if (/Edg/.test(ua)) return 'Edge';
      if (/Firefox/.test(ua)) return 'Firefox';
      if (/Chrome/.test(ua)) return 'Chrome';
      return 'Browser';
    };

    const browser = getBrowserName();
    const version = '1.0.9';

    // Synchronously tag documentElement so web app can immediately verify extension
    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.leetingExtension = version;
        document.documentElement.dataset.leetingBrowser = browser;
      }
    } catch {}

    // Announce extension presence to the web dashboard
    const announcePresence = () => {
      window.postMessage(
        {
          source: 'LEETING_EXTENSION_BRIDGE',
          type: 'ANNOUNCE_PRESENCE',
          version,
          browser,
          timestamp: Date.now(),
        },
        '*'
      );
    };

    // Announce immediately and periodically
    announcePresence();
    const intervalId = setInterval(announcePresence, 2000);

    // Broadcast storage updates in real-time to the web dashboard
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const payload = {};
        if (changes.leeting_focus_mode_enabled !== undefined) {
          payload.focusMode = Boolean(changes.leeting_focus_mode_enabled.newValue);
        }
        if (changes.leeting_solve_before_scroll_enabled !== undefined) {
          payload.solveBeforeScroll = Boolean(changes.leeting_solve_before_scroll_enabled.newValue);
        }
        if (changes.leeting_cached_daily !== undefined) {
          payload.daily = changes.leeting_cached_daily.newValue;
        }
        if (changes.leeting_cached_contests !== undefined) {
          payload.contests = changes.leeting_cached_contests.newValue;
        }
        if (changes.leeting_cached_user !== undefined) {
          payload.user = changes.leeting_cached_user.newValue;
        }
        if (changes.leeting_active_timer !== undefined) {
          payload.activeTimer = changes.leeting_active_timer.newValue;
        }

        if (Object.keys(payload).length > 0) {
          window.postMessage(
            {
              source: 'LEETING_EXTENSION_BRIDGE',
              type: 'STATE_CHANGED',
              payload,
            },
            '*'
          );
        }
      });
    }

    // Listen to direct broadcast messages from the extension popup or background worker
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'LEETING_STATE_UPDATE' && message.payload) {
          window.postMessage(
            {
              source: 'LEETING_EXTENSION_BRIDGE',
              type: 'STATE_CHANGED',
              payload: message.payload,
            },
            '*'
          );
        } else if (message?.type === 'FOCUS_MODE_CHANGED') {
          window.postMessage(
            {
              source: 'LEETING_EXTENSION_BRIDGE',
              type: 'STATE_CHANGED',
              payload: { focusMode: Boolean(message.enabled) },
            },
            '*'
          );
        } else if (message?.type === 'TIMER_STATE_CHANGED') {
          window.postMessage(
            {
              source: 'LEETING_EXTENSION_BRIDGE',
              type: 'STATE_CHANGED',
              payload: { activeTimer: message.timer },
            },
            '*'
          );
        }
      });
    }

    // Relay commands from Web App -> Extension Background Service Worker
    window.addEventListener('message', async (event) => {
      if (!event.data || event.data.source !== 'LEETING_WEB_APP') {
        return;
      }

      const { type, payload, requestId } = event.data;

      if (type === 'PING_PRESENCE') {
        announcePresence();
        return;
      }

      try {
        const response = await chrome.runtime.sendMessage({
          source: 'LEETING_WEB_BRIDGE',
          type,
          payload,
        });

        window.postMessage(
          {
            source: 'LEETING_EXTENSION_BRIDGE',
            type: `${type}_REPLY`,
            requestId,
            success: true,
            data: response,
          },
          '*'
        );
      } catch (err) {
        window.postMessage(
          {
            source: 'LEETING_EXTENSION_BRIDGE',
            type: `${type}_REPLY`,
            requestId,
            success: false,
            error: err?.message || 'Extension background unreachable',
          },
          '*'
        );
      }
    });

    window.addEventListener('beforeunload', () => {
      clearInterval(intervalId);
    });
  },
});
