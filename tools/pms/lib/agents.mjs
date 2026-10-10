// agents.mjs — カードの種類ごとのエージェント(procedure/cards/agents.yaml。build-skills.mjs が生成する)の名前・モデルと、カードを渡す依頼文
//
// pms run(B2: CLI の --agent)と pms next(B1: 入口のエージェント pms-runner がサブエージェントに渡す)が同じものを使う。

/** 入口のエージェント(B1)の名前。build-skills.mjs が procedure/cards/agents.yaml の runner から生成する */
export const RUNNER_AGENT = 'pms-runner';

/**
 * カードの種類のエージェント・モデル・追加の使用禁止。runner は pms run の CLI の名前(copilot / kiro / claude など。B1 では省く)。
 * モデルと使用禁止は CLI ごとに書き方が違うため、CLI ごとの値を先に見る:
 *   モデル: config の cardTypes.<種類>.runners.<CLI>.model → agents.yaml の kinds.<種類>.<CLI>_model(kiro_model・claude_model)
 *          → config の cardTypes.<種類>.model → agents.yaml の kinds.<種類>.model(Copilot のモデルの候補)
 *   使用禁止: cardTypes.<種類>.runners.<CLI>.deny → cardTypes.<種類>.deny(使用禁止のパターンは config にだけ書く)
 */
export function cardType(ctx, kind, runner = null) {
  const a = ctx.proc.agents?.kinds?.[kind] ?? {};
  const c = ctx.cfg.cardTypes?.[kind] ?? {};
  const r = (runner && c.runners?.[runner]) || {};
  const models = r.model ?? (runner ? a[`${runner}_model`] : undefined) ?? c.model ?? a.model ?? [];
  return {
    agent: r.agent ?? c.agent ?? agentName(kind),
    model: (Array.isArray(models) ? models : [models]).filter(Boolean)[0] ?? '',
    deny: r.deny ?? c.deny ?? [],
  };
}

/** カードの種類のエージェントの名前(build-skills.mjs が生成するファイルの名前と同じ) */
export function agentName(kind) { return `pms-card-${kind.replace(/[._]/g, '-')}`; }

/** セッション・サブエージェントに渡す依頼文(短く固定。カードの本文はファイルのパスで渡す。コマンドラインの長さ・AIの写し間違いに頼らない) */
export function promptOf(flow, card, cardFile) {
  return `あなたは進行役 pms が出したカード ${card}(${flow})だけを行う。まず ${cardFile} を読み、その指示どおりに行い、`
    + 'カードの「終わったら」のコマンド(pms submit)で提出する。提出が不合格なら、返された理由のところだけを直して再提出する。'
    + '合格したら終わる。カードの外の作業をしない。';
}
