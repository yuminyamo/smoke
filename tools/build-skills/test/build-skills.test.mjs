// build-skills.test.mjs — 生成スクリプトのテスト: カードの種類ごとのエージェントと入口のエージェント(IDE 内のループ B1。段3 proc-v019)、
//   Claude Code への生成と外部操作 skill の写し(proc-v026)
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
  // 外部操作 skill の原本(skills.config.json の external_skills)。ほかの生成先へは生成スクリプトが写す
  const ext = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'procedure/skills.config.json'), 'utf8')).external_skills;
  for (const name of ext?.names ?? []) fs.cpSync(path.join(REAL_ROOT, ext.source, name), path.join(root, ext.source, name), { recursive: true });
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

test('build: 入口のエージェント pms-runner とカードの種類ごとのエージェントを Copilot・Kiro・Claude Code に生成する', () => {
  const root = tmpRepo();
  const r = build(root);
  assert.equal(r.code, 0, r.out + r.err);
  const kinds = cardKinds();
  for (const k of kinds) {
    assert.ok(fs.existsSync(path.join(root, '.github/agents', `${cardAgent(k)}.agent.md`)), k);
    assert.ok(fs.existsSync(path.join(root, '.kiro/agents', `${cardAgent(k)}.json`)), k);
    assert.ok(fs.existsSync(path.join(root, '.claude/agents', `${cardAgent(k)}.md`)), k);
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

  // Claude Code: 入口は Agent(<カードのエージェント>, …) だけを呼べる。本文は Copilot と同じ
  const cmd = fs.readFileSync(path.join(root, '.claude/agents/pms-runner.md'), 'utf8');
  const cfm = frontmatter(cmd);
  assert.equal(cfm.name, 'pms-runner');
  assert.equal(cfm.tools, `Bash, Agent(${kinds.map(cardAgent).join(', ')})`);
  assert.equal(cmd.replace(/^---\n[\s\S]*?\n---\n/, ''), md.replace(/^---\n[\s\S]*?\n---\n/, ''));

  // Claude Code のカードのエージェント: 使用禁止を disallowedTools に書く(種類だけの禁止も足す)
  const cstep = frontmatter(fs.readFileSync(path.join(root, '.claude/agents/pms-card-explore-step.md'), 'utf8'));
  assert.equal(cstep.name, 'pms-card-explore-step');
  assert.equal(cstep.tools, 'Read, Edit, Write, Grep, Glob, Bash');
  assert.ok(cstep.disallowedTools.includes('Bash(sqlcmd *)'), cstep.disallowedTools.join(' '));
  assert.ok(cstep.disallowedTools.includes('Bash(npx *)'));
  assert.ok(cstep.disallowedTools.includes('Edit(procedure/**)'));
  assert.ok(cstep.disallowedTools.includes('Edit(.claude/agents/**)'));
  const ccode = frontmatter(fs.readFileSync(path.join(root, '.claude/agents/pms-card-setup-code.md'), 'utf8'));
  assert.ok(!ccode.disallowedTools.includes('Bash(npx *)'));
});

test('build: skills を Claude Code にも生成し、手動の skill には disable-model-invocation を付ける', () => {
  const root = tmpRepo();
  assert.equal(build(root).code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'procedure/skills.config.json'), 'utf8'));
  for (const name of [cfg.router.name, ...cfg.skills.map((s) => s.name)]) {
    const gh = fs.readFileSync(path.join(root, '.github/skills', name, 'SKILL.md'), 'utf8');
    const cl = fs.readFileSync(path.join(root, '.claude/skills', name, 'SKILL.md'), 'utf8');
    // 違ってよいのは、本文に差し込む生成先のパスだけ
    assert.equal(cl.replaceAll('.claude/skills', '.github/skills'), gh, `${name}: Claude Code 用と Copilot 用の SKILL.md が生成先のパスのほかでも違う`);
  }
  const manual = cfg.skills.find((s) => s.invocation === 'manual');
  assert.equal(frontmatter(fs.readFileSync(path.join(root, '.claude/skills', manual.name, 'SKILL.md'), 'utf8'))['disable-model-invocation'], true);
});

test('外部操作 skill: 原本をほかの生成先へバイト単位で写し、写しの食い違い・欠け・余分を --check が検出する', () => {
  const root = tmpRepo();
  const { source, names } = JSON.parse(fs.readFileSync(path.join(root, 'procedure/skills.config.json'), 'utf8')).external_skills;
  assert.equal(build(root).code, 0);
  const name = names[0];
  const files = fs.readdirSync(path.join(root, source, name), { recursive: true }).filter((f) => fs.statSync(path.join(root, source, name, f)).isFile());
  for (const dir of ['.kiro/skills', '.claude/skills']) {
    for (const f of files) assert.ok(fs.readFileSync(path.join(root, dir, name, f)).equals(fs.readFileSync(path.join(root, source, name, f))), `${dir}/${name}/${f}`);
  }

  // 写しを直接直すと NG。余分なファイルも NG
  fs.appendFileSync(path.join(root, '.claude/skills', name, 'SKILL.md'), '\n写しだけの追記\n');
  fs.writeFileSync(path.join(root, '.kiro/skills', name, 'extra.txt'), 'x');
  let c = build(root, '--check');
  assert.equal(c.code, 1);
  assert.match(c.err, new RegExp(`不一致 \\.claude/skills/${name}/SKILL\\.md`));
  assert.match(c.err, new RegExp(`余分 {3}\\.kiro/skills/${name}/extra\\.txt`));

  // 原本を直して再生成すると、写しも原本に合う
  fs.appendFileSync(path.join(root, source, name, 'SKILL.md'), '\n原本の追記\n');
  assert.equal(build(root).code, 0);
  assert.equal(build(root, '--check').code, 0);
  assert.match(fs.readFileSync(path.join(root, '.claude/skills', name, 'SKILL.md'), 'utf8'), /原本の追記/);
  assert.ok(!fs.existsSync(path.join(root, '.kiro/skills', name, 'extra.txt')));

  // 原本がなければ誤り
  fs.rmSync(path.join(root, source, name), { recursive: true });
  const r = build(root);
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /外部操作 skill の原本 .+ がありません/);
});

test('check: 入口のエージェントとカードのエージェントの食い違い・欠け・余分を skills_in_sync が検出する。ほかのエージェントには触れない', () => {
  const root = tmpRepo();
  assert.equal(build(root).code, 0);
  fs.writeFileSync(path.join(root, '.github/agents/my-own.agent.md'), '---\nname: my-own\n---\n利用者のエージェント\n');
  let c = build(root, '--check');
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /24 個のエージェント/);

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
