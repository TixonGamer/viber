const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const audioCode = fs.readFileSync(path.join(__dirname, '..', 'assets', 'scare-audio.js'), 'utf8');

function setup({ audio = true, resumeFails = false, deferredResume = false, initialHidden = false, missingRecording = false } = {}) {
  let clock = 0;
  let nextTimer = 0;
  let resolveResume;
  const timers = new Map();
  const sources = [];
  const buffers = [];
  const gains = [];
  class Element {
    constructor() { this.listeners = {}; this.hidden = false; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    focus() { document.activeElement = this; }
    blur() { this.blurred = true; }
  }
  const ids = Object.fromEntries(['page', 'scare', 'message', 'menu', 'dialog', 'open-dialog'].map(id => [id, new Element()]));
  ids.scare.hidden = true;
  ids.dialog.hidden = true;
  const document = new Element();
  document.hidden = initialHidden;
  document.getElementById = id => ids[id];
  document.body = { classList: { add() {}, remove() {} } };
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.state = 'suspended'; }
    resume() {
      if (resumeFails) return Promise.reject(new Error('Blocked'));
      if (deferredResume) return new Promise(resolve => { resolveResume = () => { this.state = 'running'; resolve(); }; });
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() { const gain = { gain: { value: 1 }, connect() {} }; gains.push(gain); return gain; }
    createBuffer(channels, length, sampleRate) { const data = new Float32Array(length); const buffer = { length, sampleRate, duration: length / sampleRate, getChannelData: () => data }; buffers.push(buffer); return buffer; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
  }
  const window = new Element();
  window.atob = value => Buffer.from(value, 'base64').toString('binary');
  if (!missingRecording) vm.runInNewContext(audioCode, { window });
  window.AudioContext = audio ? AudioContext : undefined;
  window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay, delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  vm.runInNewContext(code, { window, document });
  function tick(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    clock = end;
  }
  const click = () => document.listeners.click({ type: 'click' });
  const open = () => { ids['open-dialog'].listeners.click({ type: 'click' }); click(); };
  const key = (key, repeat = false) => document.listeners.keydown({ type: 'keydown', key, repeat });
  const setHidden = hidden => { document.hidden = hidden; document.listeners.visibilitychange(); };
  const loops = () => sources.filter(source => source.buffer.length > 1);
  return { ids, tick, timers, document, window, sources, buffers, gains, click, open, key, setHidden, loops, resolveResume: () => resolveResume() };
}
const flush = () => new Promise(setImmediate);

test('menu waits indefinitely; incidental clicks and keys cannot start the effect', () => {
  const env = setup();
  env.click();
  env.key('а');
  env.tick(60000);
  assert.equal(env.timers.size, 0);
  assert.equal(env.ids.menu.hidden, false);
  assert.equal(env.ids.dialog.hidden, true);
  assert.equal(env.ids.scare.hidden, true);
  assert.equal(env.sources.length, 0);
});

test('opening the dialog unlocks audio synchronously and starts the effect after 3 seconds', async () => {
  const env = setup();
  env.tick(15000);
  env.open();
  assert.equal(env.gains.length, 1);
  assert.equal(env.sources[0].started, true);
  assert.equal(env.ids.menu.hidden, true);
  assert.equal(env.ids.dialog.hidden, false);
  assert.equal(env.document.activeElement, env.ids.dialog);
  await flush();
  env.tick(2999);
  assert.equal(env.ids.scare.hidden, true);
  assert.equal(env.loops().length, 0);
  env.tick(1);
  assert.equal(env.ids.scare.hidden, false);
  assert.equal(env.ids.page.inert, true);
  assert.equal(env.loops().length, 1);
  assert.equal(env.loops()[0].started, true);
  assert.equal(env.loops()[0].loop, true);
  assert.equal(env.gains[0].gain.value, 1);
  env.tick(60000);
  assert.equal(env.loops().length, 1);
});

test('double opening and repeated taps cannot reset the timer or stack audio', async () => {
  const env = setup();
  env.open();
  env.tick(1000);
  env.open();
  assert.equal(env.timers.size, 1);
  await flush();
  env.tick(2000);
  env.click();
  env.open();
  assert.equal(env.ids.scare.hidden, false);
  assert.equal(env.loops().length, 1);
  assert.equal(env.gains.length, 1);
});

test('Escape and navigation keys leave the effect and browser actions alone', async () => {
  const env = setup();
  env.open();
  await flush();
  env.tick(3000);
  for (const key of ['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta']) env.key(key);
  assert.equal(env.ids.scare.hidden, false);
  assert.equal(env.loops()[0].stopped, undefined);
  assert.equal(env.window.listeners.beforeunload, undefined);
});

test('leaving before or during the effect cancels it and returns to the menu', async () => {
  for (const elapsed of [1000, 3000]) {
    for (const leave of [env => env.setHidden(true), env => env.window.listeners.pagehide()]) {
      const env = setup();
      env.open();
      await flush();
      env.tick(elapsed);
      leave(env);
      env.tick(60000);
      assert.equal(env.ids.scare.hidden, true);
      assert.equal(env.ids.page.inert, false);
      assert.equal(env.ids.menu.hidden, false);
      assert.equal(env.ids.dialog.hidden, true);
      assert.ok(env.loops().every(source => source.stopped));
      env.setHidden(false);
      env.click();
      env.tick(60000);
      assert.equal(env.ids.scare.hidden, true);
      assert.equal(env.timers.size, 0);
    }
  }
});

test('returning requires a new explicit opening and reuses the audio context', async () => {
  const env = setup();
  env.open();
  await flush();
  env.tick(3000);
  env.setHidden(true);
  env.setHidden(false);
  env.open();
  env.tick(2999);
  assert.equal(env.ids.scare.hidden, true);
  env.tick(1);
  assert.equal(env.ids.scare.hidden, false);
  assert.equal(env.gains.length, 1);
  assert.equal(env.loops().filter(source => !source.stopped).length, 1);
});

test('late audio activation cannot restart sound after leaving', async () => {
  const env = setup({ deferredResume: true });
  env.open();
  env.tick(3000);
  env.setHidden(true);
  env.resolveResume();
  await flush();
  assert.equal(env.loops().length, 0);
});

test('missing, unavailable or blocked audio does not break the visual timer', async () => {
  for (const config of [{ audio: false }, { resumeFails: true }, { missingRecording: true }]) {
    const env = setup(config);
    env.open();
    await flush();
    env.tick(3000);
    assert.equal(env.ids.scare.hidden, false);
    assert.equal(env.loops().length, 0);
  }
});

test('initially hidden page still requires the button after becoming visible', () => {
  const env = setup({ initialHidden: true });
  env.open();
  env.tick(60000);
  assert.equal(env.timers.size, 0);
  env.setHidden(false);
  env.tick(60000);
  assert.equal(env.ids.scare.hidden, true);
  assert.equal(env.sources.length, 0);
  env.open();
  env.tick(3000);
  assert.equal(env.ids.scare.hidden, false);
});

test('draft input loses focus on the effect, and recording remains peak-normalized', async () => {
  const env = setup();
  env.open();
  env.ids.message.focus();
  await flush();
  env.tick(3000);
  assert.equal(env.ids.message.blurred, true);
  assert.equal(env.document.activeElement, env.ids.scare);
  assert.equal(env.buffers[0].duration, 2.5);
  const peak = env.buffers[0].getChannelData(0).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak > 0.98 && peak <= 0.99);
});
