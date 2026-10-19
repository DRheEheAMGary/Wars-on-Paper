// @ts-check
/**
 * Single-player setup page: seed, map size, AI count, difficulty and length.
 */

const CITY_OPTIONS = [60, 100, 160, 240, 360];
const AI_OPTIONS = [0, 1, 2, 3];
const DEFAULT_CITIES = 160;
const DEFAULT_AI = 2;
const DEFAULT_MINUTES = 10;

const seedInput = /** @type {HTMLInputElement} */ (document.getElementById('setup-seed'));
const citiesSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setup-cities'));
const aiSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setup-ai'));
const difficultyGroup = /** @type {HTMLElement} */ (document.getElementById('setup-difficulty'));
const minutesSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setup-minutes'));
const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('setup-mode'));
const form = /** @type {HTMLFormElement} */ (document.getElementById('setup-form'));
const randomSeedButton = /** @type {HTMLButtonElement} */ (document.getElementById('setup-random-seed'));

const params = new URLSearchParams(window.location.search);

/** @returns {number} */
function randomSeed() {
  return Math.floor(Math.random() * 1_000_000);
}

/**
 * @param {any} balance
 */
function populate(balance) {
  for (const count of CITY_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = `${count} 座`;
    citiesSelect.append(option);
  }

  for (const count of AI_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = count === 0 ? '无（纯扩张）' : `${count} 名`;
    aiSelect.append(option);
  }

  const difficulties = balance?.difficulties ?? {
    easy: { label: '简单' },
    normal: { label: '普通' },
    hard: { label: '困难' },
  };
  for (const [id, profile] of Object.entries(difficulties)) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'difficulty';
    input.value = id;
    label.append(input, document.createTextNode(profile.label ?? id));
    difficultyGroup.append(label);
  }

  const lengths = balance?.matchLengthOptions ?? [300, 600, 900, 1200];
  for (const seconds of lengths) {
    const option = document.createElement('option');
    option.value = String(seconds / 60);
    option.textContent = `${seconds / 60} 分钟`;
    minutesSelect.append(option);
  }

  const requestedSeed = Number(params.get('seed'));
  seedInput.value = String(
    Number.isFinite(requestedSeed) && requestedSeed > 0 ? requestedSeed : randomSeed(),
  );

  const requestedCities = Number(params.get('cities'));
  citiesSelect.value = String(
    CITY_OPTIONS.includes(requestedCities) ? requestedCities : DEFAULT_CITIES,
  );

  const requestedAI = Number(params.get('ai'));
  aiSelect.value = String(AI_OPTIONS.includes(requestedAI) ? requestedAI : DEFAULT_AI);

  const requestedDifficulty = params.get('difficulty') ?? '';
  const difficultyIds = Object.keys(difficulties);
  const difficultyId = difficultyIds.includes(requestedDifficulty)
    ? requestedDifficulty
    : balance?.defaultDifficulty ?? 'normal';
  const radio = /** @type {HTMLInputElement | null} */ (
    difficultyGroup.querySelector(`input[value="${difficultyId}"]`)
  );
  if (radio) radio.checked = true;
  else {
    const first = /** @type {HTMLInputElement | null} */ (
      difficultyGroup.querySelector('input')
    );
    if (first) first.checked = true;
  }

  const requestedMinutes = Number(params.get('minutes'));
  const minuteValues = lengths.map((/** @type {number} */ seconds) => seconds / 60);
  minutesSelect.value = String(
    minuteValues.includes(requestedMinutes) ? requestedMinutes : DEFAULT_MINUTES,
  );

  modeSelect.value = params.get('mode') === 'endless' ? 'endless' : 'timed';
  syncMode();
}

function syncMode() {
  const endless = modeSelect.value === 'endless';
  minutesSelect.disabled = endless;
  minutesSelect.closest('.setup-row')?.classList.toggle('is-disabled', endless);
}

const balance = await fetch('/data/balance.json', { cache: 'no-store' })
  .then((response) => response.json())
  .catch(() => null);

populate(balance);

randomSeedButton.addEventListener('click', () => {
  seedInput.value = String(randomSeed());
});

modeSelect.addEventListener('change', syncMode);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const seed = Math.max(0, Math.floor(Number(seedInput.value) || randomSeed()));
  const cities = Number(citiesSelect.value) || DEFAULT_CITIES;
  const ai = Number(aiSelect.value) || 0;
  const difficulty =
    /** @type {HTMLInputElement | null} */ (
      difficultyGroup.querySelector('input:checked')
    )?.value ?? 'normal';
  const minutes = Number(minutesSelect.value) || DEFAULT_MINUTES;

  const query = new URLSearchParams({
    seed: String(seed),
    cities: String(cities),
    ai: String(ai),
    difficulty,
    minutes: String(minutes),
    mode: modeSelect.value,
  });
  window.location.href = `/game.html?${query.toString()}`;
});
