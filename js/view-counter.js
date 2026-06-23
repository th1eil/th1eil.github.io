/**
 * 博客文章浏览量统计
 * 策略：优先使用 countapi.xyz（无需注册的免费 API），
 *       网络失败时回落至 localStorage 计数。
 */
(function () {
  var viewsEl = document.getElementById('post-views');
  if (!viewsEl) return;

  var slug = viewsEl.getAttribute('data-slug');
  if (!slug) return;

  var countEl = document.getElementById('views-count');
  if (!countEl) return;

  var NAMESPACE = 'reistechblog';
  var STORAGE_KEY = 'vc_' + slug;

  /**
   * 更新页面上的计数值
   */
  function showCount(n) {
    countEl.textContent = Number(n).toLocaleString();
    viewsEl.style.visibility = 'visible';
  }

  /**
   * localStorage 回退：累计本浏览器中的访问次数
   */
  function fallbackLocalCount() {
    var stored = localStorage.getItem(STORAGE_KEY);
    var count = stored ? parseInt(stored, 10) : 0;
    count += 1;
    localStorage.setItem(STORAGE_KEY, String(count));
    showCount(count);
  }

  // 优先尝试 countapi.xyz
  var url = 'https://api.countapi.xyz/hit/' + NAMESPACE + '/' + encodeURIComponent(slug);
  fetch(url, { method: 'GET', cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      if (data && typeof data.value === 'number') {
        showCount(data.value);
      } else {
        fallbackLocalCount();
      }
    })
    .catch(function () {
      fallbackLocalCount();
    });
})();
