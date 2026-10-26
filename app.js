(() => {
  'use strict';

  const TRIGGER_DELAY = 3000;
  const AUDIO_GAIN = 1;
  const page = document.getElementById('page');
  const scare = document.getElementById('scare');
  let state = document.hidden ? 'idle' : 'waiting';
  let triggerTimer;
  let audioContext;
  let masterGain;
  let soundBuffer;
  let source;
  let activatingAudio = false;

  // Local PCM also works when index.html is opened directly from disk.
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

  function stopSound() {
    if (!source) return;
    const previous = source;
    source = null;
    try { previous.stop(); } catch { /* Already ended. */ }
    previous.disconnect();
  }

  function playSound() {
    if (state !== 'scare' || document.hidden || source || !soundBuffer || audioContext?.state !== 'running') return;
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
    } catch { stopSound(); }
  }

  function activateAudio(event) {
    // Ignore navigation/modifier keys; no shortcuts or browser actions are intercepted.
    if (event.type === 'keydown' && (event.repeat || event.ctrlKey || event.metaKey || event.altKey || ['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key))) return;
    if (state === 'stopped' || document.hidden || activatingAudio) return;
    if (audioContext?.state === 'running' && soundBuffer) { playSound(); return; }
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioContext = new AudioContextClass();
        masterGain = audioContext.createGain();
        masterGain.gain.value = AUDIO_GAIN;
        masterGain.connect(audioContext.destination);
      }
      if (!soundBuffer) soundBuffer = loadSound(audioContext);
      activatingAudio = true;
      // Called synchronously inside a click/key gesture, including mobile taps.
      const resumed = audioContext.resume();
      const silent = audioContext.createBufferSource();
      silent.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
      silent.connect(masterGain);
      silent.onended = () => silent.disconnect();
      silent.start();
      Promise.resolve(resumed).then(() => {
        activatingAudio = false;
        playSound();
      }, () => { activatingAudio = false; });
    } catch { activatingAudio = false; }
  }

  function showScare() {
    if (state !== 'waiting') return;
    if (document.hidden) { stopEffect(); return; }
    state = 'scare';
    scare.hidden = false;
    page.inert = true;
    document.body.classList.add('effect-open');
    // Blur the draft field to dismiss the phone keyboard before showing the effect.
    document.activeElement?.blur();
    scare.focus({ preventScroll: true });
    playSound();
  }

  function stopEffect() {
    window.clearTimeout(triggerTimer);
    state = 'stopped';
    stopSound();
    scare.hidden = true;
    page.inert = false;
    document.body.classList.remove('effect-open');
  }

  document.addEventListener('click', activateAudio);
  document.addEventListener('keydown', activateAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state !== 'idle') stopEffect();
    } else if (state === 'idle') {
      state = 'waiting';
      triggerTimer = window.setTimeout(showScare, TRIGGER_DELAY);
    }
  });
  window.addEventListener('pagehide', stopEffect);
  // Visiting the page starts the visual timer; sound still requires a user gesture.
  if (state === 'waiting') triggerTimer = window.setTimeout(showScare, TRIGGER_DELAY);
})();
