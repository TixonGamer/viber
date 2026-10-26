(() => {
  'use strict';

  const MIN_DELAY = 8000;
  const MAX_DELAY = 12000;
  const AUDIO_GAIN = 1; // 100% site volume. The source PCM peaks at 0.99, without added clipping.
  const $ = (id) => document.getElementById(id);
  const board = $('board');
  const scare = $('scare');
  const soundButtons = [...document.querySelectorAll('[data-sound]')];
  let state = 'ready';
  let score = 0;
  let target = 0;
  let soundEnabled = true;
  let triggerTimer;
  let audioContext;
  let masterGain;
  let soundBuffer;
  let source;
  let audioUnavailable = false;

  // The original scream is bundled as PCM16. No network fetch or decoder is
  // needed here, so opening index.html directly from disk also works.
  function loadSound(context) {
    const recording = window.SCARE_AUDIO;
    if (!recording || !recording.base64 || !recording.sampleRate) throw new Error('Missing audio');
    const bytes = window.atob(recording.base64);
    const length = bytes.length / 2;
    if (!Number.isInteger(length) || length === 0) throw new Error('Invalid PCM');
    const buffer = context.createBuffer(1, length, recording.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const value = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
    }
    return buffer;
  }

  function updateSoundButtons() {
    soundButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(soundEnabled));
      button.querySelector('[data-sound-label]').textContent = soundEnabled ? 'Звук включён' : 'Звук выключен';
      button.setAttribute('aria-label', soundEnabled ? 'Выключить звук' : 'Включить звук');
    });
  }

  function markAudioUnavailable() {
    audioUnavailable = true;
    soundEnabled = false;
    updateSoundButtons();
    $('feedback').textContent = 'Звук недоступен в этом браузере. Игра продолжается.';
  }

  function unlockAudio(onReady) {
    if (!soundEnabled) return;
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Web Audio unavailable');
        audioContext = new AudioContextClass();
        masterGain = audioContext.createGain();
        masterGain.gain.value = AUDIO_GAIN;
        masterGain.connect(audioContext.destination);
      }
      if (!soundBuffer) soundBuffer = loadSound(audioContext);
      // resume() and a silent source run directly in the click handler, including iOS.
      const resumed = audioContext.resume();
      Promise.resolve(resumed).then(() => {
        if (onReady) onReady();
      }).catch(markAudioUnavailable);
      const silent = audioContext.createBufferSource();
      silent.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
      silent.connect(masterGain);
      silent.onended = () => silent.disconnect();
      silent.start();
      audioUnavailable = false;
    } catch {
      markAudioUnavailable();
    }
  }

  function stopSound() {
    if (!source) return;
    const previous = source;
    source = null;
    try { previous.stop(); } catch { /* Already ended. */ }
    previous.disconnect();
  }

  function playSound() {
    if (!soundEnabled || !audioContext || audioContext.state !== 'running') return;
    stopSound();
    try {
      const current = audioContext.createBufferSource();
      current.buffer = soundBuffer;
      current.loop = true;
      current.connect(masterGain);
      current.onended = () => {
        current.disconnect();
        if (source === current) source = null;
      };
      source = current;
      current.start();
    } catch {
      stopSound();
      markAudioUnavailable();
    }
  }

  function renderBoard() {
    const focusedIndex = [...board.children].indexOf(document.activeElement);
    target = Math.floor(Math.random() * 16);
    const hue = (score * 31 + 91) % 360;
    const difference = Math.max(5, 13 - score);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 16; i++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.setAttribute('aria-label', `Квадрат ${i + 1}`);
      tile.style.setProperty('--tile-color', `hsl(${hue} 28% ${i === target ? 59 + difference : 59}%)`);
      tile.disabled = state !== 'playing';
      tile.addEventListener('click', () => chooseTile(i));
      fragment.appendChild(tile);
    }
    board.replaceChildren(fragment);
    if (state === 'playing' && focusedIndex >= 0) board.children[focusedIndex].focus({ preventScroll: true });
  }

  function chooseTile(index) {
    if (state !== 'playing') return;
    if (index !== target) {
      $('feedback').textContent = 'Почти! Присмотритесь ещё раз.';
      return;
    }
    score++;
    $('score').textContent = String(score).padStart(2, '0');
    $('feedback').textContent = 'Верно! А теперь найдите следующий.';
    renderBoard();
  }

  function clearTimers() {
    window.clearTimeout(triggerTimer);
  }

  function startGame() {
    if (state === 'playing' || state === 'scare') return;
    clearTimers();
    stopSound();
    state = 'playing';
    score = 0;
    $('score').textContent = '00';
    $('start-panel').hidden = true;
    $('result-panel').hidden = true;
    $('stop').hidden = false;
    $('game-status').textContent = 'ИЩИТЕ ОТЛИЧИЕ';
    $('feedback').textContent = 'Нажмите на квадрат другого оттенка.';
    renderBoard();
    unlockAudio();
    if (audioUnavailable) $('feedback').textContent = 'Играем без звука. Найдите другой оттенок.';
    board.children[0].focus({ preventScroll: true });
    triggerTimer = window.setTimeout(showScare, MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
  }

  function showScare() {
    if (state !== 'playing') return;
    if (document.hidden) { finishGame('paused'); return; }
    state = 'scare';
    scare.hidden = false;
    $('page').inert = true;
    document.body.classList.add('effect-open');
    $('close-scare').focus({ preventScroll: true });
    playSound();
  }

  function finishGame(reason = 'prank', moveFocus = true) {
    if (state !== 'playing' && state !== 'scare') return;
    clearTimers();
    stopSound();
    state = 'finished';
    scare.hidden = true;
    $('page').inert = false;
    document.body.classList.remove('effect-open');
    $('stop').hidden = true;
    [...board.children].forEach((tile) => { tile.disabled = true; });
    $('result-panel').hidden = false;
    $('final-score').textContent = String(score);
    $('game-status').textContent = 'РАУНД ЗАВЕРШЁН';
    $('feedback').textContent = 'Ещё один раунд?';
    const wasPrank = reason === 'prank';
    $('result-title').textContent = wasPrank ? 'Это был розыгрыш!' : 'Раунд завершён';
    $('result-description').textContent = wasPrank
      ? 'Всё хорошо. Наш загадочный гость уже ушёл.'
      : reason === 'paused' ? 'Вы отвлеклись — мы остановили игру. Начните снова, когда будете готовы.' : 'Можно выдохнуть и попробовать ещё раз.';
    $('result-panel').querySelector('.eyebrow').textContent = wasPrank ? 'НЕОЖИДАННЫЙ ФИНАЛ' : 'МОЖНО СДЕЛАТЬ ПАУЗУ';
    $('result-panel').querySelector('.start-hint').textContent = wasPrank ? 'Теперь вы знаете наш маленький секрет.' : 'Новый раунд начнётся только по нажатию.';
    if (moveFocus) $('restart').focus({ preventScroll: true });
  }

  soundButtons.forEach((button) => button.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    if (!soundEnabled) {
      if (masterGain) masterGain.gain.value = 0;
      stopSound();
    } else {
      unlockAudio(() => {
        if (state === 'scare' && soundEnabled && !source) playSound();
      });
      if (masterGain) masterGain.gain.value = AUDIO_GAIN;
    }
    updateSoundButtons();
  }));
  $('start').addEventListener('click', startGame);
  $('restart').addEventListener('click', startGame);
  $('stop').addEventListener('click', () => finishGame('stopped'));
  $('close-scare').addEventListener('click', () => finishGame('prank'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishGame(state === 'scare' ? 'prank' : 'stopped');
    if (event.key === 'Tab' && state === 'scare') {
      const buttons = [...scare.querySelectorAll('button')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finishGame('paused', false);
  });
  window.addEventListener('pagehide', () => finishGame('paused', false));
  renderBoard();
  updateSoundButtons();
})();
