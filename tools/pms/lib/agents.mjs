// agents.mjs — カードの種類ごとのエージェント(procedure/cards/agents.yaml。build-skills.mjs が生成する)の名前・モデルと、カードを渡す依頼文
//
// pms run(B2: CLI の --agent)と pms next(B1: 入口のエージェント pms-runner がサブエージェントに渡す)が同じものを使う。

/** 入口のエージェント(B1)の名前。build-skills.mjs が procedure/cards/agents.yaml の runner から生成する */
export const RUNNER_AGENT = 'pms-runner';

/**
 * カードの種類のエージェント・モデル・追加の使用禁止。エージェントとモデルは config の cardTypes が procedure/cards/agents.yaml より優先。
 * 使用禁止のパターンは CLI ごとに書き方が違うため、config(runner.<名前>.deny と cardTypes.<種類>.deny)にだけ書く
 */
export function cardType(ctx, kind) {
  const a = ctx.proc.agents?.kinds?.[kind] ?? {};
  const c = ctx.cfg.cardTypes?.[kind] ?? {};
  const models = c.model ?? a.model ?? [];
  return {
    agent: c.agent ?? agentName(kind),
    model: (Array.isArray(models) ? models : [models]).filter(Boolean)[0] ?? '',
    deny: c.deny ?? [],
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
