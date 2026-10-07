#!/usr/bin/env node
// stub-playwright-cli.mjs — テスト用の playwright-cli の偽物(実物のブラウザを使わない)
//
// 画面は環境変数 PMS_STUB_DIR の page.json で決める:
//   { "url": "...", "refs": { "e3": { "locator": "getByLabel('ユーザーID')", "count": 1, "visible": true, "text": "…", "next_url": "…" } },
//     "fail": ["e99"] }
// 呼び出しは PMS_STUB_DIR/calls.jsonl に1行ずつ残す(引数を確かめるため)。
// 出力の形は playwright-cli に似せる(「### Ran Playwright code」と「- Page URL: …」。fill の値はそのまま出る)。

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PMS_STUB_DIR;
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.1.22'); process.exit(0); }
const pageFile = path.join(dir, 'page.json');
const page = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const [session, cmd, ...rest] = args;
if (!/^-s=F-\d{3}$/.test(session)) { console.error(`bad session ${session}`); process.exit(2); }
const save = () => fs.writeFileSync(pageFile, JSON.stringify(page));
const state = () => `### Page state\n- Page URL: ${page.url}\n`;
const ref = (r) => page.refs?.[r];

switch (cmd) {
  case 'open':
  case 'goto':
    page.url = rest[0];
    save();
    console.log(`### Ran Playwright code\n\`\`\`js\nawait page.goto('${rest[0]}');\n\`\`\`\n${state()}`);
    break;
  case 'screenshot': {
    const f = rest.find((a) => a.startsWith('--filename='));
    if (!f) { console.error('no --filename'); process.exit(2); }
    fs.mkdirSync(path.dirname(f.slice(11)), { recursive: true });
    fs.writeFileSync(f.slice(11), 'PNG');
    console.log(`### Result\nScreenshot saved to ${f.slice(11)}\n${state()}`);
    break;
  }
  case 'snapshot':
    console.log(`${state()}### Snapshot\n- textbox "ユーザーID" [ref=e3]: ${page.typed ?? ''}\n- button "ログイン" [ref=e7]`);
    break;
  case 'generate-locator': {
    const r = ref(rest[0]);
    if (!r) { console.error(`ref ${rest[0]} not found`); process.exit(1); }
    console.log(r.locator);
    break;
  }
  case 'run-code': {
    const js = rest[0];
    const loc = Object.values(page.refs ?? {}).find((r) => js.includes(r.locator));
    let result;
    if (js.includes('page.url()')) result = JSON.stringify(page.url);
    else if (js.includes('.count()')) result = String(loc?.count ?? 0);
    else if (js.includes('isVisible()')) result = String(js.includes('!(') ? !(loc?.visible) : !!loc?.visible);
    else if (js.includes('textContent()')) {
      const m = js.match(/includes\('(.*)'\)/);
      result = String((loc?.text ?? '').includes(m ? m[1] : '\u0000'));
    } else {
      if (loc?.next_url) { page.url = loc.next_url; save(); }
      console.log(`### Ran Playwright code\n\`\`\`js\n${js}\n\`\`\`\n${state()}`);
      break;
    }
    console.log(`### Result\n${result}\n`);
    break;
  }
  default: {
    const r = ref(rest[0]);
    if (!r || (page.fail ?? []).includes(rest[0])) { console.error(`Error: element ${rest[0]} is not attached`); process.exit(1); }
    if (r.next_url) page.url = r.next_url;
    if (cmd === 'fill') page.typed = rest[1];
    save();
    const method = cmd === 'fill' ? `fill('${rest[1]}')` : cmd === 'select' ? `selectOption('${rest[1]}')` : `${cmd}()`;
    console.log(`### Ran Playwright code\n\`\`\`js\nawait page.${r.locator}.${method};\n\`\`\`\n${state()}`);
  }
}
