// @ts-check
/**
 * Client entry point for the M0 shell.
 * The actual menu / match flow arrives with M2–M3.
 */

import { APP_NAME } from '../shared/constants.js';

const versionElement = document.getElementById('version');
const noticeElement = document.getElementById('notice');

document.title = `${APP_NAME} — 实时领土争夺`;

/**
 * @param {string} message
 */
function showNotice(message) {
  if (!noticeElement) return;
  noticeElement.textContent = message;
  noticeElement.classList.add('is-visible');
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.getAttribute('data-action');
    if (action === 'single') {
      window.location.href = '/game.html';
    } else if (action === 'help') {
      showNotice('目标：占领城市、扩张领土。单机可暂停，多人 16–32 人同图乱斗。');
    }
  });
});

fetch('/package.json', { cache: 'no-store' })
  .then((response) => (response.ok ? response.json() : null))
  .then((pkg) => {
    if (pkg && typeof pkg.version === 'string' && versionElement) {
      versionElement.textContent = `v${pkg.version}`;
    }
  })
  .catch(() => {
    // Version display is cosmetic; ignore failures.
  });
