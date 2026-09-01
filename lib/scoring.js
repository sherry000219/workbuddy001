/**
 * 评分引擎 —— 全局唯一实现（PRD FR-5）
 *
 * 后端 API、管理后台、排名页、静态页构建脚本必须全部调用本模块，
 * 严禁任何第二份实现（本届踩坑：算法被复制两份导致宣传页与排名页分数不一致）。
 *
 * 所有函数均为纯函数：db 显式传入，不依赖模块级状态，便于复用与单测。
 */

// 赛段评分配置（PRD FR-5：权重公式配置化）
// 默认值与本届线上行为完全一致，改动配置即可换赛制，无需改代码。
const DEFAULT_STAGE_CONFIG = {
  preliminary: { judgeWeight: 0.8, voteWeight: 0.2, inheritPrevWeight: 0, includeValueDim: false },
  semi_final: { judgeWeight: 0.8, voteWeight: 0.2, inheritPrevWeight: 0.4, includeValueDim: false },
  final: { judgeWeight: 1.0, voteWeight: 0, inheritPrevWeight: 0, includeValueDim: true },
  awarded: { judgeWeight: 1.0, voteWeight: 0, inheritPrevWeight: 0, includeValueDim: true }
};

function stageConf(stage, cfg) {
  const c = cfg || DEFAULT_STAGE_CONFIG;
  return c[stage] || c.preliminary;
}

/** 某作品在某赛段的原始打分与票数 */
function stageScores(db, entryId, stage, cfg) {
  const conf = stageConf(stage, cfg);
  // awarded 不是真实打分赛段，打分发生在 final
  const scoreStage = stage === 'awarded' ? 'final' : stage;
  const scores = (db.judgeScores || []).filter(
    s => s.entryId === entryId && (s.stage || 'preliminary') === scoreStage
  );
  const voteCount = (db.votes || []).filter(
    v => v.entryId === entryId && (v.stage || 'preliminary') === scoreStage
  ).length;
  const avgScore = scores.length > 0
    ? Math.round(
        scores.reduce(
          (sum, s) =>
            sum +
            (s.practicality || 0) +
            (s.innovation || 0) +
            (s.scalability || 0) +
            (conf.includeValueDim ? (s.value || 0) : 0) +
            (s.presentation || 0),
          0
        ) / scores.length
      )
    : 0;
  return { scores, voteCount, avgScore, judgeCount: scores.length };
}

/** 可投票作品集（决定投票分分母） */
function votableEntries(db, stage) {
  if (stage === 'preliminary') {
    return db.entries.filter(e => e.status === 'approved');
  }
  if (stage === 'semi_final') {
    return db.entries.filter(e =>
      ['semi_finalist', 'finalist', 'awarded', 'eliminated_final'].includes(e.roundStatus)
    );
  }
  return [];
}

/** 可评审作品集 */
function judgableEntries(db, stage) {
  if (stage === 'preliminary') {
    return db.entries.filter(e => e.status === 'approved');
  }
  if (stage === 'semi_final') {
    return db.entries.filter(e => e.roundStatus === 'semi_finalist');
  }
  if (stage === 'final' || stage === 'awarded') {
    return db.entries.filter(e => e.roundStatus === 'finalist' || e.roundStatus === 'awarded');
  }
  return [];
}

/**
 * 综合分
 * = 评委均分 × judgeWeight + 投票分 × voteWeight，再继承上一赛段 inheritPrevWeight
 * 投票分 = 本作品票数 / 该赛段最高票数 × 100
 */
function compositeScore(db, entryId, stage, cfg) {
  const conf = stageConf(stage, cfg);
  const { avgScore, voteCount } = stageScores(db, entryId, stage, cfg);

  let current;
  if (conf.voteWeight > 0) {
    const votable = votableEntries(db, stage);
    const allVoteCounts = votable.map(e => stageScores(db, e.id, stage, cfg).voteCount);
    const maxVotes = Math.max(1, ...allVoteCounts, voteCount);
    const voteScore = (voteCount / maxVotes) * 100;
    current = Math.round((avgScore * conf.judgeWeight + voteScore * conf.voteWeight) * 100) / 100;
  } else {
    current = avgScore;
  }

  if (conf.inheritPrevWeight > 0) {
    const prev = compositeScore(db, entryId, 'preliminary', cfg);
    return Math.round((prev * conf.inheritPrevWeight + current * (1 - conf.inheritPrevWeight)) * 100) / 100;
  }
  return current;
}

/** 该赛段是否开放投票 */
function isVotingStage(stage) {
  return stage === 'preliminary' || stage === 'semi_final';
}

module.exports = {
  DEFAULT_STAGE_CONFIG,
  stageScores,
  compositeScore,
  votableEntries,
  judgableEntries,
  isVotingStage
};
