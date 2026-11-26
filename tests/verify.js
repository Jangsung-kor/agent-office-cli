const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { translateErrorByRules } = require('../server/errorTranslator');

const ROOT = path.resolve(__dirname, '..');

function testServerSyntax() {
  const serverFiles = [
    'server/bridge.js',
    'server/transcript.js',
    'server/agyRunner.js',
    'server/agentRegistry.js',
    'server/errorTranslator.js',
    'server/providers/index.js',
    'server/providers/antigravityProvider.js',
    'server/providers/codexProvider.js'
  ];
  for (const rel of serverFiles) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  }
}

function testErrorTranslatorRules() {
  const cases = [
    { input: 'trajectory not found for id xyz', id: 'session_not_found', aiExplainable: false },
    { input: 'HTTP 429 resource_exhausted quota', id: 'quota_exceeded', aiExplainable: false },
    { input: 'listen EADDRINUSE :::3110', id: 'port_in_use', aiExplainable: true },
    { input: 'unhandled native panic', id: 'unknown', aiExplainable: true }
  ];
  for (const c of cases) {
    const res = translateErrorByRules(c.input);
    assert.strictEqual(res.id, c.id, `Expected ${c.id}, got ${res.id}`);
    assert.strictEqual(res.aiExplainable, c.aiExplainable, `Expected aiExplainable=${c.aiExplainable}`);
  }
}

function testSimplifiedFourStates() {
  const layoutSrc = fs.readFileSync(path.join(ROOT, 'src/constants/officeLayout.js'), 'utf8');
  assert.ok(!/\bPLANNING\b/.test(layoutSrc), 'officeLayout.js must not contain PLANNING state');
  assert.ok(!/\bREVIEW\b/.test(layoutSrc), 'officeLayout.js must not contain REVIEW state');
  for (const st of ['IDLE', 'WORKING', 'DONE', 'BLOCKED']) {
    assert.ok(new RegExp(`\\b${st}\\b`).test(layoutSrc), `officeLayout.js missing ${st}`);
  }
}

function testArchitectureConventions() {
  const componentsDir = path.join(ROOT, 'src', 'components');
  const files = fs.readdirSync(componentsDir).filter(f => f.endsWith('.vue'));
  for (const file of files) {
    const src = fs.readFileSync(path.join(componentsDir, file), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(src), `${file} must not call fetch() directly`);
    assert.ok(!/\blocalStorage\b/.test(src), `${file} must not access localStorage directly`);
  }
  const modalFiles = [
    'HandoverModal.vue',
    'ModelGuideModal.vue',
    'SessionManagerModal.vue',
    'TeamRosterModal.vue',
    'TokenUsageModal.vue',
    'AgentChatPanel.vue'
  ];
  for (const file of modalFiles) {
    const src = fs.readFileSync(path.join(componentsDir, file), 'utf8');
    assert.ok(src.includes('<BaseModal'), `${file} should use shared <BaseModal>`);
  }
}

function run() {
  testServerSyntax();
  testErrorTranslatorRules();
  testSimplifiedFourStates();
  testArchitectureConventions();
  console.log('ALL_VERIFY_TESTS_PASSED');
}

run();
