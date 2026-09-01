// 轻量桥接：在赛事应用页固定显示「返回云帐房赛事平台」入口
(function () {
  if (location.pathname.indexOf('/platform') !== -1) return;
  var btn = document.createElement('a');
  btn.href = '/';
  btn.textContent = '← 云帐房赛事平台';
  btn.setAttribute('style', 'position:fixed;left:14px;bottom:14px;z-index:9999;background:rgba(31,41,55,0.92);color:#fff;font-size:13px;font-weight:600;padding:9px 16px;border-radius:24px;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,0.2);');
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(btn); });
  // 若 body 已存在（脚本在末尾加载），直接追加
  if (document.body) document.body.appendChild(btn);
})();
