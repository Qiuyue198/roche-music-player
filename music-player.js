(function () {
  'use strict';

  // ==================== 调试日志收集（APK/移动端排查用） ====================
  var debugLogs = [];
  function pushDebug(level, args) {
    var parts = Array.prototype.map.call(args || [], function (a) {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    });
    var line = '[' + new Date().toLocaleTimeString() + '][' + level + '] ' + parts.join(' ');
    debugLogs.push(line);
    if (debugLogs.length > 500) debugLogs.shift();
  }
  try {
    var _origLog = window.console.log.bind(window.console);
    var _origWarn = window.console.warn.bind(window.console);
    var _origErr = window.console.error.bind(window.console);
    window.console.log = function () { pushDebug('LOG', arguments); _origLog.apply(null, arguments); };
    window.console.warn = function () { pushDebug('WARN', arguments); _origWarn.apply(null, arguments); };
    window.console.error = function () { pushDebug('ERR', arguments); _origErr.apply(null, arguments); };
    window.addEventListener('error', function (e) {
      pushDebug('WINERR', [e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)]);
    });
  } catch (e) {}

  // ==================== 全局状态 ====================
  var BUILD_TIME = '2026-07-31-v1.16.10';
  var STATE = {
    roche: null,              // roche API 实例
    audio: null,              // 单个 HTMLAudioElement 实例
    playlist: [],             // 播放队列
    currentIndex: -1,         // 当前播放索引
    currentSong: null,        // 当前歌曲对象
    isPlaying: false,         // 是否正在播放
    playMode: 'list',         // 播放模式: list | one | random
    volume: 0.8,              // 音量 0~1
    lyrics: [],               // 解析后的主歌词 [{time, text}]
    tlyrics: [],              // 解析后的翻译歌词 [{time, text}]
    currentLyricIndex: -1,    // 当前歌词行索引
    cookie: '',               // 网易云 cookie
    backend: 'https://456.chajianreader.cc.cd', // 后端地址（CF Worker，网易云直连接口自动转发到Vercel）
    mcpBackend: 'https://ncm.chajianreader.cc.cd', // 网易云 MCP 服务器（HTTPS 直连腾讯云，扫码登录+开放平台API）
    mcpToken: '',             // MCP 服务器 accessToken（扫码登录后获取）
    defaultSource: 'netease', // 默认音源
    quality: 'standard',      // 音质
    // 灵动岛相关
    islandEl: null,
    islandExpanded: false,
    islandStyleEl: null,
    islandRefs: {},
    islandCleanups: [],
    // App 相关
    appContainer: null,
    appStyleEl: null,
    appRefs: {},
    appCleanups: [],
    currentTab: 'netease',    // 当前标签页
    searchResults: [],        // 搜索结果
    isSearching: false,
    // 定时器
    qrPollTimer: null,
    // audio 事件清理
    audioCleanups: [],
    // iOS 音频解锁状态
    audioUnlocked: false,
    // 灵动岛距顶部偏移（CSS 变量驱动）
    islandTop: 8,
    // 灵动岛是否显示
    islandVisible: true,
    // 灵动岛未点开状态滚动展示模式：title（歌名）或 lyric（歌词）
    islandScrollMode: 'title',
    // 灵动岛最小化（本地状态，不持久化）
    islandMinimized: false,
    // 灵动岛主动关闭（关闭按钮触发），关闭后contextProvider停止注入，可被点歌唤醒
    islandClosed: false,
    // 歌词注入模式：false=仅当前前后5行，true=全部歌词+标注当前10行范围
    lyricsFullInject: false,
    // char 点歌音源：netease（网易云个人）| gd（第三方音乐源）
    charSource: 'netease',
    // 网易云播放 URL 缓存（songId -> {url, ts}），避免每次播放都重新请求 /play
    songUrlCache: {},
    initialized: false
  };

  // ==================== 工具函数 ====================

  // 格式化时间 (秒 -> m:ss)
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  // LRC 歌词解析
  function parseLrc(lrcText) {
    if (!lrcText) return [];
    var lines = lrcText.split('\n');
    var result = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
      if (match) {
        var min = parseInt(match[1], 10);
        var sec = parseInt(match[2], 10);
        var ms = parseInt(match[3].padEnd(3, '0'), 10);
        var time = min * 60 + sec + ms / 1000;
        result.push({ time: time, text: match[4].trim() });
      }
    }
    return result.sort(function (a, b) { return a.time - b.time; });
  }

  // 获取当前歌词索引
  function getCurrentLyricIndex(lrcArray, currentTime) {
    for (var i = lrcArray.length - 1; i >= 0; i--) {
      if (currentTime >= lrcArray[i].time) return i;
    }
    return -1;
  }

  // HTML 转义
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // http → https 升级（封面等资源在 HTTPS 页面必须为 https，否则混合内容被拦截）
  function toHttps(url) {
    if (!url) return url;
    url = String(url);
    if (url.indexOf('http://') === 0) url = 'https://' + url.substring(7);
    return url;
  }
  // 判断是否为完整资源 URL（避免把 picId 等纯ID直接当 img src）
  function isFullUrl(url) {
    if (!url) return false;
    url = String(url);
    return url.indexOf('http://') === 0 || url.indexOf('https://') === 0 || url.indexOf('//') === 0;
  }

  // 获取翻译歌词文本（按时间匹配）
  function getTranslatedText(time) {
    if (!STATE.tlyrics || STATE.tlyrics.length === 0) return '';
    var idx = getCurrentLyricIndex(STATE.tlyrics, time);
    if (idx >= 0) return STATE.tlyrics[idx].text;
    return '';
  }

  // ==================== API 层 ====================

  // 通用 API 请求
  function api(action, params) {
    params = params || {};
    var url = STATE.backend.replace(/\/+$/, '') + '/music?action=' + encodeURIComponent(action);
    Object.keys(params).forEach(function (key) {
      url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    // 网易云已改为直连 music.163.com，不再通过 GD 后端中转
    var headers = { 'Accept': 'application/json' };
    return fetch(url, { headers: headers }).then(function (res) { return res.json(); });
  }

  // 网易云 API（通过 VPS 代理，避免 CORS）
  function neteaseApi(path, data, method) {
    method = method || 'GET';
    var fullUrl = 'https://music.163.com' + path;
    var proxyUrl = STATE.mcpBackend.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(fullUrl);
    var fetchOpts = {
      method: method,
      headers: { 'X-Netease-Cookie': STATE.cookie }
    };
    if (data && method === 'POST') {
      if (typeof data === 'object') {
        var pairs = [];
        Object.keys(data).forEach(function(k) { pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k])); });
        fetchOpts.body = pairs.join('&');
      } else {
        fetchOpts.body = String(data);
      }
      fetchOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    console.log('[neteaseApi]', method, proxyUrl, fetchOpts.body || '');
    var fetchPromise = fetch(proxyUrl, fetchOpts).then(function(r) {
      return r.text().then(function(text) {
        console.log('[neteaseApi 响应原文]', method, path, 'HTTP', r.status, '长度=' + text.length, text.substring(0, 600));
        try {
          var json = JSON.parse(text);
          console.log('[neteaseApi 响应]', method, path, json);
          return json;
        } catch (e) {
          console.error('[neteaseApi JSON解析失败]', text.substring(0, 600));
          throw e;
        }
      });
    });
    // 加 20 秒超时：避免 VPS/网络慢导致请求无限挂起、界面"毫无反应"
    var timeoutPromise = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('neteaseApi 请求超时: ' + path)); }, 20000);
    });
    return Promise.race([fetchPromise, timeoutPromise]).catch(function(e) {
      console.error('[neteaseApi 失败]', method, path, e.message || e);
      throw e;
    });
  }
  
  // 从 Cookie 提取 __csrf
  function getNeCsrf() {
    if (!STATE.cookie) return '';
    var parts = STATE.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('__csrf=') === 0) return p.substring(7);
    }
    return '';
  }

  // 搜索音乐 —— 全平台 / 单源轮询（网易云最多重试10次）
  function searchMusic(keywords, source, limit) {
    limit = limit || 20;

    function normalizeSong(s) {
      var rawId = String(s.id || s.mediaId || '');
      var cleanId = rawId.indexOf(':') >= 0 ? rawId.split(':').pop() : rawId;
      var artist = Array.isArray(s.artist) ? s.artist.join(' / ') : (s.artist || s.singer || '');
      function fixProtocol(val) {
        if (!val) return val;
        val = String(val);
        if (val.indexOf('//') === 0) val = 'https:' + val;
        return val;
      }
      var picId = fixProtocol(s.picId || s.pic_id || s.picId) || cleanId;
      var lyricId = fixProtocol(s.lyricId || s.lyric_id || s.lyricId) || cleanId;
      return Object.assign({}, s, {
        id: cleanId, artist: artist, singer: artist,
        picId: picId, lyricId: lyricId,
        platform: s.platform || s.source || 'joox'
      });
    }

    // 单源轮询：最多重试 maxRetries 次
    function pollSingle(src, retries, maxRetries) {
      retries = retries || 0;
      maxRetries = maxRetries || 4;
      // 网易云走GD后端
      if (src === 'netease') {
        return api('search', { source: src, keywords: keywords, limit: limit }).then(function (data) {
          var songs = data.songs || data.results || [];
          if (songs.length > 0) return songs.map(function (s) { return normalizeSong(s); });
          if (retries < maxRetries) {
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(pollSingle(src, retries + 1, maxRetries)); }, 800 + retries * 400);
            });
          }
          return [];
        }).catch(function () {
          if (retries < maxRetries) {
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(pollSingle(src, retries + 1, maxRetries)); }, 800 + retries * 400);
            });
          }
          return [];
        });
      }
      // GD API 单源搜索
      return api('search', { source: src, keywords: keywords, limit: limit }).then(function (data) {
        var songs = data.songs || data.results || [];
        if (songs.length > 0) return songs.map(function (s) { return normalizeSong(s); });
        if (retries < maxRetries) {
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(pollSingle(src, retries + 1, maxRetries)); }, 800 + retries * 400);
          });
        }
        return [];
      }).catch(function () {
        if (retries < maxRetries) {
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(pollSingle(src, retries + 1, maxRetries)); }, 800 + retries * 400);
          });
        }
        return [];
      });
    }

    // 全平台 search_all
    function pollSearchAll(retries) {
      retries = retries || 0;
      var MAX = 4;
      var count = retries === 0 ? 1 : 2;
      var reqs = [];
      for (var i = 0; i < count; i++) {
        reqs.push(api('search_all', { keywords: keywords, limit: limit }));
      }
      return Promise.all(reqs).then(function (responses) {
        for (var j = 0; j < responses.length; j++) {
          var data = responses[j];
          if (data.merged && data.merged.length) return data.merged.map(function (s) { return normalizeSong(s); });
          var all = data.all || {};
          var results = [];
          ['netease', 'joox'].forEach(function (p) {
            if (all[p]) all[p].forEach(function (s) { results.push(normalizeSong(s)); });
          });
          if (results.length > 0) return results;
        }
        if (retries < MAX) {
          return new Promise(function (resolve) { setTimeout(function () { resolve(pollSearchAll(retries + 1)); }, 600); });
        }
        return [];
      });
    }

    // 根据来源分发（全部走GD后端）
    if (source === 'netease') {
      return pollSingle('netease', 0, 4).then(function (songs) {
        return filterPlayable(songs);
      });
    }
    if (source === 'joox') {
      return pollSingle('joox', 0, 4).then(function (songs) {
        return filterPlayable(songs);
      });
    }
    // 全平台
    return pollSearchAll(0).then(function (songs) {
      return filterPlayable(songs);
    });
  }

  // 判断是否纯音乐（按歌名关键词）：纯音乐无需歌词即可播放
  function isInstrumental(name) {
    if (!name) return false;
    var n = String(name).toLowerCase();
    return /纯音乐|伴奏|instrumental|piano|钢琴曲|钢琴独奏|bgm|ost|原声|pure\s*music|acappella|阿卡贝拉/.test(n);
  }

  // 过滤不可播放/无歌词歌曲
  // netease 源：搜索到基本都能播放，跳过预查询，直接保留（仅标记纯音乐）
  // joox 源：并发检查歌词和播放链接；普通歌曲需两者都有，纯音乐仅需播放链接
  // 排序：netease 优先于 joox
  function filterPlayable(songs) {
    if (!songs || songs.length === 0) return Promise.resolve([]);
    var checks = songs.map(function (song) {
      var source = song.platform || 'joox';
      var instrumental = isInstrumental(song.name);
      // netease 源跳过预查询，直接保留
      if (source === 'netease') {
        song._hasLyric = true;
        song._hasUrl = true;
        song._isInstrumental = instrumental;
        song._playable = true;
        return Promise.resolve(song);
      }
      var lyricId = song.lyricId || song.id;
      var cleanId = String(song.id).indexOf(':') >= 0 ? String(song.id).split(':').pop() : String(song.id);
      // joox 源并发检查歌词和播放链接
      return Promise.all([
        getLyric(lyricId, source).then(function (d) { return d.lyric && d.lyric.trim().length > 10; }).catch(function () { return false; }),
        getSongUrl(cleanId, source).then(function (url) { return !!url; }).catch(function () { return false; })
      ]).then(function (r) {
        song._hasLyric = r[0];
        song._hasUrl = r[1];
        song._isInstrumental = instrumental;
        song._playable = instrumental ? r[1] : (r[0] && r[1]);
        return song;
      });
    });
    function process(all) {
      var playable = all.filter(function (s) { return s._playable; });
      playable.sort(function (a, b) {
        if (a.platform === 'netease' && b.platform !== 'netease') return -1;
        if (a.platform !== 'netease' && b.platform === 'netease') return 1;
        return 0;
      });
      playable.forEach(function (s) {
        s.instrumental = s._isInstrumental; // 保留标记，供歌词区显示「纯音乐」
        delete s._hasLyric; delete s._hasUrl; delete s._playable; delete s._isInstrumental;
      });
      return playable;
    }
    return Promise.allSettled ? Promise.allSettled(checks).then(function (results) {
      var all = [];
      results.forEach(function (r) { if (r.status === 'fulfilled') all.push(r.value); });
      return process(all);
    }) : Promise.all(checks).then(process);
  }

  // 获取播放 URL（统一走 Vercel 后端，支持所有音源）
  function getSongUrl(id, source, quality, isPersonal) {
    var cleanId = String(id).indexOf(':') >= 0 ? String(id).split(':').pop() : String(id);
    var br = quality || STATE.quality;
    if (isPersonal && STATE.cookie && (source === 'netease')) {
      // 播放 URL 缓存：10 分钟内同一首歌直接复用，避免重复请求 /play（VPS weapi 较慢）
      var cacheKey = 'ne:' + cleanId;
      var cached = STATE.songUrlCache && STATE.songUrlCache[cacheKey];
      if (cached && cached.url && (Date.now() - cached.ts < 10 * 60 * 1000)) {
        console.log('[getSongUrl 个人网易云-weapi] 命中缓存 songId=' + cleanId);
        return Promise.resolve(cached.url);
      }
      // weapi 方案（NeteaseCloudMusicApi）：VPS /play 接口返回 weapi_url，
      // weapi 生成的播放 URL 不绑定数据中心 IP（VPS 已验证可拉取 200）
      var playUrl = STATE.mcpBackend.replace(/\/+$/, '') + '/play?id=' + encodeURIComponent(cleanId);
      console.log('[getSongUrl 个人网易云-weapi] songId=' + cleanId + ' playUrl=' + playUrl);
      return fetch(playUrl).then(function (r) { return r.json(); }).then(function (data) {
        var weapiUrl = data && data.weapi_url ? data.weapi_url : '';
        if (!weapiUrl) {
          console.error('[getSongUrl 个人网易云-weapi] 未返回weapi_url', data);
          return '';
        }
        // 经 VPS 代理拉取音频流（VPS 已验证可拉 200），前端流式播放
        var url = STATE.mcpBackend.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(weapiUrl);
        console.log('[getSongUrl 个人网易云-weapi] weapi_url=' + weapiUrl + ' proxy=' + url);
        STATE.songUrlCache[cacheKey] = { url: url, ts: Date.now() };
        return url;
      }).catch(function (e) {
        console.error('[getSongUrl 个人网易云-weapi] 失败', e.message || e);
        return '';
      });
    }
    return api('song_url', { id: cleanId, source: source, br: br }).then(function (data) {
      var url = data.url || '';
      if (url && url.indexOf('http://') === 0) url = url.replace('http://', 'https://');
      return url;
    });
  }

  // 带降级重试的获取播放 URL（非网易云音源，从高到低尝试不同码率）
  function getSongUrlFallback(id, source) {
    var cleanId = String(id).indexOf(':') >= 0 ? String(id).split(':').pop() : String(id);
    // 优先用用户选择的音质，失败则降级到 standard
    var qualities = [STATE.quality];
    if (STATE.quality !== 'standard') qualities.push('standard');
    // 去重
    var seen = {};
    qualities = qualities.filter(function (q) { if (seen[q]) return false; seen[q] = true; return true; });

    function tryNext(idx) {
      if (idx >= qualities.length) return Promise.resolve('');
      var br = qualities[idx];
      return api('song_url', { id: cleanId, source: source, br: br }).then(function (data) {
        var url = data.url && data.url.indexOf('http://') === 0 ? data.url.replace('http://', 'https://') : data.url;
        if (url) return url;
        return tryNext(idx + 1);
      }).catch(function () {
        return tryNext(idx + 1);
      });
    }
    return tryNext(0);
  }

  // 获取专辑图
  // 网易云源优先走官方API（第三方音乐源返回的cover URL已全部404），其他源走GD pic
  function getPicUrl(picId, source) {
    if (!picId) return Promise.resolve('');
    var cleanId = String(picId).indexOf(':') >= 0 ? String(picId).split(':').pop() : String(picId);
    if (source === 'netease') {
      return getNeteaseCover(cleanId).then(function (url) {
        return url || '';
      });
    }
    return api('pic', { id: cleanId, source: source }).then(function (data) {
      return data.url || '';
    }).catch(function () { return ''; });
  }

  // 通过网易云官方API获取歌曲封面URL（通过VPS代理，避免CORS）
  function getNeteaseCover(songId) {
    return neteaseApi('/api/song/detail?ids=%5B' + encodeURIComponent(songId) + '%5D').then(function (data) {
      if (data && data.code === 200 && data.songs && data.songs[0] && data.songs[0].al) {
        // picUrl 返回 http://，HTTPS 页面混合内容会被拦截，必须升级为 https
        return toHttps(data.songs[0].al.picUrl) || '';
      }
      return '';
    }).catch(function () { return ''; });
  }

  // 通过 GD pic 接口把图片ID转成真实封面URL
  // 网易云图片ID → p2.music.126.net/{picId}.jpg（实测200），joox → image.joox.com（实测200）
  // 注意：仅接受图片ID（搜索接口返回的 picId），不要传歌曲ID（GD pic 按歌曲ID拼出的URL是404）
  function fetchPicByPicId(picId, platform) {
    if (!picId) return Promise.resolve('');
    var cleanId = String(picId).indexOf(':') >= 0 ? String(picId).split(':').pop() : String(picId);
    return api('pic', { id: cleanId, source: platform || 'joox' }).then(function (data) {
      var u = data.url || '';
      return isFullUrl(u) ? toHttps(u) : '';
    }).catch(function () { return ''; });
  }

  // 搜索结果渲染后：为没有完整封面的歌曲异步补封面（picId → 真实URL）
  // 拉到后写入 song.cover 缓存，避免列表重渲染时重复请求
  function hydrateSearchCovers(container, songs) {
    if (!container || !songs || songs.length === 0) return;
    var items = container.querySelectorAll('.rmp-song-item');
    for (var i = 0; i < songs.length; i++) {
      (function (idx) {
        var song = songs[idx];
        if (isFullUrl(song.cover) || isFullUrl(song.picId)) return; // 已有完整URL
        var picId = song.picId || song.id;
        if (!picId) return;
        fetchPicByPicId(picId, song.platform || 'joox').then(function (url) {
          if (!url || !STATE.searchResults || STATE.searchResults[idx] !== song) return; // 列表已变化，放弃
          song.cover = url;
          var item = items[idx];
          if (!item || !item.isConnected) return;
          var holder = item.querySelector('.rmp-song-cover');
          if (!holder) return;
          if (holder.tagName === 'IMG') {
            holder.src = url;
          } else {
            var img = document.createElement('img');
            img.className = 'rmp-song-cover';
            img.src = url;
            img.alt = '';
            holder.replaceWith(img);
          }
        }).catch(function () {});
      })(i);
    }
  }

  // 获取歌词（统一走 Vercel 后端）
  function getLyric(lyricId, source, isPersonal) {
    if (!lyricId) return Promise.resolve({ lyric: '', tlyric: '' });
    var cleanId = String(lyricId).indexOf(':') >= 0 ? String(lyricId).split(':').pop() : String(lyricId);
    if (isPersonal && STATE.cookie && (source === 'netease')) {
      return neteaseApi('/api/song/lyric?id=' + encodeURIComponent(cleanId) + '&lv=1&kv=1&tv=-1').then(function(resp) {
        var lrc = (resp.lrc || {}).lyric || '';
        var tlyric = (resp.tlyric || {}).lyric || '';
        return { lyric: lrc, tlyric: tlyric };
      });
    }
    return api('lyric', { id: cleanId, source: source }).then(function (data) {
      return { lyric: data.lyric || data.lrc || '', tlyric: data.tlyric || '' };
    });
  }

  // 网易云 MCP 服务器 API 调用（HTTPS 直连腾讯云）
  function mcpApi(endpoint, params) {
    params = params || {};
    var url = STATE.mcpBackend.replace(/\/+$/, '') + '/' + endpoint;
    var qs = Object.keys(params).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    if (qs) url += '?' + qs;
    return fetch(url).then(function(r) { return r.json(); });
  }

  function getQrLogin() {
    return mcpApi('login/start');
  }

  // 检查扫码状态
  function checkQrLogin(key) {
    return mcpApi('login/check');
  }

  // ==================== 音频引擎 ====================

  // 初始化音频元素
  function initAudio() {
    if (STATE.audio) return;
    STATE.audio = new Audio();
    STATE.audio.volume = STATE.volume;
    // iOS 内联播放支持
    STATE.audio.setAttribute('playsinline', 'true');
    STATE.audio.setAttribute('webkit-playsinline', 'true');

    // 播放事件
    function onPlay() {
      console.log('[audio] play 事件触发', STATE.currentSong ? STATE.currentSong.name : '无');
      STATE.isPlaying = true;
      // 任何成功的播放都意味着音频已解锁
      STATE.audioUnlocked = true;
      updatePlayStateUI();
      updateMediaSession();
    }
    // 暂停事件
    function onPause() {
      STATE.isPlaying = false;
      updatePlayStateUI();
    }
    // 时间更新事件
    function onTimeUpdate() {
      updateProgressUI();
      updateLyricsUI();
    }
    // 播放结束事件
    function onEnded() {
      handleSongEnd();
    }
    // 元数据加载事件
    function onLoadedMetadata() {
      console.log('[audio] loadedmetadata 触发 duration=' + STATE.audio.duration);
      updateProgressUI();
    }
    // 错误事件
    var audioRetryCount = 0;
    function onError() {
      console.error('[audio] error 事件触发', STATE.audio.error ? STATE.audio.error.code : '无错误码', STATE.audio.src);
      var song = STATE.currentSong;
      // 第一次错误，尝试降级到 standard 码率重试（仅非网易云登录音源）
      if (audioRetryCount === 0 && song && (!song.platform || song.platform !== 'netease' || !STATE.cookie)) {
        audioRetryCount = 1;
        getSongUrl(song.id, song.platform || 'joox', 'standard').then(function (url) {
          if (STATE.currentSong !== song || !url) {
            audioRetryCount = 0;
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放出错，请尝试其他歌曲');
            return;
          }
          STATE.audio.src = url;
          STATE.audio.play().catch(function () {
            audioRetryCount = 0;
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放出错，请尝试其他歌曲');
          });
        }).catch(function () {
          audioRetryCount = 0;
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放出错，请尝试其他歌曲或音源');
        });
        return;
      }
      audioRetryCount = 0;
      // 直接 URL 加载失败：尝试 fetch→blob 备用播放（诊断 CDN 返回内容 + 绕过混合内容限制）
      if (song && STATE.audio.src && !STATE._blobFallbackTried) {
        STATE._blobFallbackTried = true;
        fetchBlobAndPlay(STATE.audio.src);
        return;
      }
      if (STATE.roche && STATE.roche.ui) {
        STATE.roche.ui.toast('播放出错，请尝试其他歌曲或音源');
      }
      updatePlayStateUI();
    }

    STATE.audio.addEventListener('play', onPlay);
    STATE.audio.addEventListener('pause', onPause);
    STATE.audio.addEventListener('timeupdate', onTimeUpdate);
    STATE.audio.addEventListener('ended', onEnded);
    STATE.audio.addEventListener('loadedmetadata', onLoadedMetadata);
    STATE.audio.addEventListener('error', onError);

    STATE.audioCleanups.push(function () {
      STATE.audio.removeEventListener('play', onPlay);
      STATE.audio.removeEventListener('pause', onPause);
      STATE.audio.removeEventListener('timeupdate', onTimeUpdate);
      STATE.audio.removeEventListener('ended', onEnded);
      STATE.audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      STATE.audio.removeEventListener('error', onError);
    });

    // iOS 音频解锁：监听 document 第一次 touchend/click，播放后立即暂停以解锁
    function unlockAudio() {
      if (STATE.audioUnlocked || !STATE.audio) return;
      STATE.audioUnlocked = true;
      document.removeEventListener('touchend', unlockAudio);
      document.removeEventListener('click', unlockAudio);
      // 仅在音频处于暂停状态时执行解锁，避免干扰正在播放的音频
      if (!STATE.audio.paused) return;
      var p = STATE.audio.play();
      if (p && typeof p.then === 'function') {
        p.then(function () { STATE.audio.pause(); }).catch(function () {});
      }
    }
    document.addEventListener('touchend', unlockAudio);
    document.addEventListener('click', unlockAudio);
    STATE.audioCleanups.push(function () {
      document.removeEventListener('touchend', unlockAudio);
      document.removeEventListener('click', unlockAudio);
    });
  }

  // fetch 音频为 blob 后播放（带 Cookie 头，供个人网易云经代理拉取音频）
  // 说明：audio 元素无法设置自定义请求头，个人网易云播放必须走此路径，
  // 让代理带上 X-Netease-Cookie 转发给网易云 CDN 验证 VIP 权限
  function fetchBlobAndPlay(src, showToast) {
    if (!src) return;
    console.log('[audio] 尝试 fetch→blob 播放:', src);
    var fetchOpts = {};
    if (STATE.cookie) {
      fetchOpts.headers = { 'X-Netease-Cookie': STATE.cookie };
    }
    fetch(src, fetchOpts).then(function (r) {
      console.log('[audio] fetch 状态:', r.status, 'content-type:', r.headers.get('content-type'), 'content-length:', r.headers.get('content-length'));
      if (!r.ok) {
        console.error('[audio] fetch 非2xx:', r.status);
        if (showToast && STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('音频源返回 ' + r.status + '，无法播放');
        return;
      }
      return r.blob().then(function (blob) {
        console.log('[audio] blob 大小:', blob.size, 'type:', blob.type);
        if (!blob.size) {
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('音频为空，链接可能已过期');
          return;
        }
        // 返回的是HTML而非音频：打印内容定位原因
        var ct = blob.type || '';
        if (ct.indexOf('text/html') >= 0) {
          return blob.text().then(function (txt) {
            console.log('[audio] HTML内容:', txt.substring(0, 1000));
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('音频源返回HTML页面，无法播放');
          });
        }
        var objUrl = URL.createObjectURL(blob);
        STATE.audio.src = objUrl;
        var p = STATE.audio.play();
        if (p && typeof p.then === 'function') {
          p.then(function () {
            console.log('[audio] blob 播放成功');
            if (showToast && STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已通过备用方式播放');
          }).catch(function (e) {
            console.error('[audio] blob 播放失败:', e.message || e);
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放失败: ' + (e.message || '未知'));
          });
        }
      });
    }).catch(function (e) {
      console.error('[audio] fetch 失败:', e.message || e);
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('音频获取失败');
    });
  }

  // 播放指定歌曲
  function playSong(song, index) {
    if (!song) return;
    // iOS 未解锁时提示用户先点击解锁
    if (!STATE.audioUnlocked) {
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请先点击播放器任意位置解锁音频');
    }
    STATE.currentSong = song;
    if (typeof index === 'number') {
      STATE.currentIndex = index;
    }
    STATE._blobFallbackTried = false;
    STATE.lyrics = [];
    STATE.tlyrics = [];
    STATE.currentLyricIndex = -1;

    // 获取播放 URL（非网易云音源使用降级重试）
    var urlPromise;
    if (song._personal && STATE.cookie) {
      urlPromise = getSongUrl(song.id, 'netease', undefined, song._personal);
    } else if (song.platform === 'netease') {
      urlPromise = getSongUrlFallback(song.id, 'netease');
    } else {
      urlPromise = getSongUrlFallback(song.id, song.platform || STATE.defaultSource);
    }
    urlPromise.then(function (url) {
      // 竞态条件修复：如果在异步等待期间用户切换了歌曲，则放弃本次播放
      if (STATE.currentSong !== song) return;
      if (!url) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('无法获取播放链接，可能是版权限制');
        return;
      }
      console.log('[playSong] 设置音频源并播放:', url);
      if (song._personal && STATE.cookie) {
        // 个人网易云：优先 audio.src 直连流式播放（边下边播，换歌秒出）。
        // 若失败，onError 会自动回退到 fetch→blob（带 X-Netease-Cookie 头）
        STATE.audio.src = url;
        var playPromise = STATE.audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.then(function () {
            console.log('[playSong] 个人网易云 流式播放 resolve 成功');
          }).catch(function (e) {
            console.error('[playSong] 个人网易云 play() reject:', e && e.message ? e.message : e);
          });
        }
      } else {
        STATE.audio.src = url;
        var playPromise = STATE.audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.then(function () {
            console.log('[playSong] play() resolve 成功');
          }).catch(function (e) {
            console.error('[playSong] play() reject:', e && e.message ? e.message : e);
            // 未解锁时已在前面提示过，不再重复显示错误
            if (!STATE.audioUnlocked) return;
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放失败: ' + (e.message || '未知错误'));
          });
        }
      }
      // 加载歌词（使用 lyricId）
      loadLyrics(song);
      // 异步获取专辑封面
      // GD音乐台netease源封面URL全部404，需刷新（用song.id而非picId，因picId可能是图片URL）
      // 个人网易云封面直接来自API，有效跳过
      var needCoverRefresh = (song.platform === 'netease' && !song._personal) || (!song.cover && song.picId);
      var coverLookupId = song.platform === 'netease' ? song.id : song.picId;
      if (needCoverRefresh && coverLookupId) {
        getPicUrl(coverLookupId, song.platform || STATE.defaultSource).then(function (picUrl) {
          if (STATE.currentSong !== song) return;
          if (picUrl) {
            song.cover = picUrl;
            updateSongInfoUI();
            updateMediaSession();
          }
        });
      }
      // 更新所有 UI
      updateSongInfoUI();
      showIsland();
      // 后台预取下一首播放 URL（列表模式），切歌时命中缓存秒出
      prefetchNextSongUrl();
    }).catch(function (e) {
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('获取播放链接失败');
    });
  }

  // 预取下一首的播放 URL（仅列表模式的个人网易云歌曲，写入 songUrlCache）
  function prefetchNextSongUrl() {
    var list = STATE.playlist;
    if (!list || list.length === 0 || STATE.currentIndex < 0) return;
    if (STATE.playMode === 'random') return; // 随机模式下一首不确定
    var nextIdx = STATE.currentIndex + 1;
    if (nextIdx >= list.length) nextIdx = 0;
    var next = list[nextIdx];
    if (!next || !(next._personal && STATE.cookie)) return;
    var cleanId = String(next.id).indexOf(':') >= 0 ? String(next.id).split(':').pop() : String(next.id);
    var key = 'ne:' + cleanId;
    if (STATE.songUrlCache && STATE.songUrlCache[key]) return; // 已缓存
    getSongUrl(cleanId, 'netease', undefined, true).catch(function () {});
  }

  // 加载歌词（使用 lyricId，一般与 track_id 相同）
  function loadLyrics(song) {
    var lyricId = song.lyricId || song.id;
    getLyric(lyricId, song.platform || STATE.defaultSource, song._personal).then(function (data) {
      STATE.lyrics = parseLrc(data.lyric);
      STATE.tlyrics = parseLrc(data.tlyric);
      renderAppLyrics();
    }).catch(function () {
      STATE.lyrics = [];
      STATE.tlyrics = [];
      renderAppLyrics();
    });
  }

  // 切换播放/暂停
  function togglePlay() {
    if (!STATE.audio || !STATE.currentSong) return;
    if (STATE.isPlaying) {
      STATE.audio.pause();
    } else {
      STATE.audio.play().catch(function () {});
    }
  }

  // 播放下一首
  function playNext() {
    if (STATE.playlist.length === 0) return;
    var nextIndex;
    if (STATE.playMode === 'random') {
      nextIndex = Math.floor(Math.random() * STATE.playlist.length);
    } else {
      nextIndex = STATE.currentIndex + 1;
      if (nextIndex >= STATE.playlist.length) nextIndex = 0;
    }
    playSong(STATE.playlist[nextIndex], nextIndex);
  }

  // 播放上一首
  function playPrev() {
    if (STATE.playlist.length === 0) return;
    var prevIndex = STATE.currentIndex - 1;
    if (prevIndex < 0) prevIndex = STATE.playlist.length - 1;
    playSong(STATE.playlist[prevIndex], prevIndex);
  }

  // 歌曲播放结束处理
  function handleSongEnd() {
    if (STATE.playMode === 'one') {
      // 单曲循环
      STATE.audio.currentTime = 0;
      STATE.audio.play().catch(function () {});
    } else {
      playNext();
    }
  }

  // 跳转到指定时间
  // 流式播放时 audio.duration 可能是 NaN/Infinity，clamp 用 getSafeDuration 兜底
  function seek(time) {
    if (!STATE.audio) return;
    var dur = getSafeDuration();
    var target = dur > 0 ? Math.max(0, Math.min(time, dur)) : Math.max(0, time);
    STATE.audio.currentTime = target;
  }

  // 获取可用的播放时长（秒）：audio.duration → seekable 末尾 → 歌曲自带 duration
  // 个人网易云经 VPS proxy 流式播放时 duration 常为 NaN/Infinity，必须降级
  function getSafeDuration() {
    var a = STATE.audio;
    if (a) {
      var d = a.duration;
      if (typeof d === 'number' && isFinite(d) && d > 0) return d;
      if (a.seekable && a.seekable.length > 0) {
        var s = a.seekable.end(a.seekable.length - 1);
        if (typeof s === 'number' && isFinite(s) && s > 0) return s;
      }
    }
    var sd = STATE.currentSong ? STATE.currentSong.duration : 0;
    if (typeof sd === 'number' && isFinite(sd) && sd > 0) return sd;
    return 0;
  }

  // 设置音量
  function setVolume(v) {
    STATE.volume = Math.max(0, Math.min(1, v));
    if (STATE.audio) STATE.audio.volume = STATE.volume;
    saveSettings();
  }

  // 设置播放模式
  function setPlayMode(mode) {
    STATE.playMode = mode;
    updatePlayModeUI();
    saveSettings();
  }

  // 添加到播放列表
  function addToPlaylist(song) {
    // 避免重复添加
    for (var i = 0; i < STATE.playlist.length; i++) {
      if (STATE.playlist[i].id === song.id && STATE.playlist[i].platform === song.platform) {
        return i;
      }
    }
    STATE.playlist.push(song);
    renderPlaylistUI();
    savePlaylist();
    return STATE.playlist.length - 1;
  }

  // 从播放列表删除
  function removeFromPlaylist(index) {
    if (index < 0 || index >= STATE.playlist.length) return;
    STATE.playlist.splice(index, 1);
    if (index === STATE.currentIndex) {
      // 删除的是当前播放歌曲
      STATE.audio.pause();
      STATE.audio.src = '';
      STATE.currentSong = null;
      STATE.currentIndex = -1;
      hideIsland();
      updateSongInfoUI();
    } else if (index < STATE.currentIndex) {
      STATE.currentIndex--;
    }
    renderPlaylistUI();
    savePlaylist();
  }

  // 清空播放列表
  function clearPlaylist() {
    STATE.playlist = [];
    STATE.currentIndex = -1;
    STATE.currentSong = null;
    STATE.lyrics = [];
    STATE.tlyrics = [];
    if (STATE.audio) {
      STATE.audio.pause();
      STATE.audio.src = '';
    }
    hideIsland();
    updateSongInfoUI();
    renderPlaylistUI();
    savePlaylist();
  }

  // 持久化播放列表到 roche.storage（只保存必要字段）
  function savePlaylist() {
    if (!STATE.roche || !STATE.roche.storage) return;
    try {
      var minimal = STATE.playlist.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          artist: s.artist,
          album: s.album,
          cover: s.cover,
          platform: s.platform,
          picId: s.picId,
          lyricId: s.lyricId,
          duration: s.duration
        };
      });
      STATE.roche.storage.set('rmp_playlist', JSON.stringify(minimal));
    } catch (e) {}
  }

  // 更新 Media Session
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !STATE.currentSong) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: STATE.currentSong.name || '',
        artist: STATE.currentSong.artist || '',
        album: STATE.currentSong.album || '',
        artwork: STATE.currentSong.cover ? [{ src: STATE.currentSong.cover, sizes: '512x512', type: 'image/jpeg' }] : []
      });
      navigator.mediaSession.setActionHandler('play', function () { togglePlay(); });
      navigator.mediaSession.setActionHandler('pause', function () { togglePlay(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { playPrev(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { playNext(); });
      var msDur = getSafeDuration();
      if ('setPositionState' in navigator.mediaSession && STATE.audio && msDur > 0) {
        navigator.mediaSession.setPositionState({
          duration: msDur,
          position: STATE.audio.currentTime,
          playbackRate: STATE.audio.playbackRate
        });
      }
    } catch (e) {}
  }

  // ==================== 灵动岛 ====================

  // 灵动岛样式 —— iPhone 灵动岛风格 + 网易云精致美学
  function getIslandStyles() {
    return '\
#rmp-island {\
  position: fixed;\
  top: calc(var(--rmp-island-top, 8px) + env(safe-area-inset-top));\
  left: 50%;\
  transform: translateX(-50%);\
  z-index: 99999;\
  /* 深黑玻璃质感 */\
  background: rgba(18, 18, 18, 0.86);\
  -webkit-backdrop-filter: blur(28px) saturate(200%);\
  backdrop-filter: blur(28px) saturate(200%);\
  /* 真·胶囊圆角（iPhone 灵动岛风格）*/\
  border-radius: 44px;\
  /* 多层次精致阴影 + 顶部光泽 */\
  box-shadow:\
    0 6px 30px rgba(0, 0, 0, 0.5),\
    0 0 0 0.5px rgba(255, 255, 255, 0.1),\
    inset 0 0.5px 0 rgba(255, 255, 255, 0.06);\
  color: #fff;\
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;\
  cursor: pointer;\
  user-select: none;\
  -webkit-user-select: none;\
  touch-action: pan-y;\
  overflow: hidden;\
  max-height: 46px;\
  width: auto;\
  min-width: 136px;\
  max-width: 196px;\
  /* iPhone 风格 spring 动画 */\
  transition: max-height 0.5s cubic-bezier(0.16, 1, 0.3, 1),\
              width 0.5s cubic-bezier(0.16, 1, 0.3, 1),\
              max-width 0.5s cubic-bezier(0.16, 1, 0.3, 1),\
              border-radius 0.5s cubic-bezier(0.16, 1, 0.3, 1),\
              opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1),\
              transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);\
  opacity: 1;\
}\
#rmp-island.rmp-island-hidden {\
  opacity: 0;\
  transform: translateX(-50%) translateY(-120%);\
  pointer-events: none;\
}\
#rmp-island.rmp-island-expanded {\
  max-height: 244px;\
  width: 312px;\
  max-width: 312px;\
  border-radius: 32px;\
}\
/* 最小化 */\
#rmp-island.rmp-island-minimized {\
  max-height: 3px;\
  min-height: 3px;\
  width: 72px;\
  min-width: 72px;\
  max-width: 72px;\
  border-radius: 1.5px;\
  opacity: 0.4;\
  cursor: pointer;\
  overflow: hidden;\
  transition: max-height 0.35s ease, width 0.35s ease, max-width 0.35s ease, min-width 0.35s ease, border-radius 0.35s ease;\
}\
#rmp-island.rmp-island-minimized .rmp-island-pill,\
#rmp-island.rmp-island-minimized .rmp-island-expanded-content {\
  display: none;\
}\
@media (max-width: 600px) {\
  #rmp-island {\
    max-width: 168px;\
    min-width: 116px;\
  }\
  #rmp-island.rmp-island-expanded {\
    width: 86vw;\
    max-width: 86vw;\
  }\
}\
/* 胶囊内容区 */\
.rmp-island-pill {\
  display: flex;\
  align-items: center;\
  gap: 7px;\
  padding: 7px 9px;\
  height: 46px;\
  box-sizing: border-box;\
}\
/* 封面：微光泽，带阴影 */\
.rmp-island-cover {\
  width: 30px;\
  height: 30px;\
  border-radius: 7px;\
  object-fit: cover;\
  flex-shrink: 0;\
  background: rgba(255,255,255,0.06);\
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);\
}\
.rmp-island-cover.rmp-spinning {\
  animation: rmp-island-spin 10s linear infinite;\
}\
@keyframes rmp-island-spin {\
  from { transform: rotate(0deg); }\
  to { transform: rotate(360deg); }\
}\
.rmp-island-info {\
  flex: 1;\
  overflow: hidden;\
  min-width: 0;\
  position: relative;\
}\
.rmp-island-scroll-text {\
  font-size: 12px;\
  font-weight: 500;\
  letter-spacing: -0.01em;\
  white-space: nowrap;\
  overflow: hidden;\
  line-height: 30px;\
  position: relative;\
}\
.rmp-island-scroll-inner {\
  display: inline-block;\
  padding-right: 36px;\
  animation: rmp-scroll-left 14s linear infinite;\
}\
@keyframes rmp-scroll-left {\
  0% { transform: translateX(0); }\
  100% { transform: translateX(-100%); }\
}\
/* 播放/暂停按钮 —— 极度低调 */\
.rmp-island-play-btn {\
  width: 22px;\
  height: 22px;\
  flex-shrink: 0;\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  border-radius: 50%;\
  background: transparent;\
  cursor: pointer;\
  opacity: 0.28;\
  border: none;\
  padding: 0;\
  transition: opacity 0.3s ease, transform 0.15s ease;\
}\
.rmp-island-play-btn:hover {\
  opacity: 0.6;\
}\
.rmp-island-play-btn:active {\
  transform: scale(0.85);\
}\
.rmp-island-play-btn svg {\
  width: 10px;\
  height: 10px;\
  fill: #fff;\
  opacity: 0.85;\
}\
/* 关闭按钮 —— 极度低调 */\
.rmp-island-close {\
  width: 22px;\
  height: 22px;\
  flex-shrink: 0;\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  border-radius: 50%;\
  background: transparent;\
  cursor: pointer;\
  opacity: 0.25;\
  transition: opacity 0.3s ease, background 0.2s ease, transform 0.15s ease;\
}\
.rmp-island-close:hover {\
  opacity: 0.6;\
  background: rgba(255, 72, 72, 0.2);\
}\
.rmp-island-close:active {\
  transform: scale(0.85);\
}\
.rmp-island-close svg {\
  width: 10px;\
  height: 10px;\
  fill: #fff;\
  opacity: 0.85;\
}\
/* 展开内容区 */\
.rmp-island-expanded-content {\
  padding: 0 14px 12px;\
  opacity: 0;\
  transform: translateY(4px);\
  transition: opacity 0.35s ease 0.12s, transform 0.35s ease 0.12s;\
}\
#rmp-island.rmp-island-expanded .rmp-island-expanded-content {\
  opacity: 1;\
  transform: translateY(0);\
}\
.rmp-island-lyrics {\
  text-align: center;\
  padding: 6px 0 8px;\
}\
.rmp-lyric-prev,\
.rmp-lyric-next {\
  font-size: 11px;\
  opacity: 0.3;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 2px 0;\
  line-height: 1.5;\
}\
.rmp-lyric-current {\
  font-size: 14px;\
  font-weight: 600;\
  letter-spacing: -0.01em;\
  color: #ff3b3b;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 4px 0;\
  line-height: 1.5;\
}\
.rmp-lyric-current-translation {\
  font-size: 11px;\
  opacity: 0.55;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 1px 0;\
}\
/* 进度条 —— 极细精致 */\
.rmp-island-progress {\
  height: 2px;\
  background: rgba(255, 255, 255, 0.08);\
  border-radius: 1px;\
  margin-top: 6px;\
  cursor: pointer;\
  position: relative;\
  overflow: visible;\
}\
.rmp-island-progress::before {\
  content: "";\
  position: absolute;\
  inset: -8px 0;\
}\
.rmp-island-progress-fill {\
  height: 100%;\
  background: linear-gradient(90deg, #ff3b3b, #ff6b6b);\
  border-radius: 1px;\
  width: 0%;\
  transition: width 0.15s linear;\
  position: relative;\
}\
.rmp-island-progress-fill::after {\
  content: "";\
  position: absolute;\
  right: -3px;\
  top: 50%;\
  transform: translateY(-50%);\
  width: 6px;\
  height: 6px;\
  background: #fff;\
  border-radius: 50%;\
  opacity: 0;\
  transition: opacity 0.2s;\
  box-shadow: 0 0 6px rgba(255, 59, 59, 0.4);\
}\
.rmp-island-progress:hover .rmp-island-progress-fill::after {\
  opacity: 1;\
}\
.rmp-island-time {\
  display: flex;\
  justify-content: space-between;\
  font-size: 10px;\
  font-weight: 500;\
  opacity: 0.4;\
  margin-top: 5px;\
  letter-spacing: 0.02em;\
}\
/* 长按播放列表浮窗 */\
.rmp-island-playlist-popup {\
  position: fixed;\
  z-index: 99998;\
  background: rgba(18, 18, 18, 0.93);\
  -webkit-backdrop-filter: blur(24px) saturate(180%);\
  backdrop-filter: blur(24px) saturate(180%);\
  border-radius: 18px;\
  box-shadow: 0 8px 36px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.08);\
  max-height: 260px;\
  overflow-y: auto;\
  -webkit-overflow-scrolling: touch;\
  min-width: 200px;\
  max-width: 270px;\
  padding: 6px;\
  opacity: 0;\
  transform: scale(0.92) translateY(-8px);\
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);\
  pointer-events: none;\
}\
.rmp-island-playlist-popup.visible {\
  opacity: 1;\
  transform: scale(1) translateY(0);\
  pointer-events: auto;\
}\
.rmp-island-playlist-popup::-webkit-scrollbar { width: 3px; }\
.rmp-island-playlist-popup::-webkit-scrollbar-track { background: transparent; }\
.rmp-island-playlist-popup::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }\
.rmp-island-pl-item {\
  display: flex;\
  align-items: center;\
  gap: 8px;\
  padding: 8px 10px;\
  border-radius: 12px;\
  cursor: pointer;\
  transition: background 0.12s ease;\
  font-size: 12px;\
  color: rgba(255, 255, 255, 0.75);\
  white-space: nowrap;\
  overflow: hidden;\
}\
.rmp-island-pl-item:active {\
  background: rgba(255, 255, 255, 0.1);\
}\
.rmp-island-pl-item.current {\
  color: #ff3b3b;\
  font-weight: 600;\
}\
.rmp-island-pl-item .rmp-pl-num {\
  width: 20px;\
  text-align: center;\
  font-size: 11px;\
  opacity: 0.4;\
  flex-shrink: 0;\
}\
.rmp-island-pl-item.current .rmp-pl-num {\
  opacity: 1;\
}\
.rmp-island-pl-item .rmp-pl-name {\
  flex: 1;\
  overflow: hidden;\
  text-overflow: ellipsis;\
}\
.rmp-island-pl-item .rmp-pl-dot {\
  width: 5px;\
  height: 5px;\
  border-radius: 50%;\
  background: #ff3b3b;\
  flex-shrink: 0;\
  opacity: 0;\
}\
.rmp-island-pl-item.current .rmp-pl-dot {\
  opacity: 1;\
}\
';
  }

  // 创建灵动岛
  function createIsland() {
    if (STATE.islandEl) return;

    // 注入样式
    STATE.islandStyleEl = document.createElement('style');
    STATE.islandStyleEl.textContent = getIslandStyles();
    document.head.appendChild(STATE.islandStyleEl);

    // 创建 DOM
    var island = document.createElement('div');
    island.id = 'rmp-island';
    island.className = 'rmp-island-hidden';
    island.innerHTML = '\
      <div class="rmp-island-pill">\
        <img class="rmp-island-cover" alt="" />\
        <div class="rmp-island-info">\
          <div class="rmp-island-scroll-text"><span class="rmp-island-scroll-inner">未播放</span></div>\
        </div>\
        <button class="rmp-island-play-btn" title="播放/暂停">' + ICONS.play + '</button>\
        <div class="rmp-island-close" title="关闭灵动岛">\
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>\
        </div>\
      </div>\
      <div class="rmp-island-expanded-content">\
        <div class="rmp-island-lyrics">\
          <div class="rmp-lyric-prev"></div>\
          <div class="rmp-lyric-current"></div>\
          <div class="rmp-lyric-current-translation"></div>\
          <div class="rmp-lyric-next"></div>\
        </div>\
        <div class="rmp-island-progress">\
          <div class="rmp-island-progress-fill"></div>\
        </div>\
        <div class="rmp-island-time">\
          <span class="rmp-island-current-time">0:00</span>\
          <span class="rmp-island-duration">0:00</span>\
        </div>\
      </div>';

    document.body.appendChild(island);
    STATE.islandEl = island;
    // 设置灵动岛距顶部偏移的 CSS 变量（设到 :root 让 topbar 也能读到）
    island.style.setProperty('--rmp-island-top', STATE.islandTop + 'px');
    document.documentElement.style.setProperty('--rmp-island-top', STATE.islandTop + 'px');
    // 如果设置中关闭了灵动岛显示，则隐藏
    if (!STATE.islandVisible) {
      island.style.display = 'none';
    }

    // 缓存元素引用
    STATE.islandRefs = {
      cover: island.querySelector('.rmp-island-cover'),
      scrollText: island.querySelector('.rmp-island-scroll-text'),
      scrollInner: island.querySelector('.rmp-island-scroll-inner'),
      closeBtn: island.querySelector('.rmp-island-close'),
      playBtn: island.querySelector('.rmp-island-play-btn'),
      lyricPrev: island.querySelector('.rmp-lyric-prev'),
      lyricCurrent: island.querySelector('.rmp-lyric-current'),
      lyricTranslation: island.querySelector('.rmp-lyric-current-translation'),
      lyricNext: island.querySelector('.rmp-lyric-next'),
      progress: island.querySelector('.rmp-island-progress'),
      progressFill: island.querySelector('.rmp-island-progress-fill'),
      currentTime: island.querySelector('.rmp-island-current-time'),
      duration: island.querySelector('.rmp-island-duration'),
      pill: island.querySelector('.rmp-island-pill')
    };

    // 创建长按播放列表浮窗
    if (!STATE.islandPlaylistPopup) {
      STATE.islandPlaylistPopup = document.createElement('div');
      STATE.islandPlaylistPopup.className = 'rmp-island-playlist-popup';
      STATE.islandPlaylistPopup.style.display = 'none';
      document.body.appendChild(STATE.islandPlaylistPopup);
      // 点击浮窗外关闭
      function onDocClick(e) {
        if (STATE.islandPlaylistPopup && !STATE.islandPlaylistPopup.contains(e.target) && e.target !== island && !island.contains(e.target)) {
          hideIslandPlaylistPopup();
        }
      }
      document.addEventListener('click', onDocClick);
      STATE.islandCleanups.push(function () { document.removeEventListener('click', onDocClick); });
    }

    // 点击展开/收起（排除关闭、播放按钮和进度条）
    function onIslandClick(e) {
      // 点击关闭按钮：完全隐藏灵动岛（可被char点歌唤醒）
      if (e.target.closest('.rmp-island-close')) {
        e.stopPropagation();
        hideIsland();
        return;
      }
      // 点击播放/暂停按钮
      if (e.target.closest('.rmp-island-play-btn')) {
        e.stopPropagation();
        togglePlay();
        return;
      }
      // 如果点击的是进度条，不切换展开状态
      if (e.target.closest('.rmp-island-progress')) return;
      toggleIslandExpand();
    }
    island.addEventListener('click', onIslandClick);
    STATE.islandCleanups.push(function () {
      island.removeEventListener('click', onIslandClick);
    });

    // 进度条拖拽跳转（支持鼠标和触摸；流式播放 duration 无效时用 getSafeDuration 兜底）
    var isDraggingProgress = false;
    function progressSeekFromEvent(e) {
      if (!STATE.audio) return;
      var rect = STATE.islandRefs.progress.getBoundingClientRect();
      var clientX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      var x = clientX - rect.left;
      var percent = Math.max(0, Math.min(1, x / rect.width));
      var dur = getSafeDuration();
      seek(dur > 0 ? percent * dur : 0);
    }
    function onProgressStart(e) {
      e.stopPropagation();
      e.preventDefault();
      isDraggingProgress = true;
      progressSeekFromEvent(e);
      document.addEventListener('mousemove', onProgressMove);
      document.addEventListener('mouseup', onProgressEnd);
      document.addEventListener('touchmove', onProgressMove, { passive: false });
      document.addEventListener('touchend', onProgressEnd);
    }
    function onProgressMove(e) {
      if (!isDraggingProgress) return;
      e.preventDefault();
      progressSeekFromEvent(e);
    }
    function onProgressEnd() {
      isDraggingProgress = false;
      document.removeEventListener('mousemove', onProgressMove);
      document.removeEventListener('mouseup', onProgressEnd);
      document.removeEventListener('touchmove', onProgressMove);
      document.removeEventListener('touchend', onProgressEnd);
    }
    STATE.islandRefs.progress.addEventListener('mousedown', onProgressStart);
    STATE.islandRefs.progress.addEventListener('touchstart', onProgressStart, { passive: false });
    STATE.islandCleanups.push(function () {
      STATE.islandRefs.progress.removeEventListener('mousedown', onProgressStart);
      STATE.islandRefs.progress.removeEventListener('touchstart', onProgressStart);
    });

    // 移动端滑动切换歌曲 / 上下滑最小化 / 长按弹出播放列表
    var touchStartX = 0;
    var touchStartY = 0;
    var longPressTimer = null;
    var longPressFired = false;
    function onTouchStart(e) {
      if (e.touches && e.touches[0]) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
      // 排除关闭按钮、播放按钮和进度条上的长按
      if (e.target.closest('.rmp-island-close') || e.target.closest('.rmp-island-play-btn') || e.target.closest('.rmp-island-progress')) return;
      // 长按检测：600ms 后弹出播放列表浮窗
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        showIslandPlaylistPopup();
      }, 600);
    }
    function onTouchEnd(e) {
      clearTimeout(longPressTimer);
      if (longPressFired) return;
      if (!e.changedTouches || !e.changedTouches[0]) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      // 垂直滑动优先：上滑最小化，下滑从最小化恢复
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) {
        if (dy < 0 && !STATE.islandMinimized) {
          minimizeIsland();
          return;
        }
        if (dy > 0 && STATE.islandMinimized) {
          unminimizeIsland();
          return;
        }
      }
    }
    // 鼠标长按检测
    function onMouseDown(e) {
      if (e.target.closest('.rmp-island-close') || e.target.closest('.rmp-island-play-btn') || e.target.closest('.rmp-island-progress')) return;
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        showIslandPlaylistPopup();
      }, 600);
    }
    function onMouseUp() {
      clearTimeout(longPressTimer);
      if (longPressFired) {
        longPressFired = false;
      }
    }
    island.addEventListener('touchstart', onTouchStart, { passive: true });
    island.addEventListener('touchend', onTouchEnd, { passive: true });
    island.addEventListener('mousedown', onMouseDown);
    island.addEventListener('mouseup', onMouseUp);
    STATE.islandCleanups.push(function () {
      island.removeEventListener('touchstart', onTouchStart);
      island.removeEventListener('touchend', onTouchEnd);
      island.removeEventListener('mousedown', onMouseDown);
      island.removeEventListener('mouseup', onMouseUp);
      clearTimeout(longPressTimer);
    });

    // 设置初始播放图标
    updateIslandPlayIcon();
  }

  // 切换灵动岛展开/收起
  function toggleIslandExpand() {
    STATE.islandExpanded = !STATE.islandExpanded;
    if (STATE.islandExpanded) {
      STATE.islandEl.classList.add('rmp-island-expanded');
      hideIslandPlaylistPopup(); // 展开时关闭播放列表
    } else {
      STATE.islandEl.classList.remove('rmp-island-expanded');
    }
  }

  // 显示长按播放列表浮窗
  function showIslandPlaylistPopup() {
    if (!STATE.islandPlaylistPopup || STATE.playlist.length === 0) return;
    // 获取灵动岛位置
    var islandRect = STATE.islandEl.getBoundingClientRect();
    var popup = STATE.islandPlaylistPopup;
    // 渲染播放列表项
    var html = '';
    for (var i = 0; i < STATE.playlist.length; i++) {
      var s = STATE.playlist[i];
      var isCurrent = i === STATE.currentIndex;
      html += '<div class="rmp-island-pl-item' + (isCurrent ? ' current' : '') + '" data-index="' + i + '">';
      html += '<span class="rmp-pl-num">' + (isCurrent ? '♪' : (i + 1)) + '</span>';
      html += '<span class="rmp-pl-name">' + escapeHtml(s.name || '') + ' - ' + escapeHtml(s.artist || '') + '</span>';
      html += '<span class="rmp-pl-dot"></span>';
      html += '</div>';
    }
    popup.innerHTML = html;
    // 定位：灵动岛下方居中
    var top = islandRect.bottom + 8;
    var left = islandRect.left + islandRect.width / 2;
    // 确保不超出屏幕
    var pw = Math.min(270, islandRect.width + 40);
    popup.style.minWidth = Math.max(180, pw - 20) + 'px';
    popup.style.maxWidth = pw + 'px';
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
    popup.style.transform = 'translateX(-50%) scale(0.92) translateY(-8px)';
    popup.style.display = '';
    // 触发动画
    requestAnimationFrame(function () {
      popup.classList.add('visible');
    });
    // 点击项目切歌
    function onPopupClick(e) {
      var item = e.target.closest('.rmp-island-pl-item');
      if (!item) return;
      var idx = parseInt(item.getAttribute('data-index'), 10);
      if (!isNaN(idx) && STATE.playlist[idx]) {
        playSong(STATE.playlist[idx], idx);
      }
      hideIslandPlaylistPopup();
    }
    popup._clickHandler = onPopupClick;
    popup.addEventListener('click', onPopupClick);
    // 如果灵动岛先被收起了，一并隐藏
    STATE._popupVisible = true;
  }

  // 隐藏播放列表浮窗
  function hideIslandPlaylistPopup() {
    if (!STATE.islandPlaylistPopup) return;
    var popup = STATE.islandPlaylistPopup;
    popup.classList.remove('visible');
    if (popup._clickHandler) {
      popup.removeEventListener('click', popup._clickHandler);
      popup._clickHandler = null;
    }
    STATE._popupVisible = false;
    setTimeout(function () {
      if (!STATE._popupVisible && popup) popup.style.display = 'none';
    }, 250);
  }

  // 最小化灵动岛为顶部细线
  function minimizeIsland() {
    if (!STATE.islandEl) return;
    STATE.islandMinimized = true;
    STATE.islandEl.classList.add('rmp-island-minimized');
    STATE.islandEl.classList.remove('rmp-island-expanded');
    STATE.islandExpanded = false;
  }

  // 从最小化恢复
  function unminimizeIsland() {
    if (!STATE.islandEl) return;
    STATE.islandMinimized = false;
    STATE.islandEl.classList.remove('rmp-island-minimized');
  }

  // 显示灵动岛（播放时自动唤起）
  function showIsland() {
    if (STATE.islandEl) {
      STATE.islandEl.classList.remove('rmp-island-hidden');
      // 播放歌曲时自动从最小化恢复，并重置关闭状态
      unminimizeIsland();
      STATE.islandClosed = false;
    }
  }

  // 隐藏灵动岛（关闭按钮触发，同时停止播放）
  function hideIsland() {
    if (STATE.islandEl) {
      STATE.islandEl.classList.add('rmp-island-hidden');
      STATE.islandEl.classList.remove('rmp-island-expanded');
      STATE.islandExpanded = false;
      STATE.islandClosed = true;
      hideIslandPlaylistPopup();
    }
    // 停止播放并清空
    if (STATE.audio) {
      STATE.audio.pause();
      STATE.audio.src = '';
    }
    STATE.isPlaying = false;
    STATE.currentSong = null;
    STATE.lyrics = [];
    STATE.tlyrics = [];
    STATE.currentLyricIndex = -1;
    updatePlayStateUI();
    updateSongInfoUI();
  }

  // 更新灵动岛封面旋转状态（playIcon 已移除）
  function updateIslandPlayIcon() {
    if (STATE.islandRefs.cover) {
      if (STATE.isPlaying) {
        STATE.islandRefs.cover.classList.add('rmp-spinning');
      } else {
        STATE.islandRefs.cover.classList.remove('rmp-spinning');
      }
    }
    if (STATE.islandRefs.playBtn) {
      STATE.islandRefs.playBtn.innerHTML = STATE.isPlaying ? ICONS.pause : ICONS.play;
    }
  }

  // 更新灵动岛歌曲信息
  function updateIslandSongInfo() {
    if (!STATE.islandRefs.scrollInner) return;
    var song = STATE.currentSong;
    if (!song) return;
    // 未点开状态滚动文本：根据 islandScrollMode 切换歌名/歌词
    var displayText = '';
    if (STATE.islandScrollMode === 'lyric') {
      // 歌词模式：显示当前歌词
      var idx = STATE.currentLyricIndex;
      if (idx >= 0 && STATE.lyrics[idx]) {
        displayText = STATE.lyrics[idx].text || '';
      } else {
        displayText = song.name || '';
      }
    } else {
      // 歌名模式（默认）
      displayText = song.name || '';
      if (song.artist) displayText += ' - ' + song.artist;
    }
    // 滚动展示：内容重复两份，无缝滚动
    STATE.islandRefs.scrollInner.textContent = displayText + '    ' + displayText;
    if (STATE.islandRefs.cover) {
      STATE.islandRefs.cover.src = song.cover || '';
      STATE.islandRefs.cover.onerror = function () {
        STATE.islandRefs.cover.style.visibility = 'hidden';
      };
      STATE.islandRefs.cover.onload = function () {
        STATE.islandRefs.cover.style.visibility = 'visible';
      };
    }
    if (STATE.islandRefs.duration) {
      STATE.islandRefs.duration.textContent = formatTime(song.duration);
    }
    updateIslandPlayIcon();
  }

  // 更新未点开状态的滚动文本（歌词模式下随播放进度更新）
  function updateIslandScrollText() {
    if (!STATE.islandRefs.scrollInner) return;
    if (!STATE.currentSong) return;
    if (STATE.islandScrollMode !== 'lyric') return; // 歌名模式不需要随播放更新
    var idx = STATE.currentLyricIndex;
    var displayText = '';
    if (idx >= 0 && STATE.lyrics[idx]) {
      displayText = STATE.lyrics[idx].text || '';
    } else {
      displayText = STATE.currentSong.name || '';
    }
    STATE.islandRefs.scrollInner.textContent = displayText + '    ' + displayText;
  }

  // 更新灵动岛歌词
  function updateIslandLyrics() {
    if (!STATE.islandRefs.lyricCurrent) return;
    var idx = STATE.currentLyricIndex;
    if (idx < 0 || !STATE.lyrics.length) {
      STATE.islandRefs.lyricPrev.textContent = '';
      STATE.islandRefs.lyricCurrent.textContent = STATE.currentSong ? STATE.currentSong.name : '';
      STATE.islandRefs.lyricTranslation.textContent = '';
      STATE.islandRefs.lyricNext.textContent = '';
      return;
    }
    var prev = idx > 0 ? STATE.lyrics[idx - 1].text : '';
    var curr = STATE.lyrics[idx].text;
    var next = idx < STATE.lyrics.length - 1 ? STATE.lyrics[idx + 1].text : '';
    STATE.islandRefs.lyricPrev.textContent = prev;
    STATE.islandRefs.lyricCurrent.textContent = curr || '...';
    STATE.islandRefs.lyricNext.textContent = next;

    // 翻译歌词
    if (STATE.tlyrics.length > 0) {
      var tIdx = getCurrentLyricIndex(STATE.tlyrics, STATE.audio ? STATE.audio.currentTime : 0);
      STATE.islandRefs.lyricTranslation.textContent = (tIdx >= 0 && STATE.tlyrics[tIdx]) ? STATE.tlyrics[tIdx].text : '';
    } else {
      STATE.islandRefs.lyricTranslation.textContent = '';
    }
  }

  // 更新灵动岛进度
  function updateIslandProgress() {
    if (!STATE.islandRefs.progressFill || !STATE.audio) return;
    var dur = getSafeDuration();
    var percent = dur > 0 ? (STATE.audio.currentTime / dur) * 100 : 0;
    STATE.islandRefs.progressFill.style.width = percent + '%';
    if (STATE.islandRefs.currentTime) {
      STATE.islandRefs.currentTime.textContent = formatTime(STATE.audio.currentTime);
    }
    if (STATE.islandRefs.duration && dur > 0) {
      STATE.islandRefs.duration.textContent = formatTime(dur);
    }
  }

  // 销毁灵动岛
  function destroyIsland() {
    STATE.islandCleanups.forEach(function (fn) { fn(); });
    STATE.islandCleanups = [];
    if (STATE.islandEl && STATE.islandEl.parentNode) {
      STATE.islandEl.parentNode.removeChild(STATE.islandEl);
    }
    STATE.islandEl = null;
    STATE.islandRefs = {};
    if (STATE.islandStyleEl && STATE.islandStyleEl.parentNode) {
      STATE.islandStyleEl.parentNode.removeChild(STATE.islandStyleEl);
    }
    STATE.islandStyleEl = null;
    if (STATE.islandPlaylistPopup && STATE.islandPlaylistPopup.parentNode) {
      STATE.islandPlaylistPopup.parentNode.removeChild(STATE.islandPlaylistPopup);
    }
    STATE.islandPlaylistPopup = null;
    STATE._popupVisible = false;
  }

  // ==================== 统一 UI 更新 ====================

  // 更新播放状态 UI（灵动岛 + App）
  function updatePlayStateUI() {
    updateIslandPlayIcon();
    updateAppPlayState();
    updateMediaSession();
  }

  // 更新歌曲信息 UI
  function updateSongInfoUI() {
    updateIslandSongInfo();
    updateAppSongInfo();
  }

  // 更新进度 UI
  function updateProgressUI() {
    updateIslandProgress();
    updateAppProgress();
  }

  // 更新歌词 UI
  function updateLyricsUI() {
    var newIdx = getCurrentLyricIndex(STATE.lyrics, STATE.audio ? STATE.audio.currentTime : 0);
    if (newIdx !== STATE.currentLyricIndex) {
      STATE.currentLyricIndex = newIdx;
      updateIslandLyrics();
      updateIslandScrollText(); // 同步更新未点开状态的滚动文本
      updateAppLyricsHighlight();
    }
  }

  // 更新播放模式 UI
  function updatePlayModeUI() {
    updateAppPlayMode();
  }

  // ==================== App UI ====================

  // App 样式
  function getAppStyles() {
    return '\
.roche-music-player {\
  width: 100%;\
  height: 100%;\
  display: flex;\
  flex-direction: column;\
  background: linear-gradient(165deg, #212126 0%, #151519 45%, #1a1a1f 100%);\
  -webkit-backdrop-filter: blur(24px);\
  backdrop-filter: blur(24px);\
  color: #e0e0e0;\
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\
  font-size: 14px;\
  overflow: hidden;\
  border-radius: 16px;\
  padding-top: env(safe-area-inset-top);\
  box-sizing: border-box;\
  position: relative;\
}\
.roche-music-player::before {\
  content: "";\
  position: absolute;\
  top: -40%; right: -20%;\
  width: 60%; height: 60%;\
  border-radius: 50%;\
  background: radial-gradient(circle, rgba(194,12,12,0.10) 0%, transparent 70%);\
  pointer-events: none;\
  z-index: 0;\
}\
.roche-music-player::after {\
  content: "";\
  position: absolute;\
  bottom: -30%; left: -15%;\
  width: 50%; height: 50%;\
  border-radius: 50%;\
  background: radial-gradient(circle, rgba(230,0,38,0.06) 0%, transparent 70%);\
  pointer-events: none;\
  z-index: 0;\
}\
.roche-music-player > * { position: relative; z-index: 1; }\
.rmp-tabs {\
  display: flex;\
  gap: 4px;\
  padding: 8px 8px 0;\
  flex-shrink: 0;\
  overflow-x: auto;\
  -webkit-overflow-scrolling: touch;\
  border-bottom: 1px solid rgba(255,255,255,0.06);\
}\
.rmp-tabs::-webkit-scrollbar { display: none; }\
.rmp-tab {\
  padding: 8px 16px;\
  border: none;\
  background: transparent;\
  color: rgba(255,255,255,0.5);\
  font-size: 13px;\
  cursor: pointer;\
  border-radius: 8px 8px 0 0;\
  transition: color 0.2s ease, background 0.2s ease;\
  white-space: nowrap;\
  flex-shrink: 0;\
  position: relative;\
}\
.rmp-tab:hover {\
  color: rgba(255,255,255,0.85);\
  background: rgba(255,255,255,0.04);\
}\
.rmp-tab.active {\
  color: #fff;\
  background: transparent;\
}\
.rmp-tab.active::after {\
  content: "";\
  position: absolute;\
  bottom: -1px; left: 50%;\
  transform: translateX(-50%);\
  width: 24px; height: 2px;\
  background: #C20C0C;\
  border-radius: 1px;\
}\
.rmp-panels {\
  flex: 1;\
  overflow-y: auto;\
  -webkit-overflow-scrolling: touch;\
  padding: 12px;\
}\
.rmp-panels::-webkit-scrollbar { width: 6px; }\
.rmp-panels::-webkit-scrollbar-track { background: transparent; }\
.rmp-panels::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }\
.rmp-panel { display: none; }\
.rmp-panel.active { display: block; }\
.rmp-card {\
  background: rgba(255, 255, 255, 0.04);\
  border-radius: 16px;\
  padding: 16px;\
  margin-bottom: 12px;\
  border: 1px solid rgba(255, 255, 255, 0.06);\
}\
.rmp-search-bar {\
  display: flex;\
  gap: 8px;\
  margin-bottom: 12px;\
  flex-wrap: wrap;\
}\
.rmp-search-input {\
  flex: 1;\
  min-width: 160px;\
  padding: 10px 16px;\
  background: rgba(255, 255, 255, 0.06);\
  border: 1px solid rgba(255, 255, 255, 0.1);\
  border-radius: 999px;\
  color: #fff;\
  font-size: 14px;\
  outline: none;\
  transition: all 0.2s;\
}\
.rmp-search-input:focus {\
  border-color: #EC4141;\
  background: rgba(255, 255, 255, 0.08);\
  box-shadow: 0 0 0 3px rgba(194,12,12,0.16);\
}\
.rmp-search-input::placeholder { color: rgba(255,255,255,0.3); }\
.rmp-select {\
  padding: 10px 14px;\
  background: rgba(255, 255, 255, 0.06);\
  border: 1px solid rgba(255, 255, 255, 0.1);\
  border-radius: 999px;\
  color: #fff;\
  font-size: 13px;\
  outline: none;\
  cursor: pointer;\
  transition: border-color 0.2s;\
}\
.rmp-select:focus { border-color: #EC4141; }\
.rmp-select option { background: #202024; color: #fff; }\
.rmp-btn {\
  padding: 10px 18px;\
  background: linear-gradient(90deg, #EC4141 0%, #C20C0C 100%);\
  color: #fff;\
  border: none;\
  border-radius: 999px;\
  font-size: 14px;\
  font-weight: 600;\
  cursor: pointer;\
  transition: all 0.2s ease;\
  min-height: 44px;\
  display: inline-flex;\
  align-items: center;\
  justify-content: center;\
  gap: 6px;\
  box-shadow: 0 6px 18px rgba(194,12,12,0.32);\
}\
.rmp-btn:hover { background: linear-gradient(90deg, #f45555 0%, #d41414 100%); box-shadow: 0 8px 26px rgba(194,12,12,0.45); transform: translateY(-1px); }\
.rmp-btn:active { transform: translateY(0) scale(0.98); }\
.rmp-btn-secondary {\
  background: rgba(255, 255, 255, 0.08);\
  color: #e0e0e0;\
  box-shadow: none;\
}\
.rmp-btn-secondary:hover { background: rgba(255, 255, 255, 0.14); box-shadow: none; }\
.rmp-btn-icon {\
  padding: 10px;\
  min-width: 44px;\
  min-height: 44px;\
  background: rgba(255, 255, 255, 0.06);\
  color: #e0e0e0;\
  border: none;\
  border-radius: 50%;\
  cursor: pointer;\
  display: inline-flex;\
  align-items: center;\
  justify-content: center;\
  transition: all 0.2s ease;\
}\
.rmp-btn-icon:hover { background: rgba(194,12,12,0.14); color: #EC4141; transform: scale(1.06); }\
.rmp-btn-icon:active { transform: scale(0.95); }\
.rmp-btn-icon svg { width: 20px; height: 20px; fill: currentColor; }\
.rmp-btn-icon.large svg { width: 28px; height: 28px; }\
.rmp-search-results {\
  display: flex;\
  flex-direction: column;\
  gap: 4px;\
}\
.rmp-song-item {\
  display: flex;\
  align-items: center;\
  gap: 10px;\
  padding: 10px 12px;\
  border-radius: 8px;\
  cursor: pointer;\
  transition: background 0.2s ease, transform 0.1s ease;\
  min-height: 44px;\
  position: relative;\
}\
.rmp-song-item:hover {\
  background: rgba(255, 255, 255, 0.06);\
}\
.rmp-song-item:active {\
  transform: scale(0.99);\
}\
.rmp-song-item.playing {\
  background: rgba(194, 12, 12, 0.12);\
}\
.rmp-song-item.playing::before {\
  content: "";\
  position: absolute;\
  left: 0; top: 50%;\
  transform: translateY(-50%);\
  width: 3px; height: 60%;\
  background: linear-gradient(180deg, #EC4141, #C20C0C);\
  border-radius: 0 2px 2px 0;\
  box-shadow: 0 0 8px rgba(194,12,12,0.7);\
}\
.rmp-song-cover {\
  width: 44px;\
  height: 44px;\
  border-radius: 8px;\
  object-fit: cover;\
  flex-shrink: 0;\
  background: rgba(255,255,255,0.06);\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  font-size: 18px;\
  font-weight: 700;\
  color: rgba(255,255,255,0.5);\
  overflow: hidden;\
}\
.rmp-song-info {\
  flex: 1;\
  overflow: hidden;\
  min-width: 0;\
}\
.rmp-song-name {\
  font-size: 14px;\
  color: #e0e0e0;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
}\
.rmp-song-item.playing .rmp-song-name {\
  color: #EC4141;\
}\
.rmp-song-meta {\
  font-size: 12px;\
  color: rgba(255,255,255,0.4);\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  margin-top: 2px;\
}\
.rmp-song-duration {\
  font-size: 12px;\
  color: rgba(255,255,255,0.4);\
  flex-shrink: 0;\
}\
.rmp-song-index {\
  font-size: 13px;\
  color: rgba(255,255,255,0.3);\
  font-variant-numeric: tabular-nums;\
  min-width: 20px;\
  text-align: center;\
  flex-shrink: 0;\
}\
.rmp-song-platform {\
  font-size: 10px;\
  padding: 2px 8px;\
  border-radius: 999px;\
  background: rgba(194,12,12,0.16);\
  color: #ff6b6b;\
  flex-shrink: 0;\
  border: 1px solid rgba(194,12,12,0.25);\
}\
.rmp-song-actions {\
  display: flex;\
  gap: 4px;\
  flex-shrink: 0;\
}\
.rmp-song-actions .rmp-btn-icon {\
  min-width: 44px;\
  min-height: 44px;\
  padding: 6px;\
}\
.rmp-song-actions .rmp-btn-icon svg { width: 16px; height: 16px; }\
.rmp-now-playing {\
  display: flex;\
  flex-direction: column;\
  align-items: center;\
  gap: 16px;\
}\
@media (min-width: 600px) {\
  .rmp-now-playing {\
    flex-direction: row;\
    align-items: flex-start;\
  }\
  .rmp-now-playing-left {\
    flex-shrink: 0;\
    width: 240px;\
  }\
  .rmp-now-playing-right {\
    flex: 1;\
    min-width: 0;\
  }\
}\
.rmp-np-cover-wrap {\
  position: relative;\
  width: 200px;\
  height: 200px;\
  flex-shrink: 0;\
}\
.rmp-np-cover-wrap::before {\
  content: "";\
  position: absolute;\
  inset: -20px;\
  border-radius: 50%;\
  background: radial-gradient(circle, rgba(194,12,12,0.30) 0%, transparent 70%);\
  filter: blur(20px);\
  opacity: 0;\
  transition: opacity 0.6s ease;\
}\
.rmp-np-cover-wrap.playing::before {\
  opacity: 1;\
}\
.rmp-np-cover {\
  width: 200px;\
  height: 200px;\
  border-radius: 50%;\
  object-fit: cover;\
  box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 8px rgba(255,255,255,0.04), 0 0 0 9px rgba(194,12,12,0.20);\
  background: rgba(255,255,255,0.06);\
  transition: border-radius 0.4s ease;\
}\
.rmp-np-cover.playing {\
  animation: rmp-vinyl-spin 20s linear infinite;\
}\
@keyframes rmp-vinyl-spin {\
  to { transform: rotate(360deg); }\
}\
.rmp-np-cover-wrap::after {\
  content: "";\
  position: absolute;\
  top: 50%; left: 50%;\
  transform: translate(-50%, -50%);\
  width: 16px; height: 16px;\
  border-radius: 50%;\
  background: rgba(26,26,46,0.9);\
  border: 2px solid rgba(194,12,12,0.5);\
  z-index: 1;\
}\
.rmp-np-info {\
  text-align: center;\
  margin-bottom: 8px;\
}\
@media (min-width: 600px) {\
  .rmp-np-info { text-align: left; }\
}\
.rmp-np-title {\
  font-size: 20px;\
  font-weight: 700;\
  color: #fff;\
  margin-bottom: 4px;\
}\
.rmp-np-artist {\
  font-size: 14px;\
  color: rgba(255,255,255,0.5);\
}\
.rmp-np-album {\
  font-size: 12px;\
  color: rgba(255,255,255,0.35);\
  margin-top: 2px;\
}\
.rmp-progress-bar {\
  width: 100%;\
  height: 6px;\
  background: rgba(255,255,255,0.1);\
  border-radius: 3px;\
  cursor: pointer;\
  position: relative;\
  margin: 8px 0;\
}\
.rmp-progress-bar::before {\
  content: "";\
  position: absolute;\
  left: 0;\
  right: 0;\
  top: 50%;\
  transform: translateY(-50%);\
  height: 20px;\
}\
.rmp-progress-fill {\
  height: 100%;\
  background: #C20C0C;\
  border-radius: 3px;\
  width: 0%;\
  position: relative;\
  transition: width 0.1s linear;\
}\
.rmp-progress-fill::after {\
  content: "";\
  position: absolute;\
  right: -5px;\
  top: 50%;\
  transform: translateY(-50%);\
  width: 12px;\
  height: 12px;\
  background: #C20C0C;\
  border-radius: 50%;\
  opacity: 0;\
  transition: opacity 0.2s;\
}\
.rmp-progress-bar:hover .rmp-progress-fill::after {\
  opacity: 1;\
}\
.rmp-time-display {\
  display: flex;\
  justify-content: space-between;\
  font-size: 12px;\
  color: rgba(255,255,255,0.4);\
  margin-bottom: 12px;\
}\
.rmp-controls {\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  gap: 12px;\
  margin-bottom: 12px;\
}\
.rmp-controls .rmp-btn-icon {\
  min-width: 48px;\
  min-height: 48px;\
}\
.rmp-controls .rmp-btn-icon.large {\
  min-width: 56px;\
  min-height: 56px;\
  background: #C20C0C;\
  color: #1a1a2e;\
}\
.rmp-controls .rmp-btn-icon.large:hover {\
  background: #f5d982;\
  transform: scale(1.05);\
}\
.rmp-volume-bar {\
  display: flex;\
  align-items: center;\
  gap: 8px;\
  margin-bottom: 16px;\
}\
.rmp-volume-slider {\
  flex: 1;\
  -webkit-appearance: none;\
  appearance: none;\
  height: 4px;\
  background: rgba(255,255,255,0.1);\
  border-radius: 2px;\
  outline: none;\
  max-width: 200px;\
}\
.rmp-volume-slider::-webkit-slider-thumb {\
  -webkit-appearance: none;\
  appearance: none;\
  width: 14px;\
  height: 14px;\
  background: #C20C0C;\
  border-radius: 50%;\
  cursor: pointer;\
}\
.rmp-volume-slider::-moz-range-thumb {\
  width: 14px;\
  height: 14px;\
  background: #C20C0C;\
  border-radius: 50%;\
  cursor: pointer;\
  border: none;\
}\
.rmp-lyrics-container {\
  max-height: 300px;\
  overflow-y: auto;\
  text-align: center;\
  padding: 16px 0;\
  -webkit-overflow-scrolling: touch;\
  mask-image: linear-gradient(to bottom, transparent, #000 15%, #000 85%, transparent);\
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 15%, #000 85%, transparent);\
}\
.rmp-lyrics-container::-webkit-scrollbar { display: none; }\
.rmp-lyric-line {\
  padding: 8px 16px;\
  font-size: 14px;\
  color: rgba(255,255,255,0.35);\
  transition: all 0.3s ease;\
  line-height: 1.6;\
}\
.rmp-lyric-line.active {\
  color: #C20C0C;\
  font-size: 16px;\
  font-weight: 600;\
  transform: scale(1.02);\
}\
.rmp-lyric-translation {\
  font-size: 12px;\
  color: rgba(180, 140, 255, 0.5);\
  margin-top: 2px;\
}\
.rmp-lyric-line.active .rmp-lyric-translation {\
  color: rgba(180, 140, 255, 0.8);\
}\
.rmp-lyrics-empty {\
  text-align: center;\
  color: rgba(255,255,255,0.3);\
  padding: 40px 0;\
  font-size: 14px;\
}\
.rmp-playlist-header {\
  display: flex;\
  justify-content: space-between;\
  align-items: center;\
  margin-bottom: 12px;\
}\
.rmp-playlist-count {\
  font-size: 13px;\
  color: rgba(255,255,255,0.4);\
}\
.rmp-empty-state {\
  text-align: center;\
  color: rgba(255,255,255,0.3);\
  padding: 40px 0;\
  font-size: 14px;\
}\
.rmp-settings-group {\
  margin-bottom: 16px;\
}\
.rmp-settings-label {\
  display: block;\
  font-size: 13px;\
  color: rgba(255,255,255,0.5);\
  margin-bottom: 6px;\
}\
.rmp-settings-input {\
  width: 100%;\
  padding: 10px 14px;\
  background: rgba(255, 255, 255, 0.06);\
  border: 1px solid rgba(255, 255, 255, 0.1);\
  border-radius: 12px;\
  color: #fff;\
  font-size: 14px;\
  outline: none;\
  box-sizing: border-box;\
  transition: border-color 0.2s;\
}\
.rmp-settings-input:focus {\
  border-color: #C20C0C;\
}\
.rmp-settings-input::placeholder { color: rgba(255,255,255,0.3); }\
.rmp-login-area {\
  display: flex;\
  flex-direction: column;\
  align-items: center;\
  gap: 16px;\
  padding: 20px;\
}\
.rmp-qr-container {\
  width: 200px;\
  height: 200px;\
  border-radius: 16px;\
  background: #fff;\
  padding: 12px;\
  display: flex;\
  align-items: center;\
  justify-content: center;\
}\
.rmp-qr-container img {\
  width: 100%;\
  height: 100%;\
  object-fit: contain;\
}\
.rmp-login-status {\
  font-size: 14px;\
  color: rgba(255,255,255,0.6);\
  text-align: center;\
}\
.rmp-login-status.success { color: #C20C0C; }\
.rmp-login-status.error { color: #E60026; }\
.rmp-login-info {\
  font-size: 12px;\
  color: rgba(255,255,255,0.4);\
  text-align: center;\
  max-width: 280px;\
  line-height: 1.5;\
}\
/* 用户卡片（已登录状态）*/\
.rmp-user-card {\
  display: flex;\
  align-items: center;\
  gap: 14px;\
  padding: 16px;\
  background: rgba(194,12,12,0.06);\
  border: 1px solid rgba(194,12,12,0.15);\
  border-radius: 12px;\
}\
.rmp-user-avatar {\
  width: 52px;\
  height: 52px;\
  border-radius: 50%;\
  object-fit: cover;\
  border: 2px solid rgba(194,12,12,0.3);\
  background: rgba(255,255,255,0.05);\
}\
.rmp-user-name {\
  font-size: 16px;\
  font-weight: 600;\
  color: #fff;\
  margin-bottom: 4px;\
}\
.rmp-user-badge {\
  font-size: 11px;\
  color: rgba(194,12,12,0.8);\
}\
.rmp-user-badge.vip {\
  color: #C20C0C;\
  font-weight: 600;\
}\
.rmp-loading {\
  text-align: center;\
  padding: 40px 0;\
  color: rgba(255,255,255,0.4);\
}\
.rmp-spinner {\
  display: inline-block;\
  width: 32px;\
  height: 32px;\
  border: 3px solid rgba(255,255,255,0.1);\
  border-top-color: #C20C0C;\
  border-radius: 50%;\
  animation: rmp-app-spin 0.8s linear infinite;\
}\
@keyframes rmp-app-spin {\
  to { transform: rotate(360deg); }\
}\
.rmp-clear-btn {\
  background: rgba(255, 107, 107, 0.15);\
  color: #E60026;\
  border: none;\
  padding: 8px 14px;\
  border-radius: 12px;\
  cursor: pointer;\
  font-size: 13px;\
  min-height: 36px;\
}\
.rmp-clear-btn:hover { background: rgba(255, 107, 107, 0.25); }\
/* 免责声明（仅展示，无强制同意）*/\
.rmp-disclaimer {\
  margin-top: 10px;\
  padding: 10px;\
  border: 1px solid rgba(255,255,255,0.08);\
  border-radius: 8px;\
  background: rgba(255,255,255,0.02);\
}\
/* 网易云免责声明（红色边框 + 同意勾选）*/\
.rmp-ne-disclaimer {\
  margin-top: 10px;\
  padding: 12px;\
  border: 1px solid rgba(194,12,12,0.45);\
  border-radius: 8px;\
  background: rgba(194,12,12,0.06);\
}\
.rmp-disclaimer-title {\
  font-size: 11px;\
  font-weight: 600;\
  color: rgba(255,255,255,0.35);\
  margin-bottom: 4px;\
}\
.rmp-disclaimer-body {\
  font-size: 10px;\
  color: rgba(255,255,255,0.25);\
  line-height: 1.6;\
}\
.rmp-topbar {\
  display: flex;\
  align-items: center;\
  gap: 4px;\
  /* 关键：顶部留出灵动岛空间。灵动岛高度52px + top偏移(默认8px) + safe-area + 缓冲16px */\
  padding: calc(env(safe-area-inset-top) + var(--rmp-island-top, 8px) + 52px + 16px) 8px 8px;\
  flex-shrink: 0;\
}\
/* APK/移动端：没有灵动岛，顶栏恢复正常位置（否则会被灵动岛预留空间推到中间） */\
.rmp-mobile .rmp-topbar {\
  padding-top: calc(env(safe-area-inset-top) + 8px);\
}\
/* 调试日志区块 */\
.rmp-debug-block {\
  margin-top: 10px;\
  padding: 10px;\
  border: 1px solid rgba(255,255,255,0.08);\
  border-radius: 8px;\
  background: rgba(0,0,0,0.25);\
}\
.rmp-debug-header {\
  display: flex;\
  align-items: center;\
  justify-content: space-between;\
  margin-bottom: 6px;\
}\
.rmp-debug-title {\
  font-size: 11px;\
  font-weight: 600;\
  color: rgba(255,255,255,0.4);\
}\
.rmp-debug-logs {\
  max-height: 180px;\
  overflow-y: auto;\
  background: rgba(0,0,0,0.35);\
  border-radius: 6px;\
  padding: 6px;\
  font-family: Consolas, Menlo, monospace;\
  font-size: 10px;\
  line-height: 1.5;\
}\
.rmp-debug-line {\
  color: rgba(255,255,255,0.55);\
  white-space: pre-wrap;\
  word-break: break-all;\
}\
.rmp-debug-line.err {\
  color: #ff6b6b;\
}\
.rmp-debug-empty {\
  color: rgba(255,255,255,0.3);\
  font-size: 11px;\
  text-align: center;\
  padding: 12px 0;\
}\
.rmp-debug-actions {\
  display: flex;\
  gap: 8px;\
  margin-top: 8px;\
}\
.rmp-topbar .rmp-tabs {\
  flex: 1;\
  padding: 0;\
}\
.rmp-brand {\
  display: flex;\
  align-items: center;\
  gap: 7px;\
  padding: 0 6px 0 2px;\
  flex-shrink: 0;\
}\
.rmp-brand-mark {\
  width: 28px;\
  height: 28px;\
  border-radius: 50%;\
  background: linear-gradient(135deg, #EC4141 0%, #C20C0C 100%);\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  box-shadow: 0 3px 10px rgba(194,12,12,0.45);\
}\
.rmp-brand-mark svg { width: 15px; height: 15px; fill: #fff; }\
.rmp-brand-text {\
  display: flex;\
  flex-direction: column;\
  line-height: 1.15;\
}\
.rmp-brand-name {\
  font-size: 13px;\
  font-weight: 700;\
  color: #fff;\
  letter-spacing: 0.5px;\
}\
.rmp-brand-ver {\
  font-size: 9px;\
  color: rgba(255,255,255,0.45);\
  font-family: Consolas, Menlo, monospace;\
}\
.rmp-close-btn {\
  flex-shrink: 0;\
  min-width: 44px;\
  min-height: 44px;\
  padding: 8px 12px;\
  background: rgba(255, 107, 107, 0.12);\
  color: #E60026;\
  border: none;\
  border-radius: 12px;\
  cursor: pointer;\
  font-size: 13px;\
  font-weight: 600;\
  display: inline-flex;\
  align-items: center;\
  justify-content: center;\
  transition: all 0.2s ease;\
}\
.rmp-close-btn:hover { background: rgba(255, 107, 107, 0.22); }\
.rmp-toggle-row {\
  display: flex;\
  align-items: center;\
  justify-content: space-between;\
  padding: 6px 0;\
}\
.rmp-toggle-label {\
  font-size: 13px;\
  color: rgba(255,255,255,0.7);\
}\
.rmp-toggle {\
  position: relative;\
  width: 44px;\
  height: 26px;\
  background: rgba(255,255,255,0.15);\
  border-radius: 13px;\
  cursor: pointer;\
  transition: background 0.2s ease;\
  flex-shrink: 0;\
}\
.rmp-toggle.on {\
  background: linear-gradient(90deg, #EC4141, #C20C0C);\
}\
.rmp-toggle::after {\
  content: "";\
  position: absolute;\
  top: 3px;\
  left: 3px;\
  width: 20px;\
  height: 20px;\
  background: #fff;\
  border-radius: 50%;\
  transition: transform 0.2s ease;\
}\
.rmp-toggle.on::after {\
  transform: translateX(18px);\
}\
@media (max-width: 600px) {\
  .rmp-btn.sm {\
    padding: 12px 16px;\
  }\
}\
/* 声波动画（当前播放指示） */\
.rmp-equalizer {\
  display: inline-flex;\
  align-items: flex-end;\
  gap: 2px;\
  height: 14px;\
  flex-shrink: 0;\
}\
.rmp-equalizer span {\
  display: block;\
  width: 3px;\
  height: 100%;\
  background: #C20C0C;\
  border-radius: 1px;\
  animation: rmp-eq-bounce 0.9s ease-in-out infinite;\
}\
.rmp-equalizer span:nth-child(1) { animation-delay: 0s; }\
.rmp-equalizer span:nth-child(2) { animation-delay: 0.2s; }\
.rmp-equalizer span:nth-child(3) { animation-delay: 0.4s; }\
.rmp-equalizer.paused span {\
  animation-play-state: paused;\
  height: 30%;\
}\
@keyframes rmp-eq-bounce {\
  0%, 100% { height: 20%; }\
  50% { height: 100%; }\
}\
/* 黑胶唱片中心孔 */\
.rmp-np-cover-wrap::after {\
  content: "";\
  position: absolute;\
  top: 50%; left: 50%;\
  transform: translate(-50%, -50%);\
  width: 16px; height: 16px;\
  border-radius: 50%;\
  background: #0d0d0d;\
  border: 2px solid rgba(255,255,255,0.15);\
  z-index: 2;\
  pointer-events: none;\
}\
/* 平台标签颜色微调 */\
.rmp-song-platform {\
  background: rgba(194,12,12,0.16);\
  color: #ff6b6b;\
  border: 1px solid rgba(194,12,12,0.25);\
}\
.rmp-version-display {\
  padding: 4px 0;\
  letter-spacing: 0.3px;\
}\
/* ===== 网易云专区样式 ===== */\
.rmp-netease-header {\
  display: flex;\
  align-items: center;\
  gap: 14px;\
  padding: 10px 4px 14px;\
  border-bottom: 1px solid rgba(255,255,255,0.06);\
  margin-bottom: 12px;\
}\
.rmp-netease-user-area {\
  display: flex;\
  align-items: center;\
  gap: 12px;\
  flex: 1;\
}\
.rmp-netease-avatar {\
  width: 44px; height: 44px;\
  border-radius: 50%;\
  object-fit: cover;\
  background: rgba(255,255,255,0.06);\
  border: 2px solid rgba(194,12,12,0.3);\
  flex-shrink: 0;\
}\
.rmp-netease-user-info { flex: 1; min-width: 0; }\
.rmp-netease-nickname {\
  font-size: 16px; font-weight: 600; color: #fff;\
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
}\
.rmp-netease-subtitle {\
  font-size: 12px; color: rgba(255,255,255,0.4); margin-top: 2px;\
}\
.rmp-netease-login-hint {\
  display: flex; align-items: center; gap: 10px; width: 100%;\
}\
.rmp-netease-login-icon {\
  width: 44px; height: 44px; border-radius: 50%;\
  background: rgba(194,12,12,0.1); display: flex; align-items: center;\
  justify-content: center; flex-shrink: 0;\
}\
.rmp-netease-login-icon svg { width: 22px; height: 22px; fill: #C20C0C; }\
.rmp-netease-login-text {\
  flex: 1; font-size: 14px; color: rgba(255,255,255,0.6);\
}\
.rmp-netease-subnav {\
  display: flex; gap: 2px; padding: 0 0 10px;\
  border-bottom: 1px solid rgba(255,255,255,0.04); margin-bottom: 12px;\
}\
.rmp-nsub-btn {\
  padding: 7px 16px; border: none; background: transparent;\
  color: rgba(255,255,255,0.45); font-size: 13px; cursor: pointer;\
  border-radius: 8px; transition: all 0.2s; position: relative;\
}\
.rmp-nsub-btn:hover { color: rgba(255,255,255,0.8); background: rgba(255,255,255,0.04); }\
.rmp-nsub-btn.active { color: #fff; background: rgba(194,12,12,0.12); }\
.rmp-nsub-panel { display: none; }\
.rmp-nsub-panel.active { display: block; }\
.rmp-netease-recs { display: flex; flex-direction: column; gap: 6px; }\
.rmp-netease-playlists { display: flex; flex-direction: column; gap: 8px; }\
.rmp-netease-pl-item {\
  display: flex; align-items: center; gap: 12px; padding: 10px;\
  border-radius: 10px; cursor: pointer; transition: background 0.2s;\
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.04);\
}\
.rmp-netease-pl-item:hover { background: rgba(255,255,255,0.06); }\
.rmp-netease-pl-cover {\
  width: 52px; height: 52px; border-radius: 8px; object-fit: cover;\
  background: rgba(255,255,255,0.06); flex-shrink: 0;\
}\
.rmp-netease-pl-info { flex: 1; min-width: 0; }\
.rmp-netease-pl-name {\
  font-size: 14px; color: #e0e0e0; font-weight: 500;\
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\
}\
.rmp-netease-pl-meta {\
  font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 3px;\
}\
.rmp-netease-pl-arrow {\
  color: rgba(255,255,255,0.2); font-size: 16px; flex-shrink: 0;\
}\
/* 第三方音乐源面板 */\
.rmp-gd-header {\
  padding: 8px 4px 12px;\
  border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 12px;\
}\
.rmp-gd-title {\
  font-size: 13px; color: rgba(255,255,255,0.5);\
  display: flex; align-items: center; gap: 6px;\
}\
.rmp-gd-title::before {\
  content: ""; display: inline-block; width: 6px; height: 6px;\
  background: rgba(236,65,65,0.8); border-radius: 50%;\
}\
.rmp-netease-pl-loading { text-align: center; padding: 32px; color: rgba(255,255,255,0.3); }\
/* QR 登录弹窗 */\
.rmp-qr-modal { position: fixed; inset: 0; z-index: 99999; display: flex; align-items: center; justify-content: center; }\
.rmp-qr-modal-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); }\
.rmp-qr-modal-box { position: relative; background: #1a1a2e; border-radius: 20px; padding: 28px; width: 300px; max-width: 90vw; text-align: center; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 24px 80px rgba(0,0,0,0.6); }\
.rmp-qr-modal-close { position: absolute; top: 12px; right: 16px; font-size: 22px; color: rgba(255,255,255,0.4); cursor: pointer; line-height: 1; }\
.rmp-qr-modal-close:hover { color: #fff; }\
.rmp-qr-modal-title { font-size: 17px; font-weight: 600; color: #fff; margin-bottom: 16px; }\
.rmp-qr-modal-body { display: flex; flex-direction: column; align-items: center; gap: 12px; }\
.rmp-qr-img-wrap { width: 200px; height: 200px; border-radius: 16px; background: #fff; padding: 12px; display: flex; align-items: center; justify-content: center; }\
.rmp-qr-img-wrap img { width: 100%; height: 100%; object-fit: contain; }\
.rmp-qr-placeholder-el { color: #999; font-size: 13px; }\
.rmp-qr-status-el { font-size: 13px; color: rgba(255,255,255,0.6); line-height: 1.6; }\
.rmp-qr-status-el.success { color: #C20C0C; }\
.rmp-qr-status-el.error { color: #E60026; }\
';
  }

  // SVG 图标
  var ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zm-9.5 6L15 6v12z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm0 5h2v2H4zm0 5h2v2H4zm4-10h12v2H8zm0 5h12v2H8zm0 5h12v2H8z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    repeatOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z M12 13h-1v-2h1v2zm0-3h-1V8h1v2z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
    add: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
    remove: '<svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
  };

  // 渲染 App
  function renderApp(container) {
    // 防重复渲染：如果已存在容器，先清理
    if (STATE.appContainer) cleanupApp();
    STATE.appContainer = container;

    // 注入样式
    STATE.appStyleEl = document.createElement('style');
    STATE.appStyleEl.textContent = getAppStyles();
    document.head.appendChild(STATE.appStyleEl);

    // 渲染 HTML 结构
    container.innerHTML = '\
<div class="roche-music-player">\
  <div class="rmp-topbar">\
    <div class="rmp-brand">\
      <div class="rmp-brand-mark"><svg viewBox="0 0 24 24"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></div>\
      <div class="rmp-brand-text">\
        <span class="rmp-brand-name">云音乐</span>\
        <span class="rmp-brand-ver">' + BUILD_TIME.split('-v')[1] + '</span>\
      </div>\
    </div>\
    <div class="rmp-tabs">\
      <button class="rmp-tab active" data-tab="netease">网易云音乐</button>\
      <button class="rmp-tab" data-tab="gd">第三方音乐源</button>\
      <button class="rmp-tab" data-tab="playlist">播放列表</button>\
      <button class="rmp-tab" data-tab="settings">设置</button>\
    </div>\
    <button class="rmp-close-btn" title="关闭">关闭</button>\
  </div>\
  <div class="rmp-panels">\
    <!-- ===== 网易云面板（主面板） ===== -->\
    <div class="rmp-panel active" data-panel="netease">\
      <!-- 顶部用户区 -->\
      <div class="rmp-netease-header">\
        <div class="rmp-netease-user-area rmp-netease-logged-out">\
          <div class="rmp-netease-login-hint">\
            <div class="rmp-netease-login-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg></div>\
            <div class="rmp-netease-login-text">登录网易云音乐，享受个人歌单与每日推荐</div>\
          </div>\
          <button class="rmp-btn rmp-netease-login-btn" style="flex-shrink:0;">登录</button>\
        </div>\
        <div class="rmp-netease-user-area rmp-netease-logged-in" style="display:none;">\
          <img class="rmp-netease-avatar rmp-np-avatar" alt="" />\
          <div class="rmp-netease-user-info">\
            <div class="rmp-netease-nickname rmp-np-nickname"></div>\
            <div class="rmp-netease-subtitle rmp-np-vip-badge"></div>\
          </div>\
          <button class="rmp-btn rmp-btn-secondary rmp-netease-logout-btn" style="flex-shrink:0;">退出</button>\
        </div>\
      </div>\
      <!-- 子导航 -->\
      <div class="rmp-netease-subnav">\
        <button class="rmp-nsub-btn active" data-nsub="recommend">推荐</button>\
        <button class="rmp-nsub-btn" data-nsub="search">搜索</button>\
        <button class="rmp-nsub-btn" data-nsub="playlists">歌单</button>\
        <button class="rmp-nsub-btn" data-nsub="player">正在播放</button>\
      </div>\
      <!-- 子面板容器 -->\
      <div class="rmp-netease-subpanels">\
        <!-- 推荐 -->\
        <div class="rmp-nsub-panel active" data-nsub="recommend">\
          <button class="rmp-btn rmp-netease-load-recs-btn" style="width:100%;">加载每日推荐</button>\
          <div class="rmp-netease-recs" style="margin-top:10px;"></div>\
        </div>\
        <!-- 搜索 -->\
        <div class="rmp-nsub-panel" data-nsub="search">\
          <div class="rmp-search-bar">\
            <input type="text" class="rmp-search-input rmp-netease-search-input" placeholder="搜索网易云歌曲..." />\
            <button class="rmp-btn rmp-netease-search-btn">搜索</button>\
          </div>\
          <div class="rmp-search-results rmp-netease-results"></div>\
        </div>\
        <!-- 歌单 -->\
        <div class="rmp-nsub-panel" data-nsub="playlists">\
          <div class="rmp-netease-playlists"></div>\
        </div>\
        <!-- 正在播放 -->\
        <div class="rmp-nsub-panel" data-nsub="player">\
          <div class="rmp-now-playing">\
            <div class="rmp-now-playing-left">\
              <div class="rmp-np-cover-wrap">\
                <img class="rmp-np-cover" alt="" />\
              </div>\
              <div class="rmp-np-info" style="margin-top:12px;">\
                <div class="rmp-np-title">未播放</div>\
                <div class="rmp-np-artist"></div>\
                <div class="rmp-np-album"></div>\
              </div>\
            </div>\
            <div class="rmp-now-playing-right">\
              <div class="rmp-progress-bar">\
                <div class="rmp-progress-fill"></div>\
              </div>\
              <div class="rmp-time-display">\
                <span class="rmp-current-time">0:00</span>\
                <span class="rmp-total-time">0:00</span>\
              </div>\
              <div class="rmp-controls">\
                <button class="rmp-btn-icon rmp-mode-btn" title="播放模式">' + ICONS.list + '</button>\
                <button class="rmp-btn-icon rmp-prev-btn" title="上一首">' + ICONS.prev + '</button>\
                <button class="rmp-btn-icon large rmp-play-btn" title="播放/暂停">' + ICONS.play + '</button>\
                <button class="rmp-btn-icon rmp-next-btn" title="下一首">' + ICONS.next + '</button>\
                <button class="rmp-btn-icon rmp-volume-btn" title="音量">' + ICONS.volume + '</button>\
              </div>\
              <div class="rmp-volume-bar">\
                <input type="range" class="rmp-volume-slider" min="0" max="1" step="0.01" value="0.8" />\
              </div>\
              <div class="rmp-lyrics-container">\
                <div class="rmp-lyrics-empty">暂无歌词</div>\
              </div>\
            </div>\
          </div>\
        </div>\
      </div>\
    </div>\
    <!-- ===== 第三方音乐源面板（次要） ===== -->\
    <div class="rmp-panel" data-panel="gd">\
      <div class="rmp-gd-header">\
        <div class="rmp-gd-title">第三方音乐源搜索</div>\
      </div>\
      <div class="rmp-search-bar">\
        <input type="text" class="rmp-search-input rmp-gd-search-input" placeholder="输入歌曲名或歌手名..." />\
        <select class="rmp-select rmp-search-source">\
          <option value="all">全平台</option>\
          <option value="netease">网易云</option>\
          <option value="joox">JOOX</option>\
        </select>\
        <button class="rmp-btn rmp-gd-search-btn">搜索</button>\
      </div>\
      <div class="rmp-search-results rmp-gd-results"></div>\
    </div>\
    <!-- ===== 播放列表面板（独立页面）===== -->\
    <div class="rmp-panel" data-panel="playlist">\
      <div class="rmp-card" style="padding:12px;">\
        <div class="rmp-playlist-header">\
          <span class="rmp-playlist-count">0 首</span>\
          <button class="rmp-clear-btn rmp-clear-playlist-btn">清空列表</button>\
        </div>\
        <div class="rmp-playlist-items"></div>\
      </div>\
    </div>\
    <!-- ===== 设置面板 ===== -->\
    <div class="rmp-panel" data-panel="settings">\
      <div class="rmp-card">\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">后端地址</label>\
          <input type="text" class="rmp-settings-input rmp-backend-input" placeholder="https://..." />\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">网易云 Cookie（推荐：粘贴后直接登录，无需扫码）</label>\
          <input type="text" class="rmp-settings-input rmp-cookie-input" placeholder="MUSIC_U=xxx; __csrf=xxx" />\
          <div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:4px;">\
            获取方式：浏览器打开 music.163.com 登录 → F12 → Application → Cookies → 复制 MUSIC_U 和 __csrf 的值，粘贴为 MUSIC_U=值; __csrf=值 格式\
          </div>\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">char 点歌音源</label>\
          <select class="rmp-select rmp-char-source-select" style="width:100%;">\
            <option value="netease">网易云个人账号</option>\
            <option value="gd">第三方音乐源</option>\
          </select>\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">默认音源</label>\
          <select class="rmp-select rmp-default-source-select" style="width:100%;">\
            <option value="joox">JOOX</option>\
            <option value="netease">网易云</option>\
          </select>\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">音质</label>\
          <select class="rmp-select rmp-quality-select" style="width:100%;">\
            <option value="standard">标准 (320kbps)</option>\
            <option value="high">无损 (16bit)</option>\
            <option value="lossless">无损 (24bit)</option>\
          </select>\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">灵动岛距顶部偏移（0-100，默认 8）</label>\
          <input type="number" class="rmp-settings-input rmp-island-top-input" min="0" max="100" step="1" />\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">灵动岛显示模式（未点开时）</label>\
          <select class="rmp-select rmp-island-scroll-mode-select">\
            <option value="title">歌名</option>\
            <option value="lyric">当前歌词</option>\
          </select>\
        </div>\
        <div class="rmp-settings-group">\
          <div class="rmp-toggle-row">\
            <span class="rmp-toggle-label">显示灵动岛</span>\
            <div class="rmp-toggle rmp-island-visible-toggle" role="switch"></div>\
          </div>\
        </div>\
        <div class="rmp-settings-group">\
          <div class="rmp-toggle-row">\
            <span class="rmp-toggle-label">完整歌词注入（全部歌词+标注当前10行范围）</span>\
            <div class="rmp-toggle rmp-lyrics-full-toggle" role="switch"></div>\
          </div>\
        </div>\
        <button class="rmp-btn rmp-save-settings-btn" style="margin-top:8px;">保存设置</button>\
        <button class="rmp-btn rmp-btn-secondary rmp-reset-island-btn" style="margin-top:6px;">重置灵动岛显示</button>\
        <div style="text-align:center;font-size:11px;color:rgba(255,255,255,0.25);margin-top:10px;" class="rmp-version-display">' + BUILD_TIME + '</div>\
        <div class="rmp-debug-block">\
          <div class="rmp-debug-header">\
            <span class="rmp-debug-title">调试日志</span>\
            <button class="rmp-btn rmp-btn-secondary rmp-debug-refresh-btn" style="min-height:30px;padding:4px 12px;font-size:12px;">刷新</button>\
          </div>\
          <div class="rmp-debug-logs"></div>\
          <div class="rmp-debug-actions">\
            <button class="rmp-btn rmp-btn-secondary rmp-debug-copy-btn" style="min-height:30px;padding:4px 12px;font-size:12px;">复制日志</button>\
            <button class="rmp-btn rmp-btn-secondary rmp-debug-clear-btn" style="min-height:30px;padding:4px 12px;font-size:12px;">清空</button>\
          </div>\
        </div>\
        <div class="rmp-ne-disclaimer">\
          <div class="rmp-disclaimer-title">网易云免责声明</div>\
          <div class="rmp-disclaimer-body">\
            网易云音乐相关功能使用你本人提供的 Cookie 登录态，仅用于查询歌曲、歌单与播放音频。<br/>\
            播放链接来自网易云官方接口，仅供个人学习与技术研究，请勿用于商业用途。<br/>\
            使用即视为同意以上声明。\
          </div>\
        </div>\
        <div class="rmp-disclaimer">\
          <div class="rmp-disclaimer-title">免责声明</div>\
          <div class="rmp-disclaimer-body">\
            本插件为音乐播放工具，本身不存储、不托管任何音乐内容。<br/>\
            所有数据来自GD音乐台等第三方接口，版权归原始平台所有。<br/>\
            仅供个人学习与技术研究，请勿商用。\
          </div>\
        </div>\
      </div>\
    </div>\
  </div>\
</div>';

    // 缓存元素引用
    var root = container.querySelector('.roche-music-player');
    STATE.appRefs = {
      root: root,
      tabs: root.querySelectorAll('.rmp-tab'),
      panels: root.querySelectorAll('.rmp-panel'),
      // 网易云 — 用户区
      neLoggedOut: root.querySelector('.rmp-netease-logged-out'),
      neLoggedIn: root.querySelector('.rmp-netease-logged-in'),
      neAvatar: root.querySelector('.rmp-np-avatar'),
      neNickname: root.querySelector('.rmp-np-nickname'),
      neVipBadge: root.querySelector('.rmp-np-vip-badge'),
      neLoginBtn: root.querySelector('.rmp-netease-login-btn'),
      neLogoutBtn: root.querySelector('.rmp-netease-logout-btn'),
      // 网易云 — 子导航
      neSubnavBtns: root.querySelectorAll('.rmp-nsub-btn'),
      neSubpanels: root.querySelectorAll('.rmp-nsub-panel'),
      // 网易云 — 推荐
      neLoadRecsBtn: root.querySelector('.rmp-netease-load-recs-btn'),
      neRecsList: root.querySelector('.rmp-netease-recs'),
      // 网易云 — 搜索
      neSearchInput: root.querySelector('.rmp-netease-search-input'),
      neSearchBtn: root.querySelector('.rmp-netease-search-btn'),
      neSearchResults: root.querySelector('.rmp-netease-results'),
      // 网易云 — 歌单
      nePlaylists: root.querySelector('.rmp-netease-playlists'),
      // GD音乐台
      gdSearchInput: root.querySelector('.rmp-gd-search-input'),
      gdSearchSource: root.querySelector('.rmp-search-source'),
      gdSearchBtn: root.querySelector('.rmp-gd-search-btn'),
      gdSearchResults: root.querySelector('.rmp-gd-results'),
      // 播放列表（独立页面）
      playlistCount: root.querySelector('.rmp-playlist-count'),
      playlistItems: root.querySelector('.rmp-playlist-items'),
      clearPlaylistBtn: root.querySelector('.rmp-clear-playlist-btn'),
      // 播放器（共享）
      npCover: root.querySelector('.rmp-np-cover'),
      npTitle: root.querySelector('.rmp-np-title'),
      npArtist: root.querySelector('.rmp-np-artist'),
      npAlbum: root.querySelector('.rmp-np-album'),
      progressBar: root.querySelector('.rmp-progress-bar'),
      progressFill: root.querySelector('.rmp-progress-fill'),
      currentTime: root.querySelector('.rmp-current-time'),
      totalTime: root.querySelector('.rmp-total-time'),
      modeBtn: root.querySelector('.rmp-mode-btn'),
      prevBtn: root.querySelector('.rmp-prev-btn'),
      playBtn: root.querySelector('.rmp-play-btn'),
      nextBtn: root.querySelector('.rmp-next-btn'),
      volumeBtn: root.querySelector('.rmp-volume-btn'),
      volumeSlider: root.querySelector('.rmp-volume-slider'),
      lyricsContainer: root.querySelector('.rmp-lyrics-container'),
      // 设置
      backendInput: root.querySelector('.rmp-backend-input'),
      cookieInput: root.querySelector('.rmp-cookie-input'),
      defaultSourceSelect: root.querySelector('.rmp-default-source-select'),
      qualitySelect: root.querySelector('.rmp-quality-select'),
      islandTopInput: root.querySelector('.rmp-island-top-input'),
      islandVisibleToggle: root.querySelector('.rmp-island-visible-toggle'),
      islandScrollModeSelect: root.querySelector('.rmp-island-scroll-mode-select'),
      saveSettingsBtn: root.querySelector('.rmp-save-settings-btn'),
      resetIslandBtn: root.querySelector('.rmp-reset-island-btn'),
      lyricsFullToggle: root.querySelector('.rmp-lyrics-full-toggle'),
      closeBtn: root.querySelector('.rmp-close-btn'),
      // 设置 — char 点歌音源
      charSourceSelect: root.querySelector('.rmp-char-source-select'),
      // 设置 — 调试日志
      debugLogsEl: root.querySelector('.rmp-debug-logs'),
      debugRefreshBtn: root.querySelector('.rmp-debug-refresh-btn'),
      debugCopyBtn: root.querySelector('.rmp-debug-copy-btn'),
      debugClearBtn: root.querySelector('.rmp-debug-clear-btn')
    };

    // APK/移动端适配：无灵动岛，顶栏恢复正常位置
    if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')) {
      root.classList.add('rmp-mobile');
    }

    // 初始化设置值
    STATE.appRefs.backendInput.value = STATE.backend;
    STATE.appRefs.defaultSourceSelect.value = STATE.defaultSource;
    STATE.appRefs.qualitySelect.value = STATE.quality;
    STATE.appRefs.volumeSlider.value = STATE.volume;
    STATE.appRefs.islandTopInput.value = STATE.islandTop;
    if (STATE.appRefs.charSourceSelect) STATE.appRefs.charSourceSelect.value = STATE.charSource;
    // 第三方面板搜索源默认跟随默认音源（默认网易云）
    if (STATE.appRefs.gdSearchSource) STATE.appRefs.gdSearchSource.value = STATE.defaultSource;
    STATE.appRefs.islandScrollModeSelect.value = STATE.islandScrollMode;
    // 初始化开关状态
    if (STATE.islandVisible) STATE.appRefs.islandVisibleToggle.classList.add('on');
    if (STATE.lyricsFullInject) STATE.appRefs.lyricsFullToggle.classList.add('on');

    bindAppEvents();
    updateAppSongInfo();
    updateAppPlayState();
    updateAppPlayMode();
    renderAppLyrics();
    renderPlaylistUI();
    updateNeteaseLoginUI();
  }

  // 绑定 App 事件
  function bindAppEvents() {
    var refs = STATE.appRefs;

    // ===== 顶层 Tab 切换 =====
    function onTabClick(e) {
      var tab = e.target.closest('.rmp-tab');
      if (!tab) return;
      switchTab(tab.getAttribute('data-tab'));
    }
    refs.root.querySelector('.rmp-tabs').addEventListener('click', onTabClick);
    STATE.appCleanups.push(function () {
      refs.root.querySelector('.rmp-tabs').removeEventListener('click', onTabClick);
    });

    // ===== 网易云子导航 =====
    function onNSubClick(e) {
      var btn = e.target.closest('.rmp-nsub-btn');
      if (!btn) return;
      var nsub = btn.getAttribute('data-nsub');
      // 更新子导航按钮状态
      refs.neSubnavBtns.forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-nsub') === nsub);
      });
      // 切换子面板
      refs.neSubpanels.forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-nsub') === nsub);
      });
      // 如果切到歌单，加载歌单
      if (nsub === 'playlists') loadUserPlaylists();
    }
    refs.root.querySelector('.rmp-netease-subnav').addEventListener('click', onNSubClick);
    STATE.appCleanups.push(function () {
      var sn = refs.root.querySelector('.rmp-netease-subnav');
      if (sn) sn.removeEventListener('click', onNSubClick);
    });

    // ===== 网易云登录/退出 =====
    if (refs.neLoginBtn) {
      refs.neLoginBtn.addEventListener('click', startQrLogin);
      STATE.appCleanups.push(function () { refs.neLoginBtn.removeEventListener('click', startQrLogin); });
    }
    if (refs.neLogoutBtn) {
      refs.neLogoutBtn.addEventListener('click', doLogout);
      STATE.appCleanups.push(function () { refs.neLogoutBtn.removeEventListener('click', doLogout); });
    }

    // ===== 网易云每日推荐 =====
    if (refs.neLoadRecsBtn) {
      refs.neLoadRecsBtn.addEventListener('click', loadDailyRecommend);
      STATE.appCleanups.push(function () { refs.neLoadRecsBtn.removeEventListener('click', loadDailyRecommend); });
    }

    // ===== 网易云搜索 =====
    function doNeSearch() {
      var keywords = refs.neSearchInput.value.trim();
      if (!keywords) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请输入搜索关键词');
        return;
      }
      if (!STATE.cookie) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请先在设置中填写网易云 Cookie');
        return;
      }
      STATE.isSearching = true;
      refs.neSearchResults.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';
      neteaseApi('/api/search/get?s=' + encodeURIComponent(keywords) + '&type=1&limit=20').then(function(resp) {
        STATE.isSearching = false;
        var result = resp.result || {};
        var songs = (result.songs || []).map(function(s) {
          var al = s.album || s.al || {};
          var ar = s.artists || s.ar || [];
          return {
            id: String(s.id), name: s.name || '',
            artist: ar.map(function(a) { return a.name; }).join(' / '),
            album: al.name || '', picId: toHttps(al.picUrl) || '',
            cover: toHttps(al.picUrl) || '', lyricId: String(s.id),
            duration: Math.round((s.duration || s.dt || 0) / 1000),
            platform: 'netease', _personal: true
          };
        });
        STATE.searchResults = songs;
        renderNeSearchResults();
      }).catch(function(e) {
        STATE.isSearching = false;
        refs.neSearchResults.innerHTML = '<div class="rmp-empty-state">搜索失败，请检查Cookie或网络</div>';
      });
    }
    if (refs.neSearchBtn) {
      refs.neSearchBtn.addEventListener('click', doNeSearch);
      STATE.appCleanups.push(function () { refs.neSearchBtn.removeEventListener('click', doNeSearch); });
    }
    function onNeSearchKeydown(e) { if (e.key === 'Enter') doNeSearch(); }
    if (refs.neSearchInput) {
      refs.neSearchInput.addEventListener('keydown', onNeSearchKeydown);
      STATE.appCleanups.push(function () { refs.neSearchInput.removeEventListener('keydown', onNeSearchKeydown); });
    }
    // 网易云搜索结果点击
    if (refs.neSearchResults) {
      function onNeResultsClick(e) {
        var item = e.target.closest('.rmp-song-item');
        if (!item) return;
        var index = parseInt(item.getAttribute('data-index'), 10);
        if (isNaN(index) || !STATE.searchResults[index]) return;
        var song = STATE.searchResults[index];
        if (e.target.closest('.rmp-add-btn')) {
          addToPlaylist(song);
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已添加到播放列表');
          return;
        }
        var idx = addToPlaylist(song);
        playSong(song, idx);
      }
      refs.neSearchResults.addEventListener('click', onNeResultsClick);
      STATE.appCleanups.push(function () { refs.neSearchResults.removeEventListener('click', onNeResultsClick); });
    }
    // 网易云歌单点击
    if (refs.nePlaylists) {
      function onPlClick(e) {
        var item = e.target.closest('.rmp-netease-pl-item');
        if (!item) return;
        var plId = item.getAttribute('data-id');
        if (plId) loadPlaylistSongs(plId);
      }
      refs.nePlaylists.addEventListener('click', onPlClick);
      STATE.appCleanups.push(function () { refs.nePlaylists.removeEventListener('click', onPlClick); });
    }

    // ===== GD 音乐台搜索 =====
    function doGdSearch() {
      var keywords = refs.gdSearchInput.value.trim();
      if (!keywords) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请输入搜索关键词');
        return;
      }
      var source = refs.gdSearchSource.value;
      STATE.isSearching = true;
      refs.gdSearchResults.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';
      searchMusic(keywords, source, 20).then(function (results) {
        STATE.isSearching = false;
        STATE.searchResults = results;
        renderGdSearchResults();
      }).catch(function (e) {
        STATE.isSearching = false;
        refs.gdSearchResults.innerHTML = '<div class="rmp-empty-state">搜索失败，请检查后端地址或网络</div>';
      });
    }
    if (refs.gdSearchBtn) {
      refs.gdSearchBtn.addEventListener('click', doGdSearch);
      STATE.appCleanups.push(function () { refs.gdSearchBtn.removeEventListener('click', doGdSearch); });
    }
    function onGdSearchKeydown(e) { if (e.key === 'Enter') doGdSearch(); }
    if (refs.gdSearchInput) {
      refs.gdSearchInput.addEventListener('keydown', onGdSearchKeydown);
      STATE.appCleanups.push(function () { refs.gdSearchInput.removeEventListener('keydown', onGdSearchKeydown); });
    }
    if (refs.gdSearchResults) {
      function onGdResultsClick(e) {
        var item = e.target.closest('.rmp-song-item');
        if (!item) return;
        var index = parseInt(item.getAttribute('data-index'), 10);
        if (isNaN(index) || !STATE.searchResults[index]) return;
        var song = STATE.searchResults[index];
        if (e.target.closest('.rmp-add-btn')) {
          addToPlaylist(song);
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已添加到播放列表');
          return;
        }
        var idx = addToPlaylist(song);
        playSong(song, idx);
      }
      refs.gdSearchResults.addEventListener('click', onGdResultsClick);
      STATE.appCleanups.push(function () { refs.gdSearchResults.removeEventListener('click', onGdResultsClick); });
    }

    // ===== 播放列表事件 =====
    function onPlaylistClick(e) {
      var item = e.target.closest('.rmp-song-item');
      if (!item) return;
      var index = parseInt(item.getAttribute('data-index'), 10);
      if (isNaN(index)) return;
      if (e.target.closest('.rmp-remove-btn')) {
        removeFromPlaylist(index);
        return;
      }
      if (STATE.playlist[index]) { playSong(STATE.playlist[index], index); }
    }
    if (refs.playlistItems) {
      refs.playlistItems.addEventListener('click', onPlaylistClick);
      STATE.appCleanups.push(function () { refs.playlistItems.removeEventListener('click', onPlaylistClick); });
    }
    if (refs.clearPlaylistBtn) {
      refs.clearPlaylistBtn.addEventListener('click', clearPlaylist);
      STATE.appCleanups.push(function () { refs.clearPlaylistBtn.removeEventListener('click', clearPlaylist); });
    }

    // ===== 播放控件 =====
    refs.playBtn.addEventListener('click', togglePlay);
    STATE.appCleanups.push(function () { refs.playBtn.removeEventListener('click', togglePlay); });
    refs.prevBtn.addEventListener('click', playPrev);
    STATE.appCleanups.push(function () { refs.prevBtn.removeEventListener('click', playPrev); });
    refs.nextBtn.addEventListener('click', playNext);
    STATE.appCleanups.push(function () { refs.nextBtn.removeEventListener('click', playNext); });

    function onModeClick() {
      var modes = ['list', 'one', 'random'];
      var idx = modes.indexOf(STATE.playMode);
      setPlayMode(modes[(idx + 1) % modes.length]);
    }
    refs.modeBtn.addEventListener('click', onModeClick);
    STATE.appCleanups.push(function () { refs.modeBtn.removeEventListener('click', onModeClick); });

    // 进度条
    var isAppDraggingProgress = false;
    function appProgressSeek(e) {
      if (!STATE.audio) return;
      var rect = refs.progressBar.getBoundingClientRect();
      var clientX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      var x = clientX - rect.left;
      var percent = Math.max(0, Math.min(1, x / rect.width));
      var dur = getSafeDuration();
      seek(dur > 0 ? percent * dur : 0);
    }
    function onAppProgressStart(e) {
      e.stopPropagation(); e.preventDefault();
      isAppDraggingProgress = true; appProgressSeek(e);
      document.addEventListener('mousemove', onAppProgressMove);
      document.addEventListener('mouseup', onAppProgressEnd);
      document.addEventListener('touchmove', onAppProgressMove, { passive: false });
      document.addEventListener('touchend', onAppProgressEnd);
    }
    function onAppProgressMove(e) { if (!isAppDraggingProgress) return; e.preventDefault(); appProgressSeek(e); }
    function onAppProgressEnd() {
      isAppDraggingProgress = false;
      document.removeEventListener('mousemove', onAppProgressMove);
      document.removeEventListener('mouseup', onAppProgressEnd);
      document.removeEventListener('touchmove', onAppProgressMove);
      document.removeEventListener('touchend', onAppProgressEnd);
    }
    refs.progressBar.addEventListener('mousedown', onAppProgressStart);
    refs.progressBar.addEventListener('touchstart', onAppProgressStart, { passive: false });
    STATE.appCleanups.push(function () {
      refs.progressBar.removeEventListener('mousedown', onAppProgressStart);
      refs.progressBar.removeEventListener('touchstart', onAppProgressStart);
    });

    // 音量
    function onVolumeChange(e) { setVolume(parseFloat(e.target.value)); }
    refs.volumeSlider.addEventListener('input', onVolumeChange);
    STATE.appCleanups.push(function () { refs.volumeSlider.removeEventListener('input', onVolumeChange); });

    // ===== 保存设置 =====
    function onSaveSettings() {
      var backend = refs.backendInput.value.trim();
      if (backend) { STATE.backend = backend.replace(/\/+$/, ''); }
      STATE.defaultSource = refs.defaultSourceSelect.value;
      STATE.quality = refs.qualitySelect.value;
      var cookieVal = refs.cookieInput.value.trim();
      if (cookieVal) {
        STATE.cookie = cookieVal.replace(/\s+/g, '');
        // 验证 cookie 格式
        if (!STATE.cookie.match(/MUSIC_U=/i)) {
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('Cookie 格式无效，需要包含 MUSIC_U');
          return;
        }
        // 先保存 cookie 再验证
        saveSettings();
        // 验证 cookie 有效性
        var headers = { 'X-Netease-Cookie': STATE.cookie };
        fetch('https://music.163.com/api/nuser/account/get', { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': STATE.cookie } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var profile = data.profile || {};
            if (profile.userId) {
              STATE.userProfile = { userId: profile.userId, nickname: profile.nickname, avatarUrl: profile.avatarUrl, vipType: profile.vipType };
              STATE.roche.storage.set('rmp_user_profile', JSON.stringify(STATE.userProfile));
              updateNeteaseLoginUI();
              if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('Cookie 验证成功：' + profile.nickname);
            } else {
              if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('Cookie 可能已过期，部分功能不可用');
            }
          }).catch(function () {});
      }
      saveSettings();
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('设置已保存');
      // 切换回网易云面板
      switchTab('netease');
    }
    refs.saveSettingsBtn.addEventListener('click', onSaveSettings);
    STATE.appCleanups.push(function () { refs.saveSettingsBtn.removeEventListener('click', onSaveSettings); });

    // ===== 关闭按钮 =====
    function onCloseClick() {
      if (STATE.roche && STATE.roche.ui && typeof STATE.roche.ui.closeApp === 'function') {
        STATE.roche.ui.closeApp();
      }
    }
    refs.closeBtn.addEventListener('click', onCloseClick);
    STATE.appCleanups.push(function () { refs.closeBtn.removeEventListener('click', onCloseClick); });

    // ===== 重置灵动岛 =====
    refs.resetIslandBtn.addEventListener('click', function () {
      STATE.islandClosed = false;
      STATE.islandMinimized = false;
      STATE.islandVisible = true;
      refs.islandVisibleToggle.classList.add('on');
      if (STATE.islandEl) {
        STATE.islandEl.classList.remove('rmp-island-minimized');
        STATE.islandEl.style.display = '';
      }
      saveSettings();
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('灵动岛已恢复显示');
    });

    // 灵动岛设置
    function onIslandTopInput() {
      var v = parseInt(refs.islandTopInput.value, 10); if (isNaN(v)) v = 8;
      v = Math.max(0, Math.min(100, v)); STATE.islandTop = v;
      if (STATE.islandEl) { STATE.islandEl.style.setProperty('--rmp-island-top', v + 'px'); document.documentElement.style.setProperty('--rmp-island-top', v + 'px'); }
    }
    refs.islandTopInput.addEventListener('input', onIslandTopInput);
    STATE.appCleanups.push(function () { refs.islandTopInput.removeEventListener('input', onIslandTopInput); });
    function onIslandScrollModeChange() { STATE.islandScrollMode = refs.islandScrollModeSelect.value; updateIslandSongInfo(); saveSettings(); }
    refs.islandScrollModeSelect.addEventListener('change', onIslandScrollModeChange);
    STATE.appCleanups.push(function () { refs.islandScrollModeSelect.removeEventListener('change', onIslandScrollModeChange); });
    function onIslandVisibleToggle() { STATE.islandVisible = !STATE.islandVisible; refs.islandVisibleToggle.classList.toggle('on', STATE.islandVisible); if (STATE.islandEl) STATE.islandEl.style.display = STATE.islandVisible ? '' : 'none'; saveSettings(); }
    refs.islandVisibleToggle.addEventListener('click', onIslandVisibleToggle);
    STATE.appCleanups.push(function () { refs.islandVisibleToggle.removeEventListener('click', onIslandVisibleToggle); });
    function onLyricsFullToggle() { STATE.lyricsFullInject = !STATE.lyricsFullInject; refs.lyricsFullToggle.classList.toggle('on', STATE.lyricsFullInject); saveSettings(); updateContextInject(); }
    refs.lyricsFullToggle.addEventListener('click', onLyricsFullToggle);
    STATE.appCleanups.push(function () { refs.lyricsFullToggle.removeEventListener('click', onLyricsFullToggle); });

    // ===== char 点歌音源切换 =====
    function onCharSourceChange() {
      STATE.charSource = refs.charSourceSelect.value;
      saveSettings();
      if (STATE.roche && STATE.roche.ui) {
        STATE.roche.ui.toast(STATE.charSource === 'netease' ? 'char 点歌将使用网易云个人账号' : 'char 点歌将使用第三方音乐源');
      }
    }
    if (refs.charSourceSelect) {
      refs.charSourceSelect.addEventListener('change', onCharSourceChange);
      STATE.appCleanups.push(function () { refs.charSourceSelect.removeEventListener('change', onCharSourceChange); });
    }

    // ===== 调试日志 =====
    if (refs.debugRefreshBtn) {
      refs.debugRefreshBtn.addEventListener('click', renderDebugLogs);
      STATE.appCleanups.push(function () { refs.debugRefreshBtn.removeEventListener('click', renderDebugLogs); });
    }
    if (refs.debugCopyBtn) {
      function onDebugCopy() {
        var text = debugLogs.join('\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('日志已复制');
          }).catch(function () {
            if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('复制失败');
          });
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('日志已复制'); } catch (e) {}
          document.body.removeChild(ta);
        }
      }
      refs.debugCopyBtn.addEventListener('click', onDebugCopy);
      STATE.appCleanups.push(function () { refs.debugCopyBtn.removeEventListener('click', onDebugCopy); });
    }
    if (refs.debugClearBtn) {
      function onDebugClear() {
        debugLogs.length = 0;
        renderDebugLogs();
      }
      refs.debugClearBtn.addEventListener('click', onDebugClear);
      STATE.appCleanups.push(function () { refs.debugClearBtn.removeEventListener('click', onDebugClear); });
    }
    renderDebugLogs();

    // ===== 网易云免责声明（纯展示，无勾选交互） =====
  }

  // 切换标签页
  function switchTab(tabName) {
    STATE.currentTab = tabName;
    STATE.appRefs.tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
    });
    STATE.appRefs.panels.forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === tabName);
    });
  }

  // 渲染调试日志（设置页，最新 50 条倒序）
  function renderDebugLogs() {
    var refs = STATE.appRefs;
    if (!refs.debugLogsEl) return;
    if (!debugLogs || debugLogs.length === 0) {
      refs.debugLogsEl.innerHTML = '<div class="rmp-debug-empty">暂无日志，先操作插件（搜索/播放/登录）再点刷新</div>';
      return;
    }
    var last = debugLogs.slice(-50).reverse();
    refs.debugLogsEl.innerHTML = last.map(function (l) {
      var cls = (l.indexOf('[ERR]') >= 0 || l.indexOf('[WINERR]') >= 0) ? ' err' : '';
      return '<div class="rmp-debug-line' + cls + '">' + escapeHtml(l) + '</div>';
    }).join('');
    refs.debugLogsEl.scrollTop = 0;
  }

  // 渲染搜索结果
  // 生成基于歌名的渐变色（用于无封面时的占位）
  function gradientFromName(name) {
    var hash = 0;
    var str = String(name || 'M');
    for (var i = 0; i < str.length; i++) { hash = str.charCodeAt(i) + ((hash << 5) - hash); }
    var h1 = Math.abs(hash) % 360;
    var h2 = (h1 + 60) % 360;
    return 'linear-gradient(135deg, hsl(' + h1 + ',50%,35%), hsl(' + h2 + ',50%,25%))';
  }

  // 渲染网易云搜索结果
  function renderNeSearchResults() {
    var refs = STATE.appRefs;
    if (!refs.neSearchResults) return;
    var songs = STATE.searchResults;
    if (!songs || songs.length === 0) {
      refs.neSearchResults.innerHTML = '<div class="rmp-empty-state">没有找到相关歌曲</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      var cover = isFullUrl(s.cover) ? s.cover : (isFullUrl(s.picId) ? s.picId : '');
      if (cover && cover.indexOf('//') === 0) cover = 'https:' + cover;
      var duration = s.duration ? formatTime(s.duration) : '';
      var artistName = s.artist || (s.ar ? s.ar.map(function (a) { return a.name; }).join(' / ') : '');
      html += '<div class="rmp-song-item" data-index="' + i + '">';
      if (cover) {
        html += '<img class="rmp-song-cover" src="' + escapeHtml(cover) + '" alt="" />';
      } else {
        html += '<div class="rmp-song-cover">' + (s.name ? s.name.charAt(0) : '?') + '</div>';
      }
      html += '<div class="rmp-song-info">';
      html += '<div class="rmp-song-name">' + escapeHtml(s.name || '') + '</div>';
      html += '<div class="rmp-song-meta">' + escapeHtml(artistName || '') + '</div>';
      html += '</div>';
      html += '<div class="rmp-song-duration">' + escapeHtml(duration) + '</div>';
      html += '<div class="rmp-song-actions"><button class="rmp-btn-icon rmp-add-btn" title="添加到播放列表"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button></div>';
      html += '</div>';
    }
    refs.neSearchResults.innerHTML = html;
    // GD搜索返回的cover为空、picId为图片ID，需异步补拉真实封面URL
    hydrateSearchCovers(refs.neSearchResults, songs);
  }

  // 渲染 GD 音乐台搜索结果
  function renderGdSearchResults() {
    var refs = STATE.appRefs;
    if (!refs.gdSearchResults) return;
    var songs = STATE.searchResults;
    if (!songs || songs.length === 0) {
      refs.gdSearchResults.innerHTML = '<div class="rmp-empty-state">没有找到相关歌曲</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      var cover = isFullUrl(s.cover) ? s.cover : (isFullUrl(s.picId) ? s.picId : '');
      if (cover && cover.indexOf('//') === 0) cover = 'https:' + cover;
      var duration = s.duration ? formatTime(s.duration) : '';
      var artistName = s.artist || '';
      html += '<div class="rmp-song-item" data-index="' + i + '">';
      if (cover) {
        html += '<img class="rmp-song-cover" src="' + escapeHtml(cover) + '" alt="" />';
      } else {
        html += '<div class="rmp-song-cover">' + (s.name ? s.name.charAt(0) : '?') + '</div>';
      }
      html += '<div class="rmp-song-info">';
      html += '<div class="rmp-song-name">' + escapeHtml(s.name || '') + '</div>';
      html += '<div class="rmp-song-meta">' + escapeHtml(artistName || '') + '</div>';
      html += '</div>';
      html += '<span class="rmp-song-platform">' + escapeHtml(s.platform || 'joox') + '</span>';
      html += '<div class="rmp-song-duration">' + escapeHtml(duration) + '</div>';
      html += '<div class="rmp-song-actions"><button class="rmp-btn-icon rmp-add-btn" title="添加到播放列表"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button></div>';
      html += '</div>';
    }
    refs.gdSearchResults.innerHTML = html;
    // GD搜索返回的cover为空、picId为图片ID，需异步补拉真实封面URL
    hydrateSearchCovers(refs.gdSearchResults, songs);
  }

  // 更新 App 播放状态
  function updateAppPlayState() {
    if (!STATE.appRefs.playBtn) return;
    STATE.appRefs.playBtn.innerHTML = STATE.isPlaying ? ICONS.pause : ICONS.play;
    // 切换唱片旋转动画
    var coverWrap = STATE.appRefs.root ? STATE.appRefs.root.querySelector('.rmp-np-cover-wrap') : null;
    var cover = STATE.appRefs.npCover;
    if (coverWrap) coverWrap.classList.toggle('playing', !!STATE.isPlaying && !!STATE.currentSong);
    if (cover) cover.classList.toggle('playing', !!STATE.isPlaying && !!STATE.currentSong);
    // 更新搜索结果中的播放状态
    if (STATE.searchResults.length > 0) { renderNeSearchResults(); renderGdSearchResults(); }
    if (STATE.playlist.length > 0) renderPlaylistUI();
  }

  // 更新 App 歌曲信息
  function updateAppSongInfo() {
    var refs = STATE.appRefs;
    if (!refs.npTitle) return;
    var song = STATE.currentSong;
    if (!song) {
      refs.npTitle.textContent = '未播放';
      refs.npArtist.textContent = '';
      refs.npAlbum.textContent = '';
      refs.npCover.src = '';
      refs.npCover.style.opacity = '0';
      refs.totalTime.textContent = '0:00';
      refs.currentTime.textContent = '0:00';
      refs.progressFill.style.width = '0%';
      var cw = refs.root ? refs.root.querySelector('.rmp-np-cover-wrap') : null;
      if (cw) cw.classList.remove('playing');
      refs.npCover.classList.remove('playing');
      return;
    }
    refs.npTitle.textContent = song.name || '未知歌曲';
    refs.npArtist.textContent = song.artist || '未知歌手';
    refs.npAlbum.textContent = song.album || '';
    if (song.cover) {
      refs.npCover.src = song.cover;
      refs.npCover.style.opacity = '1';
      refs.npCover.style.background = '';
    } else {
      refs.npCover.src = '';
      refs.npCover.style.opacity = '1';
      refs.npCover.style.background = gradientFromName(song.name);
    }
    refs.npCover.onerror = function () { refs.npCover.style.opacity = '0.3'; };
    refs.totalTime.textContent = formatTime(song.duration);
  }

  // 更新 App 进度
  function updateAppProgress() {
    if (!STATE.appRefs.progressFill || !STATE.audio) return;
    var dur = getSafeDuration();
    var percent = dur > 0 ? (STATE.audio.currentTime / dur) * 100 : 0;
    STATE.appRefs.progressFill.style.width = percent + '%';
    STATE.appRefs.currentTime.textContent = formatTime(STATE.audio.currentTime);
    if (dur > 0) {
      STATE.appRefs.totalTime.textContent = formatTime(dur);
    }
  }

  // 更新 App 播放模式
  function updateAppPlayMode() {
    if (!STATE.appRefs.modeBtn) return;
    var icon = '';
    var title = '';
    switch (STATE.playMode) {
      case 'one':
        icon = ICONS.repeatOne;
        title = '单曲循环';
        break;
      case 'random':
        icon = ICONS.shuffle;
        title = '随机播放';
        break;
      default:
        icon = ICONS.list;
        title = '列表循环';
        break;
    }
    STATE.appRefs.modeBtn.innerHTML = icon;
    STATE.appRefs.modeBtn.title = title;
  }

  // 渲染 App 歌词
  function renderAppLyrics() {
    if (!STATE.appRefs.lyricsContainer) return;
    if (!STATE.lyrics || STATE.lyrics.length === 0) {
      STATE.appRefs.lyricsContainer.innerHTML = '<div class="rmp-lyrics-empty">暂无歌词</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < STATE.lyrics.length; i++) {
      var line = STATE.lyrics[i];
      // 查找对应时间的翻译
      var translation = '';
      if (STATE.tlyrics && STATE.tlyrics.length > 0) {
        var tIdx = getCurrentLyricIndex(STATE.tlyrics, line.time);
        if (tIdx >= 0 && STATE.tlyrics[tIdx] && Math.abs(STATE.tlyrics[tIdx].time - line.time) < 1) {
          translation = STATE.tlyrics[tIdx].text;
        }
      }
      html += '<div class="rmp-lyric-line" data-index="' + i + '">';
      html += escapeHtml(line.text || '...');
      if (translation) {
        html += '<div class="rmp-lyric-translation">' + escapeHtml(translation) + '</div>';
      }
      html += '</div>';
    }
    STATE.appRefs.lyricsContainer.innerHTML = html;
    updateAppLyricsHighlight();
  }

  // 更新 App 歌词高亮
  function updateAppLyricsHighlight() {
    if (!STATE.appRefs.lyricsContainer) return;
    var lines = STATE.appRefs.lyricsContainer.querySelectorAll('.rmp-lyric-line');
    if (lines.length === 0) return;

    lines.forEach(function (line, i) {
      line.classList.toggle('active', i === STATE.currentLyricIndex);
    });

    // 滚动到当前歌词
    if (STATE.currentLyricIndex >= 0 && lines[STATE.currentLyricIndex]) {
      var activeLine = lines[STATE.currentLyricIndex];
      var container = STATE.appRefs.lyricsContainer;
      var scrollTarget = activeLine.offsetTop - container.clientHeight / 2 + activeLine.clientHeight / 2;
      container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    }
  }

  // 渲染播放列表
  function renderPlaylistUI() {
    var refs = STATE.appRefs;
    if (!refs.playlistItems) return;
    refs.playlistCount.textContent = STATE.playlist.length + ' 首';
    if (STATE.playlist.length === 0) {
      refs.playlistItems.innerHTML = '<div class="rmp-empty-state">播放列表为空，去搜索添加歌曲吧</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < STATE.playlist.length; i++) {
      var song = STATE.playlist[i];
      var isCurrent = i === STATE.currentIndex;
      var coverHtml;
      if (song.cover) {
        coverHtml = '<img class="rmp-song-cover" src="' + escapeHtml(song.cover) + '" alt="" onerror="this.style.opacity=0.3;" />';
      } else {
        var firstChar = (song.name || 'M').charAt(0).toUpperCase();
        coverHtml = '<div class="rmp-song-cover" style="background:' + gradientFromName(song.name) + '">' + escapeHtml(firstChar) + '</div>';
      }
      // 当前播放显示声波动画，否则显示序号
      var indicatorHtml = isCurrent
        ? '<div class="rmp-equalizer' + (STATE.isPlaying ? '' : ' paused') + '"><span></span><span></span><span></span></div>'
        : '<span class="rmp-song-index">' + (i + 1) + '</span>';
      html += '\
<div class="rmp-song-item' + (isCurrent ? ' playing' : '') + '" data-index="' + i + '">\
  ' + coverHtml + '\
  <div class="rmp-song-info">\
    <div class="rmp-song-name">' + escapeHtml(song.name || '未知歌曲') + '</div>\
    <div class="rmp-song-meta">' + escapeHtml(song.artist || '未知歌手') + '</div>\
  </div>\
  <span class="rmp-song-platform">' + escapeHtml(song.platform || '') + '</span>\
  ' + indicatorHtml + '\
  <div class="rmp-song-actions">\
    <button class="rmp-btn-icon rmp-remove-btn" title="移除">' + ICONS.remove + '</button>\
  </div>\
</div>';
    }
    refs.playlistItems.innerHTML = html;
  }

  // 获取网易云用户信息
  function fetchUserInfo() {
    if (!STATE.cookie) return Promise.resolve(null);
    return neteaseApi('/api/nuser/account/get').then(function (data) {
      if (data && data.profile) {
        STATE.userProfile = data.profile;
        saveSettings();
        return data.profile;
      }
      return null;
    }).catch(function () { return null; });
  }

  // 更新网易云登录 UI
  function updateNeteaseLoginUI() {
    var refs = STATE.appRefs;
    if (!refs.neLoggedOut) return;
    var hasLogin = (STATE.cookie || STATE.mcpToken) && STATE.userProfile;
    if (hasLogin) {
      refs.neLoggedOut.style.display = 'none';
      refs.neLoggedIn.style.display = '';
      if (STATE.userProfile) {
        refs.neAvatar.src = STATE.userProfile.avatarUrl || '';
        refs.neNickname.textContent = STATE.userProfile.nickname || '用户';
        if (STATE.userProfile.vipType > 0) {
          refs.neVipBadge.textContent = 'VIP会员';
          refs.neVipBadge.style.color = '#C20C0C';
        } else {
          refs.neVipBadge.textContent = '网易云音乐用户';
          refs.neVipBadge.style.color = 'rgba(255,255,255,0.4)';
        }
      }
    } else {
      refs.neLoggedOut.style.display = '';
      refs.neLoggedIn.style.display = 'none';
    }
  }

  // 加载每日推荐
  function loadDailyRecommend() {
    var refs = STATE.appRefs;
    if (!refs.neRecsList) return;
    if (!STATE.cookie) {
      refs.neRecsList.innerHTML = '<div class="rmp-empty-state">请先在设置中填写网易云 Cookie</div>';
      return;
    }
    refs.neRecsList.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';
    var csrf = getNeCsrf();
    neteaseApi('/api/v3/discovery/recommend/songs?csrf_token=' + encodeURIComponent(csrf), '{}', 'POST').then(function(resp) {
      var raw = (resp.data || {}).dailySongs || [];
      var songs = raw.map(function(s) {
        var al = s.al || s.album || {};
        var ar = s.ar || s.artists || [];
        return {
          id: String(s.id), name: s.name || '',
          artist: ar.map(function(a) { return a.name; }).join(' / '),
          album: al.name || '', picId: toHttps(al.picUrl) || '',
          cover: toHttps(al.picUrl) || '', lyricId: String(s.id),
          duration: Math.round((s.dt || s.duration || 0) / 1000),
          platform: 'netease', _personal: true
        };
      });
      if (songs.length === 0) {
        refs.neRecsList.innerHTML = '<div class="rmp-empty-state">今日暂无推荐，请确认Cookie有效</div>';
        return;
      }
      renderRecsList(songs);
    }).catch(function() {
      refs.neRecsList.innerHTML = '<div class="rmp-empty-state">加载失败，请检查Cookie是否有效</div>';
    });
  }

  function renderRecsList(songs) {
    var refs = STATE.appRefs;
    if (!songs || songs.length === 0) {
      refs.neRecsList.innerHTML = '<div class="rmp-empty-state">今日暂无推荐</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      var cover = s.album ? (s.album.picUrl || s.album.coverImgUrl || '') : (s.picUrl || s.cover || '');
      if (cover && cover.indexOf('//') === 0) cover = 'https:' + cover;
      cover = toHttps(cover) || '';
      var artist = s.artist || (s.ar ? s.ar.map(function(a){return a.name;}).join(' / ') : '');
      var name = s.name || '';
      html += '<div class="rmp-song-item" data-rec-index="' + i + '">';
      if (cover) html += '<img class="rmp-song-cover" src="' + escapeHtml(cover) + '" alt="" />';
      else html += '<div class="rmp-song-cover">' + (name ? name.charAt(0) : '?') + '</div>';
      html += '<div class="rmp-song-info"><div class="rmp-song-name">' + escapeHtml(name) + '</div>';
      html += '<div class="rmp-song-meta">' + escapeHtml(artist) + '</div></div>';
      if (s.reason) html += '<span style="font-size:10px;color:rgba(255,255,255,0.3);margin-left:4px;flex-shrink:0;">' + escapeHtml(s.reason) + '</span>';
      html += '<div class="rmp-song-actions"><button class="rmp-btn-icon rmp-add-btn"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button></div>';
      html += '</div>';
    }
    refs.neRecsList.innerHTML = html;

    // 点击事件
    refs.neRecsList.querySelectorAll('.rmp-song-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        var idx = parseInt(this.getAttribute('data-rec-index'), 10);
        if (isNaN(idx) || !songs[idx]) return;
        if (e.target.closest('.rmp-add-btn')) {
          addToPlaylist(songs[idx]);
          if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已添加到播放列表');
          return;
        }
        var pi = addToPlaylist(songs[idx]);
        playSong(songs[idx], pi);
      });
    });
  }

  // 加载用户歌单列表
  function loadUserPlaylists() {
    var refs = STATE.appRefs;
    if (!refs.nePlaylists) return;
    if (!STATE.cookie) {
      refs.nePlaylists.innerHTML = '<div class="rmp-empty-state">请先在设置中填写网易云 Cookie</div>';
      return;
    }
    refs.nePlaylists.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';

    function renderPls(list) {
      if (!list || list.length === 0) {
        refs.nePlaylists.innerHTML = '<div class="rmp-empty-state">暂无歌单，请确认已登录</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var pl = list[i];
        var cover = pl.coverImgUrl || '';
        html += '<div class="rmp-netease-pl-item" data-id="' + pl.id + '">';
        html += '<img class="rmp-netease-pl-cover" src="' + escapeHtml(cover) + '" alt="" />';
        html += '<div class="rmp-netease-pl-info">';
        html += '<div class="rmp-netease-pl-name">' + escapeHtml(pl.name) + '</div>';
        html += '<div class="rmp-netease-pl-meta">' + (pl.trackCount || 0) + ' 首歌曲</div>';
        html += '</div>';
        html += '<span class="rmp-netease-pl-arrow">→</span>';
        html += '</div>';
      }
      refs.nePlaylists.innerHTML = html;
    }

    // 先获取用户ID，再获取歌单
    neteaseApi('/api/nuser/account/get').then(function(resp) {
      var uid = (resp.profile || {}).userId;
      if (!uid) {
        refs.nePlaylists.innerHTML = '<div class="rmp-empty-state">获取用户信息失败，Cookie可能已过期</div>';
        return;
      }
      return neteaseApi('/api/user/playlist?uid=' + uid + '&limit=50&offset=0');
    }).then(function(resp) {
      if (!resp) return;
      renderPls(resp.playlist || []);
    }).catch(function() {
      refs.nePlaylists.innerHTML = '<div class="rmp-empty-state">加载失败，请检查Cookie</div>';
    });
  }

  // 加载歌单歌曲
  function loadPlaylistSongs(plId) {
    var refs = STATE.appRefs;
    if (!STATE.cookie) {
      refs.neSearchResults.innerHTML = '<div class="rmp-empty-state">请先设置Cookie</div>';
      return;
    }
    refs.neSearchResults.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';
    refs.neSubnavBtns.forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-nsub') === 'search'); });
    refs.neSubpanels.forEach(function(p) { p.classList.toggle('active', p.getAttribute('data-nsub') === 'search'); });

    neteaseApi('/api/v6/playlist/detail?id=' + plId).then(function(resp) {
      var playlist = resp.playlist || {};
      var tracks = playlist.tracks || [];
      if (tracks.length === 0) {
        var trackIds = (playlist.trackIds || []).slice(0, 50);
        if (trackIds.length > 0) {
          var ids = trackIds.map(function(t) { return t.id; });
          return neteaseApi('/api/song/detail?ids=' + JSON.stringify(ids));
        }
        return null;
      }
      return { songs: tracks };
    }).then(function(resp) {
      if (!resp) { refs.neSearchResults.innerHTML = '<div class="rmp-empty-state">歌单为空</div>'; return; }
      var tracks = resp.songs || resp.tracks || [];
      STATE.searchResults = tracks.map(function(t) {
        var ar = t.ar || t.artists || [];
        var al = t.al || t.album || {};
        return {
          id: String(t.id), name: t.name || '',
          artist: ar.map(function(a) { return a.name; }).join(' / '),
          album: al.name || '', picId: toHttps(al.picUrl) || '',
          cover: toHttps(al.picUrl) || '', lyricId: String(t.id),
          duration: Math.round((t.dt || t.duration || 0) / 1000), platform: 'netease',
          _personal: true
        };
      });
      renderNeSearchResults();
    }).catch(function() {
      refs.neSearchResults.innerHTML = '<div class="rmp-empty-state">加载失败</div>';
    });
  }

  // 退出登录
  function doLogout() {
    STATE.cookie = '';
    STATE.mcpToken = '';
    STATE.userProfile = null;
    saveSettings();
    updateNeteaseLoginUI();
    if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已退出网易云登录');
  }

  // 网易云扫码登录（动态创建弹窗）
  function startQrLogin() {
    // 清除旧弹窗
    var oldModal = document.querySelector('.rmp-qr-modal');
    if (oldModal) oldModal.remove();
    if (STATE.qrPollTimer) { clearInterval(STATE.qrPollTimer); STATE.qrPollTimer = null; }

    // 创建弹窗
    var overlay = document.createElement('div');
    overlay.className = 'rmp-qr-modal';
    overlay.innerHTML = '<div class="rmp-qr-modal-mask"></div>' +
      '<div class="rmp-qr-modal-box">' +
        '<div class="rmp-qr-modal-close">×</div>' +
        '<div class="rmp-qr-modal-title">网易云扫码登录</div>' +
        '<div class="rmp-qr-modal-body">' +
          '<div class="rmp-qr-img-wrap"><img class="rmp-qr-img-el" style="display:none;" /><div class="rmp-qr-placeholder-el">正在获取二维码...</div></div>' +
          '<div class="rmp-qr-status-el"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var qrImg = overlay.querySelector('.rmp-qr-img-el');
    var qrPlaceholder = overlay.querySelector('.rmp-qr-placeholder-el');
    var qrStatus = overlay.querySelector('.rmp-qr-status-el');

    // 关闭按钮
    overlay.querySelector('.rmp-qr-modal-close').addEventListener('click', function() {
      overlay.remove();
      if (STATE.qrPollTimer) { clearInterval(STATE.qrPollTimer); STATE.qrPollTimer = null; }
    });
    overlay.querySelector('.rmp-qr-modal-mask').addEventListener('click', function() {
      overlay.remove();
      if (STATE.qrPollTimer) { clearInterval(STATE.qrPollTimer); STATE.qrPollTimer = null; }
    });

    getQrLogin().then(function (data) {
      if (!data || !data.qr_url) {
        qrPlaceholder.textContent = '获取二维码失败';
        qrStatus.textContent = data && data.raw && data.raw.message ? data.raw.message : '请检查网络';
        qrStatus.className = 'rmp-qr-status-el error';
        return;
      }
      var qrUrl = data.qr_url;
      var qrImgSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qrUrl);
      qrImg.src = qrImgSrc;
      qrImg.style.display = 'block';
      qrPlaceholder.style.display = 'none';
      qrStatus.innerHTML = '请用<strong>网易云音乐 APP</strong>扫码<br><a href="' + qrUrl + '" target="_blank" style="color:#6cf;">手机上打不开？点此链接</a>';
      qrStatus.className = 'rmp-qr-status-el';

      STATE.qrPollTimer = setInterval(function () {
        if (!document.body.contains(overlay)) {
          clearInterval(STATE.qrPollTimer);
          STATE.qrPollTimer = null;
          return;
        }
        checkQrLogin().then(function (result) {
          if (!result) return;
          if (result.logged_in) {
            qrStatus.textContent = '登录成功！';
            qrStatus.className = 'rmp-qr-status-el success';
            if (result.access_token) {
              STATE.mcpToken = result.access_token;
              saveSettings();
            }
            if (result.user_info && result.user_info.nickname) {
              STATE.userProfile = result.user_info;
              STATE.roche.storage.set('rmp_user_profile', JSON.stringify(result.user_info));
              updateNeteaseLoginUI();
              if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('网易云登录成功：' + result.user_info.nickname);
            } else {
              updateNeteaseLoginUI();
              if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('网易云登录成功');
            }
            clearInterval(STATE.qrPollTimer);
            STATE.qrPollTimer = null;
            setTimeout(function() { overlay.remove(); }, 1500);
          } else {
            var raw = result.raw || {};
            if (raw.code === 800) {
              qrStatus.textContent = '二维码已过期，请重新获取';
              qrStatus.className = 'rmp-qr-status-el error';
              clearInterval(STATE.qrPollTimer);
              STATE.qrPollTimer = null;
            } else if (raw.code === 802) {
              qrStatus.textContent = '待确认，请在手机上点击确认登录';
              qrStatus.className = 'rmp-qr-status-el';
            }
          }
        }).catch(function () {
          // 忽略轮询错误
        });
      }, 2000);
    }).catch(function () {
      qrPlaceholder.textContent = '获取二维码失败';
      qrStatus.textContent = '请求失败，请检查网络';
      qrStatus.className = 'rmp-qr-status-el error';
    });
  }

  // 清理 App
  function cleanupApp() {
    // 清理事件监听器
    STATE.appCleanups.forEach(function (fn) { fn(); });
    STATE.appCleanups = [];

    // 清理 QR 轮询
    if (STATE.qrPollTimer) {
      clearInterval(STATE.qrPollTimer);
      STATE.qrPollTimer = null;
    }

    // 移除样式
    if (STATE.appStyleEl && STATE.appStyleEl.parentNode) {
      STATE.appStyleEl.parentNode.removeChild(STATE.appStyleEl);
    }
    STATE.appStyleEl = null;

    // 清空容器
    if (STATE.appContainer) {
      STATE.appContainer.innerHTML = '';
    }
    STATE.appContainer = null;
    STATE.appRefs = {};
  }

  // ==================== 存储管理 ====================

  // 将 STATE 同步到设置面板所有 UI 控件（loadSettings 后调用）
  function syncSettingsToUI() {
    var refs = STATE.appRefs;
    if (!refs.root) return;
    if (refs.backendInput) refs.backendInput.value = STATE.backend;
    if (refs.cookieInput) refs.cookieInput.value = STATE.cookie || '';
    if (refs.defaultSourceSelect) refs.defaultSourceSelect.value = STATE.defaultSource;
    if (refs.qualitySelect) refs.qualitySelect.value = STATE.quality;
    if (refs.volumeSlider) refs.volumeSlider.value = STATE.volume;
    if (refs.islandTopInput) refs.islandTopInput.value = STATE.islandTop;
    if (refs.islandScrollModeSelect) refs.islandScrollModeSelect.value = STATE.islandScrollMode;
    if (refs.islandVisibleToggle) refs.islandVisibleToggle.classList.toggle('on', !!STATE.islandVisible);
    if (refs.lyricsFullToggle) refs.lyricsFullToggle.classList.toggle('on', !!STATE.lyricsFullInject);
    if (refs.charSourceSelect) refs.charSourceSelect.value = STATE.charSource;
  }

  // 保存设置到 roche.storage（顺序调用，避免并发导致持久化失败）
  function saveSettings() {
    if (!STATE.roche || !STATE.roche.storage) return;
    try {
      STATE.roche.storage.set('rmp_backend', STATE.backend);
      STATE.roche.storage.set('rmp_default_source', STATE.defaultSource);
      STATE.roche.storage.set('rmp_quality', STATE.quality);
      STATE.roche.storage.set('rmp_volume', String(STATE.volume));
      STATE.roche.storage.set('rmp_play_mode', STATE.playMode);
      STATE.roche.storage.set('rmp_island_top', String(STATE.islandTop));
      STATE.roche.storage.set('rmp_island_visible', STATE.islandVisible ? '1' : '0');
      STATE.roche.storage.set('rmp_island_scroll_mode', STATE.islandScrollMode);
      STATE.roche.storage.set('rmp_lyrics_full_inject', STATE.lyricsFullInject ? '1' : '0');
      STATE.roche.storage.set('rmp_agreed_disclaimer', '1');
      STATE.roche.storage.set('rmp_char_source', STATE.charSource);
      if (STATE.cookie) STATE.roche.storage.set('rmp_cookie', STATE.cookie);
      if (STATE.mcpToken) STATE.roche.storage.set('rmp_mcp_token', STATE.mcpToken);
      if (STATE.userProfile) STATE.roche.storage.set('rmp_user_profile', JSON.stringify(STATE.userProfile));
    } catch (e) {}
  }

  // 从 roche.storage 加载设置
  function loadSettings(roche) {
    if (!roche || !roche.storage) return Promise.resolve();
    return Promise.all([
      roche.storage.get('rmp_backend'),
      roche.storage.get('rmp_default_source'),
      roche.storage.get('rmp_quality'),
      roche.storage.get('rmp_volume'),
      roche.storage.get('rmp_play_mode'),
      roche.storage.get('rmp_cookie'),
      roche.storage.get('rmp_user_profile'),
      roche.storage.get('rmp_island_top'),
      roche.storage.get('rmp_island_visible'),
      roche.storage.get('rmp_island_scroll_mode'),
      roche.storage.get('rmp_playlist'),
      roche.storage.get('rmp_agreed_disclaimer'),
      roche.storage.get('rmp_extended_sources'),
      roche.storage.get('rmp_lyrics_full_inject'),
      roche.storage.get('rmp_mcp_token'),
      roche.storage.get('rmp_char_source')
    ]).then(function (results) {
      if (results[0]) STATE.backend = results[0];
      if (results[1]) STATE.defaultSource = results[1];
      if (results[2]) STATE.quality = results[2];
      if (results[3]) STATE.volume = parseFloat(results[3]) || 0.8;
      if (results[4]) STATE.playMode = results[4];
      if (results[5]) STATE.cookie = results[5];
      // 恢复用户信息（JSON）
      if (results[6]) { try { STATE.userProfile = JSON.parse(results[6]); } catch (e) {} }
      if (results[7]) {
        var t = parseInt(results[7], 10);
        if (!isNaN(t)) STATE.islandTop = Math.max(0, Math.min(100, t));
      }
      if (results[8] !== null && results[8] !== undefined && results[8] !== '') {
        STATE.islandVisible = results[8] === '1';
      }
      if (results[9] === 'lyric' || results[9] === 'title') {
        STATE.islandScrollMode = results[9];
      }
      // 加载持久化播放列表
      if (results[10]) {
        try {
          var saved = JSON.parse(results[10]);
          if (Array.isArray(saved) && saved.length > 0) {
            STATE.playlist = saved;
          }
        } catch (e) {}
      }
      // 歌词注入模式
      if (results[13] !== null && results[13] !== undefined && results[13] !== '') {
        STATE.lyricsFullInject = results[13] === '1';
      }
      // MCP 登录 token
      if (results[14]) STATE.mcpToken = results[14];
      // char 点歌音源
      if (results[15] === 'netease' || results[15] === 'gd') STATE.charSource = results[15];
    }).catch(function () {});
  }

  // ==================== ContextProvider ====================

  function contextProvider(ctx) {
    // 灵动岛被主动关闭，不注入歌曲信息
    if (STATE.islandClosed) return null;
    // 没有在听歌返回 null
    if (!STATE.currentSong || !STATE.audio) return null;

    var song = STATE.currentSong;
    var result = '【user当前正在听音乐】\n';
    result += '歌曲：《' + (song.name || '未知') + '》\n';
    result += '歌手：' + (song.artist || '未知') + '\n';
    result += '专辑：' + (song.album || '未知') + '\n';

    // 歌词注入（范围标注，不强调"当前"——存在时间差无意义）
    if (STATE.lyrics && STATE.lyrics.length > 0) {
      var curIdx = STATE.currentLyricIndex;
      if (curIdx < 0) curIdx = 0;

      if (STATE.lyricsFullInject) {
        // 模式B：全部歌词 + 标注当前10行范围
        result += '完整歌词（【>>>...<<<】为user正在听到的范围）：\n';
        var rangeStart = Math.max(0, curIdx - 5);
        var rangeEnd = Math.min(STATE.lyrics.length - 1, curIdx + 4);
        for (var i = 0; i < STATE.lyrics.length; i++) {
          var markers = '';
          if (i === rangeStart) markers += '【>>>';
          if (i === rangeEnd) markers += '<<<】';
          result += markers + (STATE.lyrics[i].text || '...') + '\n';
        }
      } else {
        // 模式A（默认）：仅注入当前前后各5行
        var start = Math.max(0, curIdx - 5);
        var end = Math.min(STATE.lyrics.length, curIdx + 6);
        result += '歌词（user正在听到的范围）：\n';
        for (var j = start; j < end; j++) {
          result += (STATE.lyrics[j].text || '...') + '\n';
        }
      }
    }

    return result;
  }

  // ==================== 插件注册 ====================

  window.RochePlugin = window.RochePlugin || {};

  // 版本号从 BUILD_TIME 动态读取，防止历次升级漏改写死的旧版本号
  var PLUGIN_VERSION = BUILD_TIME.indexOf('-v') >= 0 ? BUILD_TIME.split('-v')[1] : '1.16.6';

  window.RochePlugin.register({
    id: 'roche-music-player',
    name: '音乐播放器',
    version: PLUGIN_VERSION,

    apps: [{
      id: 'roche-music-player-home',
      name: '音乐播放器',
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#C20C0C"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>'),

      mount: function (container, roche) {
        STATE.roche = roche;
        renderApp(container);
        // 关键：在 mount 时初始化音频引擎、灵动岛（参考 xhs-reader）
        // 不依赖 onLoad，因为 Roche 可能不调用 onLoad
        // 用 STATE.initialized 防重复初始化
        if (!STATE.initialized) {
          // 核心组件（灵动岛、音频）先创建，不依赖设置加载
          initAudio();
          createIsland();
          // 加载设置是异步的，失败不影响核心功能
          loadSettings(roche).then(function () {
            updatePlayModeUI();
            syncSettingsToUI();
            // 恢复登录 UI（有 cookie 则尝试拉用户信息）
            if (STATE.cookie && STATE.userProfile) {
              updateNeteaseLoginUI();
            } else if (STATE.cookie) {
              fetchUserInfo().then(function () { updateNeteaseLoginUI(); });
            }
            STATE.initialized = true;
          }).catch(function (e) {
            STATE.initialized = true;
          });
        }
      },

      unmount: function (container, roche) {
        // 关键：仅清理 App 面板，不销毁灵动岛、不停止音频、不停止点歌监听
        // 保证关闭面板后音乐继续播放、灵动岛继续显示、点歌监听继续工作
        cleanupApp();
      }
    }],

    chat: {
      scope: { conversationTypes: ['direct', 'group'] },
      // 点歌方式：工具调用（声明 play_song 工具，char 调用即可点歌）
      promptOnly: '你具有音乐点歌能力。当你想让 user 听某首歌时，调用 play_song 工具（参数：song 歌名，artist 歌手可选）搜索并播放。调用后可以正常说话，user 会看到歌曲切换。同时你能感知 user 当前正在听的音乐内容（如果已注入）。',
      contextProvider: contextProvider,
      tools: [{
        id: 'play_song',
        description: '搜索并播放一首歌给 user 听。当你想让 user 听音乐时调用此工具。',
        parameters: { song: 'string', artist: 'string' },
        execute: function (args, ctx) {
          var songName = String((args && args.song) || '');
          var artist = String((args && args.artist) || '');
          if (!songName) return Promise.resolve({ error: 'missing song name' });
          var keyword = artist ? (songName + ' ' + artist) : songName;
          var limit = 10;
          // 选择结果中与歌名最匹配的歌曲
          function pickBest(results) {
            var best = results[0];
            for (var i = 0; i < results.length; i++) {
              if (results[i].name && results[i].name.indexOf(songName) >= 0) {
                best = results[i];
                break;
              }
            }
            return best;
          }
          function playBest(best) {
            var idx = addToPlaylist(best);
            playSong(best, idx);
            return { success: true, song: best.name, artist: best.artist, platform: best.platform, instrumental: !!best.instrumental };
          }
          // 模式 A：网易云个人账号（设置中 charSource === 'netease'）
          if (STATE.charSource === 'netease') {
            if (!STATE.cookie) {
              return Promise.resolve({ success: false, message: '请先在设置中填写网易云 Cookie，或切换到第三方音乐源' });
            }
            // 用用户自己的网易云账号搜索（走 VPS 代理）
            // 网易云搜索加超时（12 秒），避免 VPS 慢导致 char 长时间等待
            var searchPromise = neteaseApi('/api/search/get?s=' + encodeURIComponent(keyword) + '&type=1&limit=' + limit);
            var timeoutPromise = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 12000); });
            return Promise.race([searchPromise, timeoutPromise]).then(function (resp) {
              if (!resp) {
                return { success: false, message: '网易云搜索超时，请稍后重试或切换第三方音乐源' };
              }
              var result = resp.result ? resp.result : {};
              var songs = (result.songs || []).map(function (s) {
                var al = s.album || s.al || {};
                var ar = s.artists || s.ar || [];
                return {
                  id: String(s.id), name: s.name || '',
                  artist: ar.map(function (a) { return a.name; }).join(' / '),
                  album: al.name || '', picId: toHttps(al.picUrl) || '',
                  cover: toHttps(al.picUrl) || '', lyricId: String(s.id),
                  duration: Math.round((s.duration || s.dt || 0) / 1000),
                  platform: 'netease', _personal: true
                };
              });
              if (!songs || songs.length === 0) {
                return { success: false, message: '未找到歌曲：' + songName };
              }
              return playBest(pickBest(songs));
            }).catch(function (e) {
              return { success: false, message: e.message || '网易云搜索失败' };
            });
          }
          // 模式 B：第三方音乐源（GD，netease → joox 降级重试）
          // 带重试的搜索（快速重试 4 次，全部失败后降级 joox）
          function searchWithRetry(src, kw, lim, retries, delay) {
            retries = retries || 0;
            delay = delay || 300;
            return searchMusic(kw, src, lim).then(function (results) {
              if ((!results || results.length === 0) && retries < 4) {
                return new Promise(function (resolve) { setTimeout(resolve, delay); })
                  .then(function () { return searchWithRetry(src, kw, lim, retries + 1, delay + 200); });
              }
              return results || [];
            });
          }
          // netease 重试全部失败后降级到 joox
          function searchWithFallback(src, kw, lim) {
            return searchWithRetry(src, kw, lim).then(function (results) {
              if ((!results || results.length === 0) && src === 'netease') {
                return searchWithRetry('joox', kw, lim);
              }
              return results || [];
            });
          }
          return searchWithFallback('netease', keyword, limit).then(function (results) {
            if (!results || results.length === 0) {
              return { success: false, message: '未找到歌曲：' + songName };
            }
            return playBest(pickBest(results));
          }).catch(function (e) {
            return { success: false, message: e.message };
          });
        }
      }]
    },

    onLoad: function (roche) {
      STATE.roche = roche;
      // 兼容：如果 Roche 调用 onLoad，提前初始化（mount 时会跳过）
      if (!STATE.initialized) {
        initAudio();
        createIsland();
        loadSettings(roche).then(function () {
          updatePlayModeUI();
          syncSettingsToUI();
          STATE.initialized = true;
        }).catch(function () {
          STATE.initialized = true;
        });
      }
    },

    onUnload: function () {
      // 注意：不在这里销毁灵动岛/音频
      // 参考 xhs-reader：插件被禁用后，灵动岛继续运行
      // 用户想真正停止时，通过灵动岛的关闭按钮
    }
  });
})();
