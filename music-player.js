(function () {
  'use strict';

  // ==================== 全局状态 ====================
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
    backend: 'https://456.chajianreader.cc.cd', // 后端地址
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
    currentTab: 'search',     // 当前标签页
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
    // 免责声明同意状态
    hasAgreedDisclaimer: false,
    // 灵动岛最小化（本地状态，不持久化）
    islandMinimized: false,
    // 扩展音源开关（默认关闭，仅网易云可用）
    useExtendedSources: false,
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
    // 网易云请求带上 cookie（通过请求头传递，不放在 URL 里，避免日志泄露）
    var headers = { 'Accept': 'application/json' };
    if (STATE.cookie && (params.source === 'netease' || action.indexOf('netease') === 0)) {
      headers['X-Netease-Cookie'] = STATE.cookie;
    }
    return fetch(url, { headers: headers }).then(function (res) { return res.json(); });
  }

  // 搜索音乐
  function searchMusic(keywords, source, limit) {
    limit = limit || 20;
    function normalizeSong(s) {
      // 兼容旧版Worker（id="netease:5257138"）和新版Worker（id="5257138"）
      // GD API 需要纯数字 track_id，不能带 source: 前缀
      var rawId = String(s.id || s.mediaId || '');
      // 去掉 "source:" 前缀（旧版Worker格式）
      var cleanId = rawId.indexOf(':') >= 0 ? rawId.split(':').pop() : rawId;
      return Object.assign({}, s, {
        id: cleanId,
        // picId 优先用 pic_id/picId，兜底用 cleanId（GD 文档说 lyric_id 一般与 id 相同）
        picId: s.picId || s.pic_id || s.picId || cleanId,
        lyricId: s.lyricId || s.lyric_id || s.lyricId || cleanId,
        platform: s.platform || s.source || source
      });
    }
    // 扩展音源（joox/bilibili）走 GD API 直连
    if (STATE.useExtendedSources && (source === 'joox' || source === 'bilibili')) {
      return gdApi('search', { source: source, name: keywords, count: limit }).then(function (data) {
        // GD API 返回格式可能是数组或 {value: [...], Count: N}
        var songs = Array.isArray(data) ? data : (data.value || []);
        return songs.map(normalizeSong);
      });
    }
    if (source === 'all') {
      return api('search_all', { keywords: keywords, limit: limit }).then(function (data) {
        // 后端返回 { all: { netease, joox, bilibili }, merged: [...] }
        if (data.merged && data.merged.length) return data.merged.map(normalizeSong);
        var results = [];
        var all = data.all || data;
        if (all.netease) all.netease.forEach(function (s) { results.push(normalizeSong(s)); });
        if (all.joox) all.joox.forEach(function (s) { results.push(normalizeSong(s)); });
        if (all.bilibili) all.bilibili.forEach(function (s) { results.push(normalizeSong(s)); });
        return results;
      });
    } else {
      return api('search', { keywords: keywords, source: source, limit: limit }).then(function (data) {
        // 后端返回 { songs: [...] }
        var songs = data.songs || data.results || [];
        return songs.map(normalizeSong);
      });
    }
  }

  // 获取播放 URL（br 由后端映射 standard/high/lossless -> 320/740/999）
  // id 必须是纯 track_id（不带 source: 前缀）
  function getSongUrl(id, source) {
    // 防御性：去掉可能的 source: 前缀
    var cleanId = String(id).indexOf(':') >= 0 ? String(id).split(':').pop() : String(id);
    // 扩展音源走 GD API 直连
    if (STATE.useExtendedSources && (source === 'joox' || source === 'bilibili')) {
      return gdApi('url', { source: source, id: cleanId, br: STATE.quality === 'standard' ? '320' : (STATE.quality === 'high' ? '740' : '999') }).then(function (data) {
        return data.url || '';
      });
    }
    return api('song_url', { id: cleanId, source: source, br: STATE.quality }).then(function (data) {
      return data.url || '';
    });
  }

  // 获取专辑图 URL（通过 pic_id 调用 GD 音乐台 pic 接口）
  function getPicUrl(picId, source) {
    if (!picId) return Promise.resolve('');
    // 去掉可能的 source: 前缀
    var cleanId = String(picId).indexOf(':') >= 0 ? String(picId).split(':').pop() : String(picId);
    return api('pic', { id: cleanId, source: source }).then(function (data) {
      return data.url || '';
    }).catch(function () { return ''; });
  }

  // 获取歌词（使用 lyricId，一般与 track_id 相同）
  function getLyric(lyricId, source) {
    if (!lyricId) return Promise.resolve({ lyric: '', tlyric: '' });
    // 去掉可能的 source: 前缀
    var cleanId = String(lyricId).indexOf(':') >= 0 ? String(lyricId).split(':').pop() : String(lyricId);
    return api('lyric', { id: cleanId, source: source }).then(function (data) {
      return { lyric: data.lyric || data.lrc || '', tlyric: data.tlyric || '' };
    });
  }

  // 直接调用 GD 音乐台 API（用于扩展音源 joox/bilibili）
  function gdApi(type, params) {
    params = params || {};
    var url = 'https://music-api.gdstudio.xyz/api.php?types=' + encodeURIComponent(type);
    Object.keys(params).forEach(function (key) {
      url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (res) { return res.json(); });
  }

  // 获取网易云扫码登录二维码
  function getQrLogin() {
    return api('netease_qr_login', {});
  }

  // 检查扫码状态
  function checkQrLogin(key) {
    return api('netease_qr_check', { key: key });
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
      updateProgressUI();
    }
    // 错误事件
    function onError() {
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

  // 播放指定歌曲
  function playSong(song, index) {
    if (!song) return;
    // 免责声明拦截：未同意则不允许播放
    if (!STATE.hasAgreedDisclaimer) {
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请先在设置中同意免责声明');
      return;
    }
    // iOS 未解锁时提示用户先点击解锁
    if (!STATE.audioUnlocked) {
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请先点击播放器任意位置解锁音频');
    }
    STATE.currentSong = song;
    if (typeof index === 'number') {
      STATE.currentIndex = index;
    }
    STATE.lyrics = [];
    STATE.tlyrics = [];
    STATE.currentLyricIndex = -1;

    // 获取播放 URL
    getSongUrl(song.id, song.platform || STATE.defaultSource).then(function (url) {
      // 竞态条件修复：如果在异步等待期间用户切换了歌曲，则放弃本次播放
      if (STATE.currentSong !== song) return;
      if (!url) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('无法获取播放链接，可能是版权限制');
        return;
      }
      STATE.audio.src = url;
      STATE.audio.play().catch(function (e) {
        // 未解锁时已在前面提示过，不再重复显示错误
        if (!STATE.audioUnlocked) return;
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('播放失败: ' + (e.message || '未知错误'));
      });
      // 加载歌词（使用 lyricId）
      loadLyrics(song);
      // 异步获取专辑封面（通过 pic_id 调用 GD 音乐台 pic 接口）
      if (!song.cover && song.picId) {
        getPicUrl(song.picId, song.platform || STATE.defaultSource).then(function (picUrl) {
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
    }).catch(function (e) {
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('获取播放链接失败');
    });
  }

  // 加载歌词（使用 lyricId，一般与 track_id 相同）
  function loadLyrics(song) {
    var lyricId = song.lyricId || song.id;
    getLyric(lyricId, song.platform || STATE.defaultSource).then(function (data) {
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
  function seek(time) {
    if (STATE.audio && STATE.audio.duration) {
      STATE.audio.currentTime = Math.max(0, Math.min(time, STATE.audio.duration));
    }
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
      if ('setPositionState' in navigator.mediaSession && STATE.audio && STATE.audio.duration) {
        navigator.mediaSession.setPositionState({
          duration: STATE.audio.duration,
          position: STATE.audio.currentTime,
          playbackRate: STATE.audio.playbackRate
        });
      }
    } catch (e) {}
  }

  // ==================== 灵动岛 ====================

  // 灵动岛样式
  function getIslandStyles() {
    return '\
#rmp-island {\
  position: fixed;\
  top: calc(var(--rmp-island-top, 8px) + env(safe-area-inset-top));\
  left: 50%;\
  transform: translateX(-50%);\
  z-index: 99999;\
  background: rgba(0, 0, 0, 0.78);\
  -webkit-backdrop-filter: blur(20px);\
  backdrop-filter: blur(20px);\
  border-radius: 28px;\
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45), 0 0 0 0.5px rgba(255,255,255,0.1);\
  color: #fff;\
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\
  cursor: pointer;\
  user-select: none;\
  -webkit-user-select: none;\
  touch-action: pan-y;\
  overflow: hidden;\
  max-height: 52px;\
  /* 关键：限制宽度，避免遮挡过多按钮。未点开状态更窄 */\
  width: auto;\
  min-width: 140px;\
  max-width: 200px;\
  transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1),\
              width 0.4s cubic-bezier(0.4, 0, 0.2, 1),\
              max-width 0.4s cubic-bezier(0.4, 0, 0.2, 1),\
              opacity 0.3s ease,\
              transform 0.3s ease;\
  opacity: 1;\
}\
#rmp-island.rmp-island-hidden {\
  opacity: 0;\
  transform: translateX(-50%) translateY(-100%);\
  pointer-events: none;\
}\
#rmp-island.rmp-island-expanded {\
  max-height: 220px;\
  width: 300px;\
  max-width: 300px;\
}\
/* 最小化：缩成顶部一条细线 */\
#rmp-island.rmp-island-minimized {\
  max-height: 4px;\
  min-height: 4px;\
  width: 80px;\
  min-width: 80px;\
  max-width: 80px;\
  border-radius: 2px;\
  opacity: 0.45;\
  cursor: pointer;\
  overflow: hidden;\
  transition: max-height 0.3s ease, width 0.3s ease, max-width 0.3s ease, min-width 0.3s ease, border-radius 0.3s ease;\
}\
#rmp-island.rmp-island-minimized .rmp-island-pill,\
#rmp-island.rmp-island-minimized .rmp-island-expanded-content {\
  display: none;\
}\
@media (max-width: 600px) {\
  #rmp-island {\
    max-width: 170px;\
    min-width: 120px;\
  }\
  #rmp-island.rmp-island-expanded {\
    width: 88vw;\
    max-width: 88vw;\
  }\
}\
.rmp-island-pill {\
  display: flex;\
  align-items: center;\
  gap: 8px;\
  padding: 8px 10px;\
  height: 52px;\
  box-sizing: border-box;\
}\
.rmp-island-cover {\
  width: 34px;\
  height: 34px;\
  border-radius: 8px;\
  object-fit: cover;\
  flex-shrink: 0;\
  background: rgba(255,255,255,0.1);\
}\
.rmp-island-cover.rmp-spinning {\
  animation: rmp-island-spin 8s linear infinite;\
}\
@keyframes rmp-island-spin {\
  from { transform: rotate(0deg); }\
  to { transform: rotate(360deg); }\
}\
.rmp-island-info {\
  flex: 1;\
  overflow: hidden;\
  min-width: 0;\
  /* 滚动展示容器 */\
  position: relative;\
}\
/* 未点开状态：歌名/歌词滚动展示区 */\
.rmp-island-scroll-text {\
  font-size: 12px;\
  font-weight: 600;\
  white-space: nowrap;\
  overflow: hidden;\
  line-height: 34px;\
  position: relative;\
}\
.rmp-island-scroll-inner {\
  display: inline-block;\
  padding-right: 40px;\
  animation: rmp-scroll-left 12s linear infinite;\
}\
@keyframes rmp-scroll-left {\
  0% { transform: translateX(0); }\
  100% { transform: translateX(-100%); }\
}\
.rmp-island-artist {\
  font-size: 11px;\
  opacity: 0.6;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  line-height: 1.2;\
}\
/* 关闭按钮（胶囊状悬浮球上的 X）——加大触摸区域，始终可见 */\
.rmp-island-close {\
  width: 28px;\
  height: 28px;\
  flex-shrink: 0;\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  border-radius: 50%;\
  background: rgba(255,255,255,0.22);\
  cursor: pointer;\
  opacity: 0.85;\
  transition: opacity 0.2s ease, background 0.2s ease, transform 0.15s ease;\
}\
.rmp-island-close:hover {\
  opacity: 1;\
  background: rgba(255,107,107,0.5);\
}\
.rmp-island-close:active {\
  transform: scale(0.85);\
}\
.rmp-island-close svg {\
  width: 14px;\
  height: 14px;\
  fill: #fff;\
}\
.rmp-island-play-icon {\
  width: 26px;\
  height: 26px;\
  display: flex;\
  align-items: center;\
  justify-content: center;\
  flex-shrink: 0;\
  opacity: 0.7;\
}\
.rmp-island-play-icon svg {\
  width: 15px;\
  height: 15px;\
  fill: #fff;\
}\
.rmp-island-expanded-content {\
  padding: 0 14px 10px;\
  opacity: 0;\
  transition: opacity 0.3s ease 0.15s;\
}\
#rmp-island.rmp-island-expanded .rmp-island-expanded-content {\
  opacity: 1;\
}\
.rmp-island-lyrics {\
  text-align: center;\
  padding: 4px 0 6px;\
}\
.rmp-lyric-prev, .rmp-lyric-next {\
  font-size: 11px;\
  opacity: 0.35;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 2px 0;\
  line-height: 1.4;\
}\
.rmp-lyric-current {\
  font-size: 13px;\
  font-weight: 600;\
  color: #C20C0C;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 4px 0;\
  line-height: 1.4;\
}\
.rmp-lyric-current-translation {\
  font-size: 11px;\
  opacity: 0.6;\
  white-space: nowrap;\
  overflow: hidden;\
  text-overflow: ellipsis;\
  padding: 1px 0;\
}\
.rmp-island-progress {\
  height: 3px;\
  background: rgba(255, 255, 255, 0.15);\
  border-radius: 2px;\
  margin-top: 4px;\
  cursor: pointer;\
  position: relative;\
}\
.rmp-island-progress-fill {\
  height: 100%;\
  background: #C20C0C;\
  border-radius: 2px;\
  width: 0%;\
  transition: width 0.2s linear;\
}\
.rmp-island-time {\
  display: flex;\
  justify-content: space-between;\
  font-size: 10px;\
  opacity: 0.5;\
  margin-top: 4px;\
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
        <div class="rmp-island-close" title="关闭">\
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

    // 点击展开/收起（排除关闭、播放按钮和进度条）
    function onIslandClick(e) {
      // 点击关闭按钮：最小化为顶部细线
      if (e.target.closest('.rmp-island-close')) {
        e.stopPropagation();
        minimizeIsland();
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

    // 进度条拖拽跳转（支持鼠标和触摸）
    var isDraggingProgress = false;
    function progressSeekFromEvent(e) {
      if (!STATE.audio || !STATE.audio.duration) return;
      var rect = STATE.islandRefs.progress.getBoundingClientRect();
      var clientX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      var x = clientX - rect.left;
      var percent = Math.max(0, Math.min(1, x / rect.width));
      seek(percent * STATE.audio.duration);
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

    // 移动端滑动切换歌曲 / 上下滑最小化 / 长按切歌
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
      // 长按检测：600ms 后切换歌曲
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        var halfW = island.getBoundingClientRect().width / 2;
        if (touchStartX < halfW) {
          playPrev();
        } else {
          playNext();
        }
      }, 600);
    }
    function onTouchEnd(e) {
      clearTimeout(longPressTimer);
      if (longPressFired) return; // 长按已触发，不处理滑动
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
      // 水平滑动距离大于垂直，且超过 50px
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) {
          playPrev();
        } else {
          playNext();
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
        var halfW = island.getBoundingClientRect().width / 2;
        if (e.clientX < halfW) {
          playPrev();
        } else {
          playNext();
        }
      }, 600);
    }
    function onMouseUp() {
      clearTimeout(longPressTimer);
      if (longPressFired) {
        // 阻止后续 click 事件展开/收起
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
    } else {
      STATE.islandEl.classList.remove('rmp-island-expanded');
    }
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

  // 显示灵动岛
  function showIsland() {
    if (STATE.islandEl) {
      // 如果设置中关闭了灵动岛显示，则不显示
      if (!STATE.islandVisible) return;
      STATE.islandEl.classList.remove('rmp-island-hidden');
      // 播放歌曲时自动从最小化恢复
      unminimizeIsland();
    }
  }

  // 隐藏灵动岛
  function hideIsland() {
    if (STATE.islandEl) {
      STATE.islandEl.classList.add('rmp-island-hidden');
      STATE.islandEl.classList.remove('rmp-island-expanded');
      STATE.islandExpanded = false;
    }
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
    var percent = 0;
    if (STATE.audio.duration) {
      percent = (STATE.audio.currentTime / STATE.audio.duration) * 100;
    }
    STATE.islandRefs.progressFill.style.width = percent + '%';
    if (STATE.islandRefs.currentTime) {
      STATE.islandRefs.currentTime.textContent = formatTime(STATE.audio.currentTime);
    }
    if (STATE.islandRefs.duration && STATE.audio.duration) {
      STATE.islandRefs.duration.textContent = formatTime(STATE.audio.duration);
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
  background: linear-gradient(160deg, #1a1a1a 0%, #0d0d0d 50%, #141414 100%);\
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
  padding: 10px 14px;\
  background: rgba(255, 255, 255, 0.06);\
  border: 1px solid rgba(255, 255, 255, 0.1);\
  border-radius: 12px;\
  color: #fff;\
  font-size: 14px;\
  outline: none;\
  transition: border-color 0.2s;\
}\
.rmp-search-input:focus {\
  border-color: #C20C0C;\
}\
.rmp-search-input::placeholder { color: rgba(255,255,255,0.3); }\
.rmp-select {\
  padding: 10px 14px;\
  background: rgba(255, 255, 255, 0.06);\
  border: 1px solid rgba(255, 255, 255, 0.1);\
  border-radius: 12px;\
  color: #fff;\
  font-size: 13px;\
  outline: none;\
  cursor: pointer;\
}\
.rmp-select option { background: #1a1a2e; color: #fff; }\
.rmp-btn {\
  padding: 10px 18px;\
  background: #C20C0C;\
  color: #1a1a2e;\
  border: none;\
  border-radius: 12px;\
  font-size: 14px;\
  font-weight: 600;\
  cursor: pointer;\
  transition: all 0.2s ease;\
  min-height: 44px;\
  display: inline-flex;\
  align-items: center;\
  justify-content: center;\
  gap: 6px;\
}\
.rmp-btn:hover { background: #f5d982; transform: translateY(-1px); }\
.rmp-btn:active { transform: translateY(0); }\
.rmp-btn-secondary {\
  background: rgba(255, 255, 255, 0.08);\
  color: #e0e0e0;\
}\
.rmp-btn-secondary:hover { background: rgba(255, 255, 255, 0.12); }\
.rmp-btn-icon {\
  padding: 10px;\
  min-width: 44px;\
  min-height: 44px;\
  background: rgba(255, 255, 255, 0.06);\
  color: #e0e0e0;\
  border: none;\
  border-radius: 12px;\
  cursor: pointer;\
  display: inline-flex;\
  align-items: center;\
  justify-content: center;\
  transition: all 0.2s ease;\
}\
.rmp-btn-icon:hover { background: rgba(255, 255, 255, 0.12); color: #C20C0C; }\
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
  background: #C20C0C;\
  border-radius: 0 2px 2px 0;\
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
  color: #C20C0C;\
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
  padding: 2px 6px;\
  border-radius: 4px;\
  background: rgba(180, 140, 255, 0.15);\
  color: #b48cff;\
  flex-shrink: 0;\
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
.rmp-topbar {\
  display: flex;\
  align-items: center;\
  gap: 4px;\
  /* 关键：顶部留出灵动岛空间。灵动岛高度52px + top偏移(默认8px) + safe-area + 缓冲16px */\
  padding: calc(env(safe-area-inset-top) + var(--rmp-island-top, 8px) + 52px + 16px) 8px 8px;\
  flex-shrink: 0;\
}\
.rmp-topbar .rmp-tabs {\
  flex: 1;\
  padding: 0;\
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
  background: #C20C0C;\
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
  background: rgba(194,12,12,0.12);\
  color: #E60026;\
}\
/* GD音乐台出处注明 + 免责声明 */\
.rmp-disclaimer {\
  margin-top: 14px;\
  padding: 12px;\
  border: 1px solid rgba(230,0,38,0.25);\
  border-radius: 10px;\
  background: rgba(230,0,38,0.04);\
}\
.rmp-disclaimer-title {\
  font-size: 12px;\
  font-weight: 600;\
  color: #E60026;\
  margin-bottom: 6px;\
}\
.rmp-disclaimer-body {\
  font-size: 11px;\
  color: rgba(255,255,255,0.5);\
  line-height: 1.6;\
}\
.rmp-disclaimer-body a {\
  color: rgba(230,0,38,0.7);\
  text-decoration: none;\
}\
.rmp-disclaimer-body a:hover {\
  color: #E60026;\
  text-decoration: underline;\
}\
.rmp-disclaimer-check-row {\
  margin-top: 10px;\
  padding-top: 8px;\
  border-top: 1px dashed rgba(255,255,255,0.08);\
}\
.rmp-disclaimer-check {\
  display: flex;\
  align-items: center;\
  gap: 6px;\
  font-size: 12px;\
  color: rgba(255,255,255,0.7);\
  cursor: pointer;\
  user-select: none;\
}\
.rmp-disclaimer-check input {\
  width: 16px;\
  height: 16px;\
  accent-color: #C20C0C;\
  cursor: pointer;\
}\
.rmp-disclaimer-locked {\
  margin-top: 14px;\
  padding: 12px;\
  border: 1px solid rgba(230,0,38,0.3);\
  border-radius: 10px;\
  background: rgba(230,0,38,0.06);\
  font-size: 12px;\
  color: #E60026;\
  text-align: center;\
  line-height: 1.6;\
}\
.rmp-disclaimer-locked a {\
  color: #E60026;\
  text-decoration: underline;\
}\
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
    <div class="rmp-tabs">\
      <button class="rmp-tab active" data-tab="search">搜索</button>\
      <button class="rmp-tab" data-tab="playing">正在播放</button>\
      <button class="rmp-tab" data-tab="playlist">播放列表</button>\
      <button class="rmp-tab" data-tab="login">登录</button>\
      <button class="rmp-tab" data-tab="settings">设置</button>\
    </div>\
    <button class="rmp-close-btn" title="关闭">关闭</button>\
  </div>\
  <div class="rmp-panels">\
    <!-- 搜索面板 -->\
    <div class="rmp-panel active" data-panel="search">\
      <div class="rmp-search-bar">\
        <input type="text" class="rmp-search-input" placeholder="输入歌曲名或歌手名..." />\
        <select class="rmp-select rmp-search-source">\
          <option value="netease">网易云</option>\
          <option value="joox">JOOX</option>\
          <option value="bilibili">B站</option>\
          <option value="all">全平台</option>\
        </select>\
        <button class="rmp-btn rmp-search-btn">搜索</button>\
      </div>\
      <div class="rmp-search-results"></div>\
    </div>\
    <!-- 正在播放面板 -->\
    <div class="rmp-panel" data-panel="playing">\
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
    <!-- 播放列表面板 -->\
    <div class="rmp-panel" data-panel="playlist">\
      <div class="rmp-playlist-header">\
        <span class="rmp-playlist-count">0 首</span>\
        <button class="rmp-clear-btn rmp-clear-playlist-btn">清空列表</button>\
      </div>\
      <div class="rmp-playlist-items"></div>\
    </div>\
    <!-- 登录面板 -->\
    <div class="rmp-panel" data-panel="login">\
      <div class="rmp-login-area">\
        <div class="rmp-login-info">使用网易云音乐 APP 扫描下方二维码登录，登录后可获取更高音质及个人歌单</div>\
        <div class="rmp-qr-container">\
          <img class="rmp-qr-img" alt="二维码" style="display:none;" />\
          <div class="rmp-qr-placeholder" style="color:#999;font-size:13px;">点击下方按钮获取二维码</div>\
        </div>\
        <div class="rmp-login-status"></div>\
        <button class="rmp-btn rmp-qr-refresh-btn">获取二维码</button>\
      </div>\
    </div>\
    <!-- 设置面板 -->\
    <div class="rmp-panel" data-panel="settings">\
      <div class="rmp-card">\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">后端地址</label>\
          <input type="text" class="rmp-settings-input rmp-backend-input" placeholder="https://..." />\
        </div>\
        <div class="rmp-settings-group">\
          <label class="rmp-settings-label">默认音源</label>\
          <select class="rmp-select rmp-default-source-select" style="width:100%;">\
            <option value="netease">网易云</option>\
            <option value="joox">JOOX</option>\
            <option value="bilibili">B站</option>\
            <option value="all">全平台</option>\
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
            <span class="rmp-toggle-label">扩展音源（需自备代理，默认关闭）</span>\
            <div class="rmp-toggle rmp-extended-sources-toggle" role="switch"></div>\
          </div>\
          <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:4px;line-height:1.5;">关闭时仅使用网易云；开启后可使用 JOOX、B站 等扩展音源（需自备访问外网的代理）</div>\
        </div>\
        <button class="rmp-btn rmp-save-settings-btn" style="margin-top:8px;">保存设置</button>\
        <button class="rmp-btn rmp-btn-secondary rmp-reset-island-btn" style="margin-top:6px;">重置灵动岛显示</button>\
        <div class="rmp-disclaimer">\
          <div class="rmp-disclaimer-title">免责声明</div>\
          <div class="rmp-disclaimer-body">\
            1. 本插件为个人学习用途免费开源分享，不收取任何费用，也未与任何商业软件进行捆绑或合作。<br/>\
            2. 音乐数据来自网络（<a href="https://music.gdstudio.xyz" target="_blank" rel="noopener">GD音乐台 music.gdstudio.xyz</a>），仅供个人学习参考，不得用于商业用途，如侵权请联系数据源方删除。<br/>\
            3. 本插件可在任何支持 Roche 插件规范的环境运行，与 Roche 本体无关联、不依附其收费。使用者应确保自身使用行为符合所在地区的法律法规及所使用软件的用户协议。<br/>\
            4. 继续使用将视为同意以上声明。\
          </div>\
          <div class="rmp-disclaimer-check-row">\
            <label class="rmp-disclaimer-check">\
              <input type="checkbox" class="rmp-agree-checkbox" />\
              <span>我已阅读并同意以上声明</span>\
            </label>\
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
      // 搜索
      searchInput: root.querySelector('.rmp-search-input'),
      searchSource: root.querySelector('.rmp-search-source'),
      searchBtn: root.querySelector('.rmp-search-btn'),
      searchResults: root.querySelector('.rmp-search-results'),
      // 正在播放
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
      // 播放列表
      playlistCount: root.querySelector('.rmp-playlist-count'),
      playlistItems: root.querySelector('.rmp-playlist-items'),
      clearPlaylistBtn: root.querySelector('.rmp-clear-playlist-btn'),
      // 登录
      qrImg: root.querySelector('.rmp-qr-img'),
      qrPlaceholder: root.querySelector('.rmp-qr-placeholder'),
      loginStatus: root.querySelector('.rmp-login-status'),
      qrRefreshBtn: root.querySelector('.rmp-qr-refresh-btn'),
      // 设置
      backendInput: root.querySelector('.rmp-backend-input'),
      defaultSourceSelect: root.querySelector('.rmp-default-source-select'),
      qualitySelect: root.querySelector('.rmp-quality-select'),
      islandTopInput: root.querySelector('.rmp-island-top-input'),
      islandVisibleToggle: root.querySelector('.rmp-island-visible-toggle'),
      islandScrollModeSelect: root.querySelector('.rmp-island-scroll-mode-select'),
      saveSettingsBtn: root.querySelector('.rmp-save-settings-btn'),
      resetIslandBtn: root.querySelector('.rmp-reset-island-btn'),
      agreeCheckbox: root.querySelector('.rmp-agree-checkbox'),
      extendedSourcesToggle: root.querySelector('.rmp-extended-sources-toggle'),
      // 顶部栏
      closeBtn: root.querySelector('.rmp-close-btn')
    };

    // 初始化免责声明同意状态
    if (STATE.appRefs.agreeCheckbox) {
      STATE.appRefs.agreeCheckbox.checked = STATE.hasAgreedDisclaimer;
    }
    updateDisclaimerLockUI();

    // 初始化设置值
    STATE.appRefs.searchSource.value = STATE.defaultSource;
    STATE.appRefs.backendInput.value = STATE.backend;
    STATE.appRefs.defaultSourceSelect.value = STATE.defaultSource;
    STATE.appRefs.qualitySelect.value = STATE.quality;
    STATE.appRefs.volumeSlider.value = STATE.volume;
    STATE.appRefs.islandTopInput.value = STATE.islandTop;
    STATE.appRefs.islandScrollModeSelect.value = STATE.islandScrollMode;
    // 初始化开关状态
    if (STATE.islandVisible) STATE.appRefs.islandVisibleToggle.classList.add('on');
    if (STATE.useExtendedSources) STATE.appRefs.extendedSourcesToggle.classList.add('on');

    // 根据扩展音源开关状态初始化搜索来源下拉框
    updateSearchSourceOptions();

    bindAppEvents();
    updateAppSongInfo();
    updateAppPlayState();
    updateAppPlayMode();
    renderAppLyrics();
    renderPlaylistUI();
  }

  // 绑定 App 事件
  function bindAppEvents() {
    var refs = STATE.appRefs;

    // 标签页切换
    function onTabClick(e) {
      var tab = e.target.closest('.rmp-tab');
      if (!tab) return;
      switchTab(tab.getAttribute('data-tab'));
    }
    refs.root.querySelector('.rmp-tabs').addEventListener('click', onTabClick);
    STATE.appCleanups.push(function () {
      refs.root.querySelector('.rmp-tabs').removeEventListener('click', onTabClick);
    });

    // 搜索
    function doSearch() {
      if (!STATE.hasAgreedDisclaimer) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请先在设置中同意免责声明');
        switchToSettingsTab();
        return;
      }
      var keywords = refs.searchInput.value.trim();
      if (!keywords) {
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('请输入搜索关键词');
        return;
      }
      var source = refs.searchSource.value;
      STATE.isSearching = true;
      refs.searchResults.innerHTML = '<div class="rmp-loading"><div class="rmp-spinner"></div></div>';
      searchMusic(keywords, source, 20).then(function (results) {
        STATE.isSearching = false;
        STATE.searchResults = results;
        renderSearchResults();
      }).catch(function (e) {
        STATE.isSearching = false;
        refs.searchResults.innerHTML = '<div class="rmp-empty-state">搜索失败，请检查后端地址或网络</div>';
      });
    }
    refs.searchBtn.addEventListener('click', doSearch);
    STATE.appCleanups.push(function () { refs.searchBtn.removeEventListener('click', doSearch); });

    function onSearchKeydown(e) {
      if (e.key === 'Enter') doSearch();
    }
    refs.searchInput.addEventListener('keydown', onSearchKeydown);
    STATE.appCleanups.push(function () { refs.searchInput.removeEventListener('keydown', onSearchKeydown); });

    // 搜索结果点击委托
    function onSearchResultsClick(e) {
      var item = e.target.closest('.rmp-song-item');
      if (!item) return;
      var index = parseInt(item.getAttribute('data-index'), 10);
      if (isNaN(index) || !STATE.searchResults[index]) return;
      var song = STATE.searchResults[index];

      // 判断点击的是播放还是添加按钮
      if (e.target.closest('.rmp-add-btn')) {
        addToPlaylist(song);
        if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('已添加到播放列表');
        return;
      }

      // 播放
      var idx = addToPlaylist(song);
      playSong(song, idx);
    }
    refs.searchResults.addEventListener('click', onSearchResultsClick);
    STATE.appCleanups.push(function () { refs.searchResults.removeEventListener('click', onSearchResultsClick); });

    // 播放控制
    refs.playBtn.addEventListener('click', togglePlay);
    STATE.appCleanups.push(function () { refs.playBtn.removeEventListener('click', togglePlay); });

    refs.prevBtn.addEventListener('click', playPrev);
    STATE.appCleanups.push(function () { refs.prevBtn.removeEventListener('click', playPrev); });

    refs.nextBtn.addEventListener('click', playNext);
    STATE.appCleanups.push(function () { refs.nextBtn.removeEventListener('click', playNext); });

    function onModeClick() {
      var modes = ['list', 'one', 'random'];
      var idx = modes.indexOf(STATE.playMode);
      var nextMode = modes[(idx + 1) % modes.length];
      setPlayMode(nextMode);
    }
    refs.modeBtn.addEventListener('click', onModeClick);
    STATE.appCleanups.push(function () { refs.modeBtn.removeEventListener('click', onModeClick); });

    // 进度条拖拽跳转
    var isAppDraggingProgress = false;
    function appProgressSeek(e) {
      if (!STATE.audio || !STATE.audio.duration) return;
      var rect = refs.progressBar.getBoundingClientRect();
      var clientX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      var x = clientX - rect.left;
      var percent = Math.max(0, Math.min(1, x / rect.width));
      seek(percent * STATE.audio.duration);
    }
    function onAppProgressStart(e) {
      e.stopPropagation();
      e.preventDefault();
      isAppDraggingProgress = true;
      appProgressSeek(e);
      document.addEventListener('mousemove', onAppProgressMove);
      document.addEventListener('mouseup', onAppProgressEnd);
      document.addEventListener('touchmove', onAppProgressMove, { passive: false });
      document.addEventListener('touchend', onAppProgressEnd);
    }
    function onAppProgressMove(e) {
      if (!isAppDraggingProgress) return;
      e.preventDefault();
      appProgressSeek(e);
    }
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

    // 音量控制
    function onVolumeChange(e) {
      setVolume(parseFloat(e.target.value));
    }
    refs.volumeSlider.addEventListener('input', onVolumeChange);
    STATE.appCleanups.push(function () { refs.volumeSlider.removeEventListener('input', onVolumeChange); });

    // 播放列表操作
    function onPlaylistClick(e) {
      var item = e.target.closest('.rmp-song-item');
      if (!item) return;
      var index = parseInt(item.getAttribute('data-index'), 10);
      if (isNaN(index)) return;

      if (e.target.closest('.rmp-remove-btn')) {
        removeFromPlaylist(index);
        return;
      }

      // 播放
      if (STATE.playlist[index]) {
        playSong(STATE.playlist[index], index);
      }
    }
    refs.playlistItems.addEventListener('click', onPlaylistClick);
    STATE.appCleanups.push(function () { refs.playlistItems.removeEventListener('click', onPlaylistClick); });

    refs.clearPlaylistBtn.addEventListener('click', clearPlaylist);
    STATE.appCleanups.push(function () { refs.clearPlaylistBtn.removeEventListener('click', clearPlaylist); });

    // 登录
    refs.qrRefreshBtn.addEventListener('click', startQrLogin);
    STATE.appCleanups.push(function () { refs.qrRefreshBtn.removeEventListener('click', startQrLogin); });

    // 关闭按钮
    function onCloseClick() {
      if (STATE.roche && STATE.roche.ui && typeof STATE.roche.ui.closeApp === 'function') {
        STATE.roche.ui.closeApp();
      }
    }
    refs.closeBtn.addEventListener('click', onCloseClick);
    STATE.appCleanups.push(function () { refs.closeBtn.removeEventListener('click', onCloseClick); });

    // 灵动岛距顶部偏移：实时预览
    function onIslandTopInput() {
      var v = parseInt(refs.islandTopInput.value, 10);
      if (isNaN(v)) v = 8;
      v = Math.max(0, Math.min(100, v));
      STATE.islandTop = v;
      if (STATE.islandEl) {
        STATE.islandEl.style.setProperty('--rmp-island-top', v + 'px');
        document.documentElement.style.setProperty('--rmp-island-top', v + 'px');
      }
    }
    refs.islandTopInput.addEventListener('input', onIslandTopInput);
    STATE.appCleanups.push(function () { refs.islandTopInput.removeEventListener('input', onIslandTopInput); });

    // 灵动岛显示模式切换（歌名/歌词）
    function onIslandScrollModeChange() {
      STATE.islandScrollMode = refs.islandScrollModeSelect.value;
      updateIslandSongInfo(); // 立即更新滚动文本
      saveSettings();
    }
    refs.islandScrollModeSelect.addEventListener('change', onIslandScrollModeChange);
    STATE.appCleanups.push(function () { refs.islandScrollModeSelect.removeEventListener('change', onIslandScrollModeChange); });

    // 显示灵动岛开关
    function onIslandVisibleToggle() {
      STATE.islandVisible = !STATE.islandVisible;
      refs.islandVisibleToggle.classList.toggle('on', STATE.islandVisible);
      if (STATE.islandEl) {
        STATE.islandEl.style.display = STATE.islandVisible ? '' : 'none';
      }
      saveSettings();
    }
    refs.islandVisibleToggle.addEventListener('click', onIslandVisibleToggle);
    STATE.appCleanups.push(function () { refs.islandVisibleToggle.removeEventListener('click', onIslandVisibleToggle); });

    // 扩展音源开关
    function onExtendedSourcesToggle() {
      STATE.useExtendedSources = !STATE.useExtendedSources;
      refs.extendedSourcesToggle.classList.toggle('on', STATE.useExtendedSources);
      updateSearchSourceOptions();
      saveSettings();
      if (STATE.roche && STATE.roche.ui) {
        STATE.roche.ui.toast(STATE.useExtendedSources ? '已开启扩展音源（JOOX、B站等），需要代理' : '已关闭扩展音源，仅使用网易云');
      }
    }
    refs.extendedSourcesToggle.addEventListener('click', onExtendedSourcesToggle);
    STATE.appCleanups.push(function () { refs.extendedSourcesToggle.removeEventListener('click', onExtendedSourcesToggle); });

    // 保存设置
    function onSaveSettings() {
      var backend = refs.backendInput.value.trim();
      if (backend) {
        STATE.backend = backend.replace(/\/+$/, '');
      }
      STATE.defaultSource = refs.defaultSourceSelect.value;
      STATE.quality = refs.qualitySelect.value;
      var topVal = parseInt(refs.islandTopInput.value, 10);
      if (!isNaN(topVal)) {
        STATE.islandTop = Math.max(0, Math.min(100, topVal));
        if (STATE.islandEl) {
          STATE.islandEl.style.setProperty('--rmp-island-top', STATE.islandTop + 'px');
          document.documentElement.style.setProperty('--rmp-island-top', STATE.islandTop + 'px');
        }
      }
      saveSettings();
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('设置已保存');
    }
    refs.saveSettingsBtn.addEventListener('click', onSaveSettings);
    STATE.appCleanups.push(function () { refs.saveSettingsBtn.removeEventListener('click', onSaveSettings); });

    // 重置灵动岛显示：打开显示开关 + 从最小化恢复
    function onResetIsland() {
      STATE.islandVisible = true;
      STATE.islandMinimized = false;
      refs.islandVisibleToggle.classList.add('on');
      if (STATE.islandEl) {
        STATE.islandEl.style.display = '';
        STATE.islandEl.classList.remove('rmp-island-minimized', 'rmp-island-hidden');
      }
      saveSettings();
      if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('灵动岛已重置显示');
    }
    refs.resetIslandBtn.addEventListener('click', onResetIsland);
    STATE.appCleanups.push(function () { refs.resetIslandBtn.removeEventListener('click', onResetIsland); });

    // 免责声明同意框
    function onAgreeChange() {
      STATE.hasAgreedDisclaimer = !!refs.agreeCheckbox.checked;
      saveSettings();
      updateDisclaimerLockUI();
      if (STATE.hasAgreedDisclaimer && STATE.roche && STATE.roche.ui) {
        STATE.roche.ui.toast('已同意声明，可正常使用');
      }
    }
    refs.agreeCheckbox.addEventListener('change', onAgreeChange);
    STATE.appCleanups.push(function () { refs.agreeCheckbox.removeEventListener('change', onAgreeChange); });
  }

  // 跳转到设置页（未同意声明时引导）
  function switchToSettingsTab() {
    if (STATE.appRefs.root) {
      var tab = STATE.appRefs.root.querySelector('.rmp-tab[data-tab="settings"]');
      if (tab) tab.click();
    }
  }

  // 更新免责声明锁定 UI：未同意时在搜索/播放列表显示提示
  function updateDisclaimerLockUI() {
    if (!STATE.appRefs.root) return;
    var root = STATE.appRefs.root;
    if (STATE.hasAgreedDisclaimer) {
      // 已同意：移除锁定提示
      var locked = root.querySelectorAll('.rmp-disclaimer-locked');
      locked.forEach(function (el) { el.remove(); });
      // 恢复搜索栏/播放列表交互（如果有 disabled）
      var searchInput = root.querySelector('.rmp-search-input');
      var searchBtn = root.querySelector('.rmp-search-btn');
      if (searchInput) searchInput.disabled = false;
      if (searchBtn) searchBtn.disabled = false;
    } else {
      // 未同意：在搜索结果区显示锁定提示
      var searchResults = root.querySelector('.rmp-search-results');
      if (searchResults && !root.querySelector('.rmp-disclaimer-locked')) {
        searchResults.innerHTML = '<div class="rmp-disclaimer-locked">请先在「设置」中阅读并同意免责声明后，方可搜索和播放音乐<br/>（数据来源：<a href="https://music.gdstudio.xyz" target="_blank" rel="noopener">GD音乐台</a>，仅限个人学习使用）</div>';
      }
    }
  }

  // 根据扩展音源开关更新搜索来源下拉框
  function updateSearchSourceOptions() {
    var searchSourceEl = STATE.appRefs.searchSource;
    var defaultSourceEl = STATE.appRefs.defaultSourceSelect;
    if (!searchSourceEl) return;

    if (STATE.useExtendedSources) {
      // 开启扩展音源：显示全部选项
      var allOptions = [
        { value: 'netease', label: '网易云' },
        { value: 'joox', label: 'JOOX' },
        { value: 'bilibili', label: 'B站' },
        { value: 'all', label: '全平台' }
      ];
      setSelectOptions(searchSourceEl, allOptions);
      if (defaultSourceEl) setSelectOptions(defaultSourceEl, allOptions);
      // 恢复之前保存的默认音源
      if (defaultSourceEl) defaultSourceEl.value = STATE.defaultSource;
      searchSourceEl.value = STATE.defaultSource;
    } else {
      // 关闭扩展音源：仅显示网易云
      var neteaseOnly = [
        { value: 'netease', label: '网易云' }
      ];
      setSelectOptions(searchSourceEl, neteaseOnly);
      if (defaultSourceEl) setSelectOptions(defaultSourceEl, neteaseOnly);
      // 强制切换到网易云
      STATE.defaultSource = 'netease';
      searchSourceEl.value = 'netease';
      if (defaultSourceEl) defaultSourceEl.value = 'netease';
      saveSettings();
    }
  }

  // 设置 select 元素的选项
  function setSelectOptions(selectEl, options) {
    selectEl.innerHTML = '';
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    });
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

  function renderSearchResults() {
    var refs = STATE.appRefs;
    if (!STATE.searchResults || STATE.searchResults.length === 0) {
      refs.searchResults.innerHTML = '<div class="rmp-empty-state">暂无搜索结果</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < STATE.searchResults.length; i++) {
      var song = STATE.searchResults[i];
      var isPlaying = STATE.currentSong && STATE.currentSong.id === song.id && STATE.currentSong.platform === song.platform;
      var coverHtml;
      if (song.cover) {
        coverHtml = '<img class="rmp-song-cover" src="' + escapeHtml(song.cover) + '" alt="" onerror="this.style.opacity=0.3;" />';
      } else {
        var firstChar = (song.name || 'M').charAt(0).toUpperCase();
        coverHtml = '<div class="rmp-song-cover" style="background:' + gradientFromName(song.name) + '">' + escapeHtml(firstChar) + '</div>';
      }
      var indicatorHtml = isPlaying
        ? '<div class="rmp-equalizer' + (STATE.isPlaying ? '' : ' paused') + '"><span></span><span></span><span></span></div>'
        : '<span class="rmp-song-duration">' + formatTime(song.duration) + '</span>';
      html += '\
<div class="rmp-song-item' + (isPlaying ? ' playing' : '') + '" data-index="' + i + '">\
  ' + coverHtml + '\
  <div class="rmp-song-info">\
    <div class="rmp-song-name">' + escapeHtml(song.name || '未知歌曲') + '</div>\
    <div class="rmp-song-meta">' + escapeHtml(song.artist || '未知歌手') + (song.album ? ' - ' + escapeHtml(song.album) : '') + '</div>\
  </div>\
  <span class="rmp-song-platform">' + escapeHtml(song.platform || '') + '</span>\
  ' + indicatorHtml + '\
  <div class="rmp-song-actions">\
    <button class="rmp-btn-icon rmp-add-btn" title="添加到播放列表">' + ICONS.add + '</button>\
  </div>\
</div>';
    }
    refs.searchResults.innerHTML = html;
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
    if (STATE.searchResults.length > 0) renderSearchResults();
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
    var percent = 0;
    if (STATE.audio.duration) {
      percent = (STATE.audio.currentTime / STATE.audio.duration) * 100;
    }
    STATE.appRefs.progressFill.style.width = percent + '%';
    STATE.appRefs.currentTime.textContent = formatTime(STATE.audio.currentTime);
    if (STATE.audio.duration) {
      STATE.appRefs.totalTime.textContent = formatTime(STATE.audio.duration);
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

  // 网易云扫码登录
  function startQrLogin() {
    var refs = STATE.appRefs;
    refs.qrImg.style.display = 'none';
    refs.qrPlaceholder.style.display = 'block';
    refs.qrPlaceholder.textContent = '正在获取二维码...';
    refs.loginStatus.textContent = '';
    refs.loginStatus.className = 'rmp-login-status';

    // 清除旧的轮询
    if (STATE.qrPollTimer) {
      clearInterval(STATE.qrPollTimer);
      STATE.qrPollTimer = null;
    }

    getQrLogin().then(function (data) {
      if (!data || !data.unikey) {
        refs.qrPlaceholder.textContent = '获取二维码失败';
        refs.loginStatus.textContent = '获取二维码失败，请检查后端地址';
        refs.loginStatus.className = 'rmp-login-status error';
        return;
      }
      var key = data.unikey;
      if (data.qrimg) {
        refs.qrImg.src = data.qrimg;
        refs.qrImg.style.display = 'block';
        refs.qrPlaceholder.style.display = 'none';
      }
      refs.loginStatus.textContent = '请使用网易云音乐 APP扫码';
      refs.loginStatus.className = 'rmp-login-status';

      // 开始轮询
      STATE.qrPollTimer = setInterval(function () {
        checkQrLogin(key).then(function (result) {
          if (!result) return;
          switch (result.code) {
            case 800:
              refs.loginStatus.textContent = '二维码已过期，请重新获取';
              refs.loginStatus.className = 'rmp-login-status error';
              clearInterval(STATE.qrPollTimer);
              STATE.qrPollTimer = null;
              break;
            case 801:
              refs.loginStatus.textContent = '等待扫码...';
              refs.loginStatus.className = 'rmp-login-status';
              break;
            case 802:
              refs.loginStatus.textContent = '待确认，请在手机上点击确认登录';
              refs.loginStatus.className = 'rmp-login-status';
              break;
            case 803:
              refs.loginStatus.textContent = '登录成功';
              refs.loginStatus.className = 'rmp-login-status success';
              if (result.cookie) {
                STATE.cookie = result.cookie;
                saveSettings();
              }
              clearInterval(STATE.qrPollTimer);
              STATE.qrPollTimer = null;
              if (STATE.roche && STATE.roche.ui) STATE.roche.ui.toast('网易云登录成功');
              break;
          }
        }).catch(function () {
          // 忽略轮询错误
        });
      }, 2000);
    }).catch(function () {
      refs.qrPlaceholder.textContent = '获取二维码失败';
      refs.loginStatus.textContent = '请求失败，请检查后端地址';
      refs.loginStatus.className = 'rmp-login-status error';
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

  // 保存设置到 roche.storage
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
      STATE.roche.storage.set('rmp_agreed_disclaimer', STATE.hasAgreedDisclaimer ? '1' : '0');
      STATE.roche.storage.set('rmp_extended_sources', STATE.useExtendedSources ? '1' : '0');
      if (STATE.cookie) {
        STATE.roche.storage.set('rmp_cookie', STATE.cookie);
      }
    } catch (e) {}
  }

  // 从 roche.storage 加载设置
  function loadSettings(roche) {
    if (!roche || !roche.storage) return Promise.resolve();
    return Promise.all([
      Promise.resolve(roche.storage.get('rmp_backend')),
      Promise.resolve(roche.storage.get('rmp_default_source')),
      Promise.resolve(roche.storage.get('rmp_quality')),
      Promise.resolve(roche.storage.get('rmp_volume')),
      Promise.resolve(roche.storage.get('rmp_play_mode')),
      Promise.resolve(roche.storage.get('rmp_cookie')),
      Promise.resolve(roche.storage.get('rmp_island_top')),
      Promise.resolve(roche.storage.get('rmp_island_visible')),
      Promise.resolve(roche.storage.get('rmp_island_scroll_mode')),
      Promise.resolve(roche.storage.get('rmp_playlist')),
      Promise.resolve(roche.storage.get('rmp_agreed_disclaimer')),
      Promise.resolve(roche.storage.get('rmp_extended_sources'))
    ]).then(function (results) {
      if (results[0]) STATE.backend = results[0];
      if (results[1]) STATE.defaultSource = results[1];
      if (results[2]) STATE.quality = results[2];
      if (results[3]) STATE.volume = parseFloat(results[3]) || 0.8;
      if (results[4]) STATE.playMode = results[4];
      if (results[5]) STATE.cookie = results[5];
      if (results[6]) {
        var t = parseInt(results[6], 10);
        if (!isNaN(t)) STATE.islandTop = Math.max(0, Math.min(100, t));
      }
      if (results[7] !== null && results[7] !== undefined && results[7] !== '') {
        STATE.islandVisible = results[7] === '1';
      }
      if (results[8] === 'lyric' || results[8] === 'title') {
        STATE.islandScrollMode = results[8];
      }
      // 加载持久化播放列表
      if (results[9]) {
        try {
          var saved = JSON.parse(results[9]);
          if (Array.isArray(saved) && saved.length > 0) {
            STATE.playlist = saved;
          }
        } catch (e) {}
      }
      // 加载免责声明同意状态
      if (results[10] === '1') STATE.hasAgreedDisclaimer = true;
      // 加载扩展音源开关状态
      if (results[11] === '1') STATE.useExtendedSources = true;
    }).catch(function () {});
  }

  // ==================== ContextProvider ====================

  function contextProvider(ctx) {
    // 没有在听歌返回 null
    if (!STATE.currentSong || !STATE.audio) return null;

    var song = STATE.currentSong;
    var result = '【user当前正在听音乐】\n';
    result += '歌曲：《' + (song.name || '未知') + '》\n';
    result += '歌手：' + (song.artist || '未知') + '\n';
    result += '专辑：' + (song.album || '未知') + '\n\n';

    // 当前听到的歌词
    var currentLyric = '';
    if (STATE.lyrics && STATE.lyrics.length > 0 && STATE.currentLyricIndex >= 0) {
      currentLyric = STATE.lyrics[STATE.currentLyricIndex].text;
      // 加上翻译
      if (STATE.tlyrics && STATE.tlyrics.length > 0) {
        var tIdx = getCurrentLyricIndex(STATE.tlyrics, STATE.audio.currentTime);
        if (tIdx >= 0 && STATE.tlyrics[tIdx]) {
          currentLyric += '（' + STATE.tlyrics[tIdx].text + '）';
        }
      }
    }
    result += 'user当前听到的歌词：' + (currentLyric || '（纯音乐或暂无歌词）') + '\n\n';

    // 完整歌词（只注入当前句前后各 5 行，共 11 行，减少 token 占用）
    if (STATE.lyrics && STATE.lyrics.length > 0) {
      var curIdx = STATE.currentLyricIndex;
      var start = Math.max(0, (curIdx >= 0 ? curIdx : 0) - 5);
      var end = Math.min(STATE.lyrics.length, (curIdx >= 0 ? curIdx : 0) + 6);
      result += '完整歌词（user当前听到第 ' + (curIdx + 1) + ' 句，标注【当前】，仅显示前后5行）：\n';
      for (var i = start; i < end; i++) {
        var prefix = (i === curIdx) ? '【当前】' : '';
        result += prefix + (STATE.lyrics[i].text || '...') + '\n';
      }
    }

    return result;
  }

  // ==================== 插件注册 ====================

  window.RochePlugin = window.RochePlugin || {};

  window.RochePlugin.register({
    id: 'roche-music-player',
    name: '音乐播放器',
    version: '1.0.10',

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
            // 同步免责声明状态到 UI（renderApp 先于 loadSettings，checkbox 初始为 false）
            if (STATE.appRefs.agreeCheckbox) {
              STATE.appRefs.agreeCheckbox.checked = STATE.hasAgreedDisclaimer;
            }
            updateDisclaimerLockUI();
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
          // 免责声明拦截
          if (!STATE.hasAgreedDisclaimer) {
            return Promise.resolve({ success: false, message: '用户尚未同意免责声明，请在插件设置中同意后再点歌' });
          }
          var keyword = artist ? (songName + ' ' + artist) : songName;
          // 扩展音源关闭时：仅搜索网易云
          var searchSource = STATE.useExtendedSources ? STATE.defaultSource : 'netease';
          return searchMusic(keyword, searchSource, 5).then(function (results) {
            if (!results || results.length === 0) {
              // 如果扩展音源开启且默认源没结果，尝试全平台
              if (STATE.useExtendedSources) return searchMusic(keyword, 'all', 5);
              else return [];
            }
            return results;
          }).then(function (results) {
            if (!results || results.length === 0) {
              return { success: false, message: '未找到歌曲：' + songName };
            }
            var best = results[0];
            for (var i = 0; i < results.length; i++) {
              if (results[i].name && results[i].name.indexOf(songName) >= 0) {
                best = results[i];
                break;
              }
            }
            // 添加到播放列表（addToPlaylist 去重 + 刷新UI + 持久化）
            var idx = addToPlaylist(best);
            playSong(best, idx);
            return { success: true, song: best.name, artist: best.artist, platform: best.platform };
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
          // mount 中 renderApp 先于 loadSettings，同步声明状态到 UI
          if (STATE.appRefs.agreeCheckbox) {
            STATE.appRefs.agreeCheckbox.checked = STATE.hasAgreedDisclaimer;
          }
          updateDisclaimerLockUI();
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
