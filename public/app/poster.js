// ========== Poster render helpers ==========
// 列表卡片用缩略图（走后端 /api/poster-thumb 服务端压缩），详情页用原图。
// 钉钉/钉盘等内网链接服务端无法访问，前端统一显示为「查看作品海报」按钮。

(function (root) {
  // 内网/需鉴权的链接：服务端抓不到，前端展示按钮
  const INTERNAL_HOSTS = [
    'alidocs.dingtalk.com', 'dingtalk.com', 'dingding.com',
    'doc.dingtalk.com', 'space.dingtalk.com', 'qr.dingtalk.com',
    'feishu.cn', 'larksuite.com',
    'docs.qq.com', 'doc.weixin.qq.com',
  ];

  function isInternal(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return INTERNAL_HOSTS.some(b => h === b || h.endsWith('.' + b));
    } catch (_) { return true; }
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 列表卡片上的海报图
   * - 钉钉等内网链接 → 「查看作品海报」按钮
   * - 公网图片 → /api/poster-thumb?url=... 服务端压缩后的缩略图
   *   加载失败 fallback 到原图，仍失败 fallback 到按钮
   */
  function renderPosterCard(url) {
    if (!url) return '';
    if (isInternal(url)) {
      return '<div style="width:100%;height:160px;border-radius:8px;margin-bottom:12px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;">' +
        '<a href="' + escAttr(url) + '" target="_blank" rel="noopener" style="color:#ff6b35;font-size:14px;text-decoration:none;">🖼️ 查看作品海报</a>' +
      '</div>';
    }
    var thumbSrc = '/api/poster-thumb?url=' + encodeURIComponent(url);
    var fallbackSrc = escAttr(url);
    var fallbackBtn =
      '<div style="width:100%;height:160px;border-radius:8px;margin-bottom:12px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;">' +
        '<a href="' + fallbackSrc + '" target="_blank" rel="noopener" style="color:#ff6b35;font-size:14px;text-decoration:none;">🖼️ 查看作品海报</a>' +
      '</div>';
    return '<img src="' + escAttr(thumbSrc) + '" loading="lazy" decoding="async" ' +
      'style="width:100%;height:160px;object-fit:cover;border-radius:8px;margin-bottom:12px;background:#f3f4f6;" ' +
      'alt="作品海报" ' +
      'onerror="this.onerror=null;this.src=\'' + fallbackSrc + '\';" ' +
      'onload2="' + '">' +
      '<noscript>' + fallbackBtn + '</noscript>';
  }

  /**
   * 详情页用原图（点开看大图，不压缩）
   */
  function renderPosterDetail(url) {
    if (!url) return '';
    if (isInternal(url)) {
      return '<div class="dvalue"><a href="' + escAttr(url) + '" target="_blank" rel="noopener" style="color:#ff6b35;word-break:break-all;">🖼️ 查看作品海报（钉盘）</a></div>';
    }
    return '<div class="dvalue">' +
      '<a href="' + escAttr(url) + '" target="_blank" rel="noopener" title="点击查看原图">' +
        '<img src="' + escAttr(url) + '" style="max-width:100%;max-height:480px;border-radius:8px;cursor:zoom-in;" alt="作品海报" ' +
        'onerror="this.onerror=null;this.outerHTML=\'<a href=&quot;' + escAttr(url) + '&quot; target=&quot;_blank&quot; rel=&quot;noopener&quot; style=&quot;color:#ff6b35;word-break:break-all;&quot;>🖼️ 查看作品海报</a>\'">' +
      '</a>' +
    '</div>';
  }

  root.PosterHelper = { renderPosterCard: renderPosterCard, renderPosterDetail: renderPosterDetail, isInternal: isInternal };
})(typeof window !== 'undefined' ? window : this);
