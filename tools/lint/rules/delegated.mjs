// delegated.mjs — 実装済みのスクリプトを呼び出す規則
//   skills_in_sync(build-skills.mjs --check)/ prohibition_recheck(prohibited-ops.mjs --compare)
//   env_restored(skill restore-golden-image 同梱の Test-EnvRestoreMarker.ps1)

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), error: r.error };
}

function lines(s) {
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ════════════════════════════════════════════════════════
export function skills_in_sync(repo) {
  const script = 'tools/build-skills/build-skills.mjs';
  if (!repo.exists(script)) return { findings: [{ file: script, message: '生成スクリプトがありません' }] };
  const r = run(process.execPath, [repo.abs(script), '--check', '--root', repo.root], repo.root);
  if (r.code === 0) return { findings: [], notes: lines(r.out) };
  const msg = lines(r.err || r.out);
  // 生成スクリプトの出力のうち、ファイルごとの差分の行(なし / 不一致 / 余分)を指摘にする
  const diffs = msg.filter((m) => /^(なし|不一致|余分)\s/.test(m));
  const picked = diffs.length ? diffs.map((d) => `${d}(正本から再生成していない、または生成物を直接編集した)`) : msg;
  return { findings: (picked.length ? picked : [`終了コード ${r.code}`]).map((m) => ({ file: script, message: m })) };
}

// ════════════════════════════════════════════════════════
export function prohibition_recheck(repo) {
  const findings = [];
  const notes = [];
  const script = 'tools/checks/prohibited-ops.mjs';
  const flows = [...new Set(repo.statusFiles.filter((s) => (s.stage === '10' || s.stage === '20') && s.flow && repo.inFlow(s.flow)).map((s) => s.flow))].sort();

  for (const f of flows) {
    const st20 = repo.statusFor('20', f);
    const checkDone = repo.stage === '20' || (repo.stage !== '10' && st20.length > 0);
    if (checkDone) {
      // 作業20まで進んだフロー: 作業20の開始前に照合したこと(status.yaml の prohibition_check: ok)
      for (const s of st20) {
        if (!s.data) continue;
        if (String(s.data.prohibition_check ?? '') !== 'ok') {
          findings.push({ file: s.rel, message: `prohibition_check が ok ではありません(${s.data.prohibition_check ?? 'なし'})。作業20の開始前に禁止操作リストを照合していない` });
        }
      }
      continue;
    }
    // 作業20の前: 作業10の status.yaml と現在の禁止操作リストを照合する
    if (!repo.exists(script)) { findings.push({ file: script, message: '照合スクリプトがありません' }); continue; }
    for (const s of repo.statusFor('10', f)) {
      if (!s.data) continue;
      const v = String(s.data.procedure_version ?? '');
      const n = Number(v.match(/^proc-v(\d{3})$/)?.[1] ?? NaN);
      if (Number.isFinite(n) && n < 4) { notes.push(`${s.rel}: ${v} で始めたフローのため照合しません(proc-v004 より前)`); continue; }
      const r = run(process.execPath, [repo.abs(script), '--compare', repo.abs(s.rel), '--root', repo.root], repo.root);
      if (r.code === 0) notes.push(`${s.rel}: ${lines(r.err)[0] ?? '照合 OK'}`);
      else if (r.code === 3) findings.push({ file: s.rel, message: `禁止操作リストが作業10のあとで変わっています。作業20を始めず、作業10のパートP(禁止操作の再判定)へ戻す — ${lines(r.err).join(' ')}` });
      else findings.push({ file: s.rel, message: `照合できません(終了コード ${r.code}) — ${lines(r.err || r.out).join(' ')}` });
    }
  }
  return { findings, notes };
}

// ════════════════════════════════════════════════════════
const MARKER_SCRIPTS = [
  '.github/skills/restore-golden-image/scripts/Test-EnvRestoreMarker.ps1',
  '.kiro/skills/restore-golden-image/scripts/Test-EnvRestoreMarker.ps1',
  '.claude/skills/restore-golden-image/scripts/Test-EnvRestoreMarker.ps1',
];

function findPowerShell() {
  const cands = process.platform === 'win32' ? ['pwsh', 'powershell.exe'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

export function env_restored(repo) {
  const targets = repo.statusFiles.filter((s) => (s.stage === '10' || s.stage === '20')
    && (!repo.stage || s.stage === repo.stage) && repo.inFlow(s.flow) && s.data);
  if (targets.length === 0) return { findings: [], notes: ['対象の status.yaml(作業10・20)がありません'] };
  const script = MARKER_SCRIPTS.find((p) => repo.exists(p));
  if (!script) return { findings: [], skipped: 'skill restore-golden-image(Test-EnvRestoreMarker.ps1)が配置されていません' };
  const ps = findPowerShell();
  if (!ps) return { findings: [], skipped: 'PowerShell(pwsh)が見つかりません' };

  const findings = [];
  const notes = [];
  for (const s of targets) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', repo.abs(script),
      '-StatusFile', repo.abs(s.rel), '-Purpose', `work${s.stage}`];
    if (fs.existsSync(repo.abs('work'))) args.push('-WorkRoot', repo.abs('work'));
    const r = run(ps, args, repo.root);
    const out = lines(r.out);
    if (r.code === 0) { notes.push(out[0] ?? `${s.rel}: OK`); continue; }
    const ng = out.filter((l) => l.startsWith('NG'));
    for (const l of ng.length ? ng : [`終了コード ${r.code} ${r.err}`]) findings.push({ file: s.rel, message: l });
  }
  return { findings, notes };
}
