/**
 * 赛事结构配置（PRD FR-3 赛道与分组管理）
 *
 * 本届踩坑：赛道被硬编码为 efficiency/creative/business 三处，
 * 导致 track='other' 的 3 个作品在任何分组里都匹配不上、被静默丢弃（38 显示成 35）。
 *
 * 治理：
 *  1. 赛道集中配置（后续可改为从 DB 读取、后台编辑）
 *  2. 保留 other 兜底赛道，任何未归类作品自动归入并计入 unclassified 计数
 *  3. 强制守恒校验：各分组之和必须等于总数，不等即报错（绝不静默丢数据）
 */

const CONTEST_CONFIG = {
  tracks: [
    { key: 'efficiency', label: '🚀 效率提升赛道', short: '效率', color: '#ff6b35', enabled: true },
    { key: 'creative', label: '💡 创意设计赛道', short: '创意', color: '#7c3aed', enabled: true },
    { key: 'business', label: '🤝 业务赋能赛道', short: '业务', color: '#2563eb', enabled: true },
    // 兜底赛道：报名时未归入上述赛道的作品自动落到这里，保证不被丢弃
    { key: 'other', label: '🧩 其他', short: '其他', color: '#6b7280', enabled: true, fallback: true }
  ],
  // 团队是独立分组维度（按 entryType 判定），与赛道正交
  teamGroup: { key: 'team', label: '👥 团队组', short: '团队', color: '#f59e0b', enabled: true }
};

function getTracks() {
  return (CONTEST_CONFIG.tracks || []).filter(t => t.enabled !== false);
}

function getTeamGroup() {
  return CONTEST_CONFIG.teamGroup;
}

function findTrack(key) {
  return getTracks().find(t => t.key === key);
}

function fallbackTrack() {
  return getTracks().find(t => t.fallback) || getTracks()[getTracks().length - 1];
}

function trackLabel(key) {
  if (key === getTeamGroup().key) return getTeamGroup().label;
  const t = findTrack(key);
  return t ? t.label : (fallbackTrack() ? fallbackTrack().label : key);
}

function trackColor(key) {
  if (key === getTeamGroup().key) return getTeamGroup().color;
  const t = findTrack(key);
  return t ? t.color : '#6b7280';
}

/**
 * 按赛道/团队分组，并强制守恒校验
 * @returns {{team:Array, byTrack:Object, unclassified:number, conservation:{ok:boolean,total:number,sum:number}}}
 */
function groupEntries(entries) {
  const list = entries || [];
  const tracks = getTracks();
  const team = [];
  const byTrack = {};
  tracks.forEach(t => { byTrack[t.key] = []; });

  let unclassified = 0;
  list.forEach(e => {
    if (e.entryType === 'team') { team.push(e); return; }
    const t = tracks.find(x => x.key === e.track);
    if (t) { byTrack[t.key].push(e); return; }
    // 未归类 → 落入兜底赛道，绝不丢弃
    const fb = fallbackTrack();
    if (fb) { byTrack[fb.key].push(e); }
    unclassified++;
  });

  const sum = team.length + Object.keys(byTrack).reduce((a, k) => a + byTrack[k].length, 0);
  const conservation = { ok: sum === list.length, total: list.length, sum };
  return { team, byTrack, unclassified, conservation };
}

/**
 * 守恒校验：各分组之和必须等于总数
 * @returns {{ok:boolean, total:number, sum:number, missing:Array}}
 */
function checkConservation(entries, groups) {
  const list = entries || [];
  const sum = (groups || []).reduce((a, g) => a + ((g && g.items ? g.items : g) || []).length, 0);
  if (sum === list.length) return { ok: true, total: list.length, sum, missing: [] };
  // 找出被漏掉的作品
  const seen = new Set();
  (groups || []).forEach(g => ((g && g.items ? g.items : g) || []).forEach(e => seen.add(e.id)));
  const missing = list.filter(e => !seen.has(e.id));
  return { ok: false, total: list.length, sum, missing };
}

module.exports = {
  CONTEST_CONFIG,
  getTracks,
  getTeamGroup,
  findTrack,
  fallbackTrack,
  trackLabel,
  trackColor,
  groupEntries,
  checkConservation
};
