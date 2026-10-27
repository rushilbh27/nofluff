(() => {
  const DEFAULTS = {
    sites: { youtube: true, netflix: true, prime: true },
    types: { ytAd: true, ytOverlay: true, intro: true, recap: true, credits: true },
  };

  const host = location.hostname;
  const site = /(^|\.)youtube\.com$/.test(host)
    ? 'youtube'
    : /(^|\.)netflix\.com$/.test(host)
      ? 'netflix'
      : /(^|\.)(primevideo|amazon)\./.test(host)
        ? 'prime'
        : null;
  if (!site) return;

  let settings = DEFAULTS;

  const merge = (stored) => ({
    sites: { ...DEFAULTS.sites, ...(stored && stored.sites) },
    types: { ...DEFAULTS.types, ...(stored && stored.types) },
  });

  // Settings live under one namespaced key so they can't collide with the ratings
  // extension's own storage (apiKey, quota, r:* cache).
  try {
    chrome.storage.sync.get('skipit', ({ skipit }) => {
      settings = merge(skipit);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.skipit) settings = merge(changes.skipit.newValue);
    });
  } catch (e) {
    // storage unavailable: run with defaults
  }

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  // Visible is not enough: YouTube shows a dimmed, inert "Skip" during the
  // countdown. A real, active button is the topmost element at its own centre.
  const hitTarget = (el) => {
    if (!isVisible(el)) return null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && el.contains(hit) ? hit : null;
  };
  const isClickable = (el) => !!hitTarget(el);

  // Full pointer sequence at the button centre; some players ignore a bare .click().
  const press = (button) => {
    // Dispatch on the real element under the pointer, so the event reaches its handler.
    const el = hitTarget(button) || button;
    const r = button.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  };

  // Real (trusted) click at the button centre, sent via the background page.
  const trustedClick = (el, useZoom) => {
    if (window.top !== window) return;
    const target = (el && el.tagName === 'BUTTON') ? el : ((el && el.querySelector('button')) || el);
    const hit = hitTarget(target) || target;
    const r = hit.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    try {
      chrome.runtime.sendMessage({
        type: 'skipTrustedClick',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        useZoom,
      });
    } catch (e) {
      // extension reloaded: ignore
    }
  };

  // Identifies the ad currently playing, so a skip into the next ad counts as a skip.
  const adSig = () => {
    const player = document.querySelector('#movie_player');
    const video = player && player.querySelector('video');
    if (!player || !video) return '';
    return [player.classList.contains('ad-showing'), video.currentSrc, video.duration].join('|');
  };

  // YouTube ignores scripted (untrusted) clicks on its Skip button. Fallback: only called
  // once the button is already active, i.e. the ad is skippable, so jump it to its end.
  const seekAdToEnd = () => {
    const player = document.querySelector('#movie_player');
    const video = player && player.querySelector('video');
    if (!player || !video || !player.classList.contains('ad-showing')) return false;
    // Image/static ads have no usable video duration; the caller falls back to clicking.
    if (!isFinite(video.duration) || video.duration <= 0) return false;
    // If the video ad already reached the end, it has no video left to jump;
    // this is now a static residue ad. Return false so caller falls back to trustedClick.
    if (video.ended || video.currentTime >= video.duration - 0.5) {
      if (video.paused) video.play().catch(() => {});
      return false;
    }
    console.debug('[NoFluff] seeking ad to end', video.currentTime, '/', video.duration);
    try {
      video.playbackRate = 16.0;
    } catch (e) {}
    video.currentTime = video.duration;
    return true;
  };

  // Classify a Prime skip button by its label.
  const primeType = (el) => {
    const t = (el.textContent || '').toLowerCase();
    if (t.includes('recap')) return 'recap';
    if (t.includes('credit')) return 'credits';
    return 'intro';
  };

  // Each rule: selector list, setting key (or fn(el) -> key).
  const RULES = {
    youtube: [
      {
        key: 'ytAd',
        selectors: [
          '.ytp-skip-ad-button',
          '.ytp-ad-skip-button-modern',
          '.ytp-ad-skip-button',
          '.ytp-ad-skip-button-container button',
          '.ytp-skip-ad button',
          '.ytp-ad-player-overlay-layout__skip-or-preview-container button',
          '.ytp-ad-player-overlay-layout__skip-or-preview-container [class*="skip"]',
          '.ytp-ad-skip-button-slot button',
          '.ytp-ad-skip-button-slot',
          'button[id^="skip-button:"]',
          'button[aria-label*="Skip" i]',
          '#movie_player [class*="skip-ad"] button',
          '#movie_player [class*="skip-button"]',
        ],
      },
      {
        key: 'ytOverlay',
        selectors: [
          '.ytp-ad-overlay-close-button',
          '.ytp-ad-overlay-close-container',
          '.ytp-ad-player-overlay-layout__close-button',
          '.ytp-ad-action-interstitial button[class*="close"]',
          '.ytp-ad-endslate button[class*="close"]',
          '.ytp-ad-button-close',
          'button[aria-label*="Close ad" i]',
          'button[aria-label*="Close" i][class*="ytp-ad"]',
          '#movie_player .video-ads button[aria-label*="Close" i]',
          '#movie_player .ytp-ad-module button[aria-label*="Close" i]',
        ],
      },
    ],
    netflix: [
      { key: 'intro', selectors: ['[data-uia="player-skip-intro"]'] },
      { key: 'recap', selectors: ['[data-uia="player-skip-recap"]'] },
    ],
    prime: [
      {
        key: primeType,
        selectors: [
          '.atvwebplayersdk-skipelement-button',
          'button[class*="skipelement"]',
          '.atvwebplayersdk-skipelement-container button',
        ],
      },
    ],
  };

  const LABELS = {
    ytAd: 'Ad skipped',
    ytOverlay: 'Banner closed',
    intro: 'Intro skipped',
    recap: 'Recap skipped',
    credits: 'Credits skipped',
  };

  // Count skips for the popup.
  const bump = () => {
    try {
      chrome.storage.local.get('skipitStats', ({ skipitStats }) => {
        const day = new Date().toDateString();
        const s = skipitStats || { total: 0, day, today: 0 };
        if (s.day !== day) {
          s.day = day;
          s.today = 0;
        }
        s.total += 1;
        s.today += 1;
        chrome.storage.local.set({ skipitStats: s });
      });
    } catch (e) {
      // extension reloaded mid-session: ignore
    }
  };

  // Toast sticker. Mounted inside the fullscreen element when there is one,
  // because anything outside it is invisible in fullscreen.
  let toastEl = null;
  let toastTimer = 0;
  const toast = (text) => {
    if (window.top !== window) return;
    const host = document.fullscreenElement || document.documentElement;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('aria-hidden', 'true');
      toastEl.style.cssText = [
        'position:fixed',
        'left:24px',
        'bottom:96px',
        'z-index:2147483647',
        'padding:9px 14px',
        'background:#ffd500',
        'color:#111',
        'border:3px solid #111',
        'box-shadow:4px 4px 0 #111',
        'font:900 14px/1 "Arial Black","Helvetica Neue",Arial,sans-serif',
        'letter-spacing:-0.01em',
        'transform:rotate(-2deg)',
        'pointer-events:none',
        'transition:opacity .15s ease',
      ].join(';');
    }
    if (toastEl.parentNode !== host) host.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
    }, 1600);
  };

  const lastClick = new WeakMap();
  const attempts = new WeakMap();

  const scan = () => {
    if (!settings.sites[site]) return;
    for (const rule of RULES[site]) {
      for (const sel of rule.selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisible(el)) continue;
          const key = typeof rule.key === 'function' ? rule.key(el) : rule.key;
          if (!settings.types[key]) continue;
          // YouTube: act the moment the button is visible (an overlay can fail the hit test).
          const ready = site === 'youtube' ? isVisible(el) : isClickable(el);
          if (!ready) {
            attempts.delete(el);
            continue;
          }
          const now = Date.now();
          if (now - (lastClick.get(el) || 0) < (site === 'youtube' ? 300 : 800)) continue;
          lastClick.set(el, now);
          const sigBefore = adSig();
          // Alternate a plain click with a full pointer sequence across retries.
          const n = attempts.get(el) || 0;
          attempts.set(el, n + 1);
          console.debug('[NoFluff] skip', site, key, 'attempt', n, el.className);
          // Keep cycling methods until the button goes away: some ads need more than one try.
          const step = n % 3;
          if (step === 0) el.click();
          else if (step === 1) press(el);
          else if (site === 'youtube') {
            // Video ad: seek to end. Static ad, residual static ad, or overlay close: trusted click through background.
            if (key === 'ytAd' && seekAdToEnd()) {
              // Video jumped to end
            } else {
              trustedClick(el, Math.floor(n / 3) % 2 === 0);
            }
          } else el.click();
          // Only report a skip if the button actually went away.
          setTimeout(() => {
            if (!isVisible(el) || (site === 'youtube' && adSig() !== sigBefore)) {
              bump();
              toast(LABELS[key] || 'Skipped');
            }
          }, 450);
        }
      }
    }
  };

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });

  // Fallback: covers cases where the button appears without a DOM mutation we catch.
  setInterval(scan, 500);
})();
