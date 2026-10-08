// build-skills.test.mjs — 生成スクリプトのテスト: カードの種類ごとのエージェントと入口のエージェント(IDE 内のループ B1。段3 proc-v019)
//   node --test tools/build-skills/test/
//
// 一時ディレクトリに procedure/ と生成スクリプトを写し、そこで生成と検査(--check・lint skills_in_sync)を行う(実物の生成物には触れない)。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../lint/lib/yaml-lite.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// 入口のエージェントの本文の見本(docs/94_改訂指示/03_IDE内ループ.md 3.1 の5行の手順)。正本 procedure/cards/agents.yaml の runner.instruction と食い違えば失敗する
const RUNNER_SAMPLE = [
  'あなたはカードを配る係である。カードの作業は自分でしない。',
  /^1\. `node tools\/pms\/pms\.mjs next --flow <フローID>[^`]*` を実行する$/,
  /^2\. 出力の state が done なら、`node tools\/pms\/pms\.mjs status --flow <フローID>` の要約を利用者に伝え/,
  /^3\. state が STOP なら、出力の message をそのまま利用者に伝えて終わる/,
  /^4\. state が card なら、出力の agent のサブエージェントに、出力の prompt をそのまま渡す/,
  /^5\. サブエージェントの返事の内容にかかわらず、1 に戻る。利用者には1カード1行/,
];

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-skills-'));
  fs.cpSync(path.join(REAL_ROOT, 'procedure'), path.join(root, 'procedure'), { recursive: true });
  // 生成スクリプトは ../lint/lib/yaml-lite.mjs を読む。lint skills_in_sync は --root の下の生成スクリプトを呼ぶ
  fs.cpSync(path.join(REAL_ROOT, 'tools/build-skills/build-skills.mjs'), path.join(root, 'tools/build-skills/build-skills.mjs'));
  fs.cpSync(path.join(REAL_ROOT, 'tools/lint/lib'), path.join(root, 'tools/lint/lib'), { recursive: true });
  return root;
}

function build(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/build-skills/build-skills.mjs'), '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function cardKinds() {
  const v = parseYaml(fs.readFileSync(path.join(REAL_ROOT, 'procedure/vocab.yaml'), 'utf8'));
  return Object.keys(v.pms_card_kind);
}

const cardAgent = (k) => `pms-card-${k.replace(/[._]/g, '-')}`;

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'frontmatter がない');
  return parseYaml(m[1]);
}

test('build: 入口のエージェント pms-runner とカードの種類ごとのエージェントを Copilot・Kiro に生成する', () => {
  const root = tmpRepo();
  const r = build(root);
  assert.equal(r.code, 0, r.out + r.err);
  const kinds = cardKinds();
  for (const k of kinds) {
    assert.ok(fs.existsSync(path.join(root, '.github/agents', `${cardAgent(k)}.agent.md`)), k);
    assert.ok(fs.existsSync(path.join(root, '.kiro/agents', `${cardAgent(k)}.json`)), k);
  }

  // Copilot(VS Code のカスタムエージェント): 呼べるサブエージェントはカードのエージェントだけ。道具は端末とサブエージェントの呼び出しだけ
  const md = fs.readFileSync(path.join(root, '.github/agents/pms-runner.agent.md'), 'utf8');
  const fm = frontmatter(md);
  assert.equal(fm.name, 'pms-runner');
  assert.deepEqual(fm.agents, kinds.map(cardAgent));
  assert.deepEqual(fm.tools, ['execute', 'agent']);
  assert.ok(fm.model, 'model がない');
  assert.equal(fm['disable-model-invocation'], true);

  // 本文が 3.1 の5行の手順と食い違わない(見本との比較)
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').filter((l) => l.trim() && !l.startsWith('<!--'));
  assert.ok(body[0].startsWith(RUNNER_SAMPLE[0]), body[0]);
  for (let i = 1; i < RUNNER_SAMPLE.length; i++) assert.match(body[i], RUNNER_SAMPLE[i]);
  assert.ok(body.length <= RUNNER_SAMPLE.length + 1, `本文が長い(${body.length} 行)。どのモデルでも守れる短さにする`);

  // Kiro: サブエージェントは pms-card-* だけ、シェルは pms next・pms status だけ、書き込みの道具を持たない
  const kiro = JSON.parse(fs.readFileSync(path.join(root, '.kiro/agents/pms-runner.json'), 'utf8'));
  assert.deepEqual(kiro.tools, ['shell', 'subagent']);
  assert.deepEqual(kiro.toolsSettings.subagent.availableAgents, ['pms-card-*']);
  assert.deepEqual(kiro.toolsSettings.shell.allowedCommands, ['node tools/pms/pms.mjs next *', 'node tools/pms/pms.mjs status *']);
  assert.equal(kiro.prompt, md.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^<!--.*-->\n\n/, ''));

  // カードのエージェントは段2のまま(VS Code のカスタムエージェントとしても読める frontmatter。本文に「画面操作は pms act」)
  const step = fs.readFileSync(path.join(root, '.github/agents/pms-card-explore-step.agent.md'), 'utf8');
  const sfm = frontmatter(step);
  assert.equal(sfm.name, 'pms-card-explore-step');
  assert.ok(sfm.model && sfm.description && Array.isArray(sfm.tools));
  assert.match(step, /画面操作はカードが示す `pms act` だけで行い/);
});

test('check: 入口のエージェントとカードのエージェントの食い違い・欠け・余分を skills_in_sync が検出する。ほかのエージェントには触れない', () => {
  const root = tmpRepo();
  assert.equal(build(root).code, 0);
  fs.writeFileSync(path.join(root, '.github/agents/my-own.agent.md'), '---\nname: my-own\n---\n利用者のエージェント\n');
  let c = build(root, '--check');
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /16 個のエージェント/);

  const runner = path.join(root, '.github/agents/pms-runner.agent.md');
  fs.appendFileSync(runner, '\n6. カードの作業も自分でしてよい\n');
  c = build(root, '--check');
  assert.equal(c.code, 1);
  assert.match(c.err, /不一致 \.github\/agents\/pms-runner\.agent\.md/);

  fs.rmSync(path.join(root, '.kiro/agents/pms-runner.json'));
  fs.writeFileSync(path.join(root, '.kiro/agents/pms-card-old-kind.json'), '{}');
  c = build(root, '--check');
  assert.match(c.err, /なし {3}\.kiro\/agents\/pms-runner\.json/);
  assert.match(c.err, /余分 {3}\.kiro\/agents\/pms-card-old-kind\.json/);

  // lint skills_in_sync(pre-commit と同じ検査)も同じ指摘を出す
  const l = spawnSync(process.execPath, [path.join(REAL_ROOT, 'tools/lint/lint.mjs'), '--root', root, '--rule', 'skills_in_sync', '--json'], { encoding: 'utf8' });
  assert.equal(l.status, 1, l.stdout + l.stderr);
  const msgs = JSON.parse(l.stdout).results.flatMap((x) => x.findings.map((f) => f.message));
  assert.ok(msgs.some((m) => m.includes('pms-runner.agent.md')), msgs.join('\n'));

  // 再生成で直り、利用者のエージェントは残る
  assert.equal(build(root).code, 0);
  assert.equal(build(root, '--check').code, 0);
  assert.ok(fs.existsSync(path.join(root, '.github/agents/my-own.agent.md')));
  assert.ok(!fs.existsSync(path.join(root, '.kiro/agents/pms-card-old-kind.json')));
});

test('build: runner の名前がカードのエージェントの接頭辞と同じなら誤り(終了コード 1)', () => {
  const root = tmpRepo();
  const p = path.join(root, 'procedure/cards/agents.yaml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('  name: pms-runner', '  name: pms-card-runner'));
  const r = build(root);
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /runner\.name\(pms-card-runner\)がカードのエージェントの接頭辞と同じ/);
});
