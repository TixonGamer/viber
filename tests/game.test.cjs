const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const audioCode = fs.readFileSync(path.join(__dirname, '..', 'assets', 'scare-audio.js'), 'utf8');

function setup({ audio = true, random = 0.5, resumeFails = false, missingRecording = false } = {}) {
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map();
  const sources = [];
  const buffers = [];
  const gains = [];
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.style = { setProperty() {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    replaceChildren(fragment) { this.children = fragment.children; }
    focus() { document.activeElement = this; }
    querySelector(selector) { return this.parts[selector]; }
    querySelectorAll() { return this.children; }
    click() { if (!this.disabled) this.listeners.click?.(); }
  }
  const ids = Object.fromEntries(['board', 'scare', 'page', 'score', 'feedback', 'start-panel', 'result-panel', 'game-status', 'final-score', 'result-title', 'result-description', 'start', 'restart'].map(id => [id, new Element()]));
  ids['result-panel'].parts = { '.eyebrow': new Element(), '.start-hint': new Element() };
  ids.scare.hidden = true;
  ids['result-panel'].hidden = true;
  const document = new Element();
  document.hidden = false;
  document.getElementById = id => ids[id];
  document.createElement = () => new Element();
  document.createDocumentFragment = () => new Element();
  document.body = { classList: { add() {}, remove() {} } };
  class AudioContext {
    constructor() { this.sampleRate = 8000; this.state = 'running'; }
    resume() { return resumeFails ? Promise.reject(new Error('Blocked')) : Promise.resolve(); }
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
  const math = Object.create(Math);
  math.random = () => random;
  vm.runInNewContext(code, { window, document, Math: math });
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
  const key = value => document.listeners.keydown?.({ key: value });
  return { ids, tick, timers, document, window, sources, buffers, gains, key };
}

test('idle never schedules a surprise', () => {
  const env = setup();
  env.tick(60000);
  assert.equal(env.timers.size, 0);
  assert.equal(env.ids.scare.hidden, true);
  assert.ok(env.ids.board.children.every(tile => tile.disabled));
});

test('random interval stays within 8–12 seconds; effect loops until closed', () => {
  for (const random of [0, 0.5, 0.999999]) {
    const env = setup({ random });
    env.ids.start.click();
    const delay = [...env.timers.values()][0].delay;
    assert.ok(delay >= 8000 && delay <= 12000);
    env.tick(delay - 1);
    assert.equal(env.ids.scare.hidden, true);
    env.tick(1);
    assert.equal(env.ids.scare.hidden, false);
    assert.equal(env.ids.page.inert, true);
    env.tick(60000);
    assert.equal(env.ids.scare.hidden, false);
    assert.equal(env.sources[1].loop, true);
    assert.equal(env.sources[1].stopped, undefined);
    assert.equal(env.sources.length, 2); // One looping source; no accumulated players.
    assert.equal(env.timers.size, 0);
    env.window.listeners.pagehide();
    assert.equal(env.ids.scare.hidden, true);
    assert.equal(env.ids.page.inert, false);
    assert.equal(env.ids['result-title'].textContent, 'Это был розыгрыш!');
    assert.equal(env.timers.size, 0);
  }
});

test('correct answers increase score, wrong answers do not; replay resets', () => {
  const env = setup();
  env.ids.start.click();
  env.ids.board.children[0].click();
  assert.equal(env.ids.score.textContent, '00');
  env.ids.board.children[8].click();
  assert.equal(env.ids.score.textContent, '01');
  env.tick(12500);
  env.window.listeners.pagehide();
  assert.equal(env.ids['final-score'].textContent, '1');
  env.ids.restart.click();
  assert.equal(env.ids.score.textContent, '00');
  assert.equal(env.ids['result-panel'].hidden, true);
  assert.equal(env.timers.size, 1);
  env.tick(10000);
  assert.equal(env.ids.scare.hidden, false);
});


test('original 2.5s scream loops at full gain; leaving the page stops it', () => {
  const env = setup();
  env.ids.start.click();
  assert.equal(env.sources.length, 1); // Silent unlock only.
  const samples = env.buffers[0].getChannelData(0);
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak > 0.98 && peak <= 0.99);
  assert.equal(env.buffers[0].duration, 2.5);
  assert.equal(env.buffers[0].sampleRate, 44100);
  assert.equal(env.gains[0].gain.value, 1);
  env.tick(10000);
  assert.equal(env.sources.length, 2);
  assert.equal(env.sources[1].started, true);
  assert.equal(env.sources[1].loop, true);
  env.window.listeners.pagehide();
  assert.equal(env.sources[1].stopped, true);
  assert.equal(env.ids.scare.hidden, true);
});


test('hidden tab and page exit cancel pending effects', () => {
  for (const cancel of [env => { env.document.hidden = true; env.document.listeners.visibilitychange(); }, env => env.window.listeners.pagehide()]) {
    const env = setup();
    env.ids.start.click();
    cancel(env);
    env.tick(60000);
    assert.equal(env.ids.scare.hidden, true);
    assert.equal(env.timers.size, 0);
    assert.equal(env.sources.length, 1);
  }
});

test('hidden tab during the effect stops audio', () => {
  const env = setup();
  env.ids.start.click();
  env.tick(10000);
  env.document.hidden = true;
  env.document.listeners.visibilitychange();
  assert.equal(env.sources[1].stopped, true);
  assert.equal(env.ids.scare.hidden, true);
  assert.equal(env.timers.size, 0);
});

test('missing or blocked Web Audio does not break the game', async () => {
  for (const config of [{ audio: false }, { resumeFails: true }, { missingRecording: true }]) {
    const env = setup(config);
    env.ids.start.click();
    await new Promise(setImmediate);
    assert.match(env.ids.feedback.textContent, /без звука|Звук недоступен/);
    env.tick(10000);
    assert.equal(env.ids.scare.hidden, false);
    env.tick(2500);
    assert.equal(env.ids.scare.hidden, false);
    env.window.listeners.pagehide();
    assert.equal(env.ids['result-panel'].hidden, false);
  }
});

test('duplicate start does not stack surprise timers', () => {
  const env = setup();
  env.ids.start.click();
  env.ids.start.click();
  assert.equal(env.timers.size, 1);
});




test('Escape is unhandled and browser navigation is not intercepted', () => {
  const env = setup();
  env.ids.start.click();
  env.key('Escape');
  assert.equal(env.timers.size, 1);
  env.tick(10000);
  env.key('Escape');
  assert.equal(env.ids.scare.hidden, false);
  assert.equal(env.sources[1].stopped, undefined);
  assert.equal(env.document.listeners.keydown, undefined);
  assert.equal(env.window.listeners.beforeunload, undefined);
  assert.equal(env.window.listeners.popstate, undefined);
});

test('returning to the tab does not restart the effect automatically', () => {
  const env = setup();
  env.ids.start.click();
  env.tick(10000);
  env.document.hidden = true;
  env.document.listeners.visibilitychange();
  env.document.hidden = false;
  env.document.listeners.visibilitychange();
  env.tick(60000);
  assert.equal(env.ids.scare.hidden, true);
  assert.equal(env.sources[1].stopped, true);
  assert.equal(env.timers.size, 0);
});
