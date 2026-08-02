/**
 * Roche 网易云音乐播放器插件 v2.0.0
 * 仅使用网易云官方API，移除所有第三方音乐源
 */

(function () {
  'use strict';
  if (window.__roche_music_player_loaded__) return;
  window.__roche_music_player_loaded__ = true;

  var BUILD_TIME = '2026-08-03-v2.0.0';
  console.log('[MusicPlugin] Loaded. Build:', BUILD_TIME);

  var STATE = {
    currentSong: null,
    playlist: [],
    playlistMap: {},
    currentIdx: -1,
    mode: 0,
    lyrics: [],
    lyricsList: null,
    isPlaying: false,
    seekTime: 0,
    quality: 320000,
    contextLen: 5,
    neteaseApiBase: '',
    neteaseCookie: '',
    searchKeyword: '',
    hot: [],
    recommend: [],
    hotLoading: false,
    recommendLoading: false,
    searchResults: [],
    islandOpen: false
  };

  try {
    var v = parseInt(localStorage.getItem('rmp_volume') || '1', 10);
    if (isNaN(v) || v < 0) v = 1;
    STATE.volume = Math.min(1, v);
  } catch (e) { STATE.volume = 1; }
  try { STATE.mode = parseInt(localStorage.getItem('rmp_mode') || '0', 10) || 0; } catch (e) {}
  try { STATE.contextLen = parseInt(localStorage.getItem('rmp_context_len') || '5', 10) || 5; } catch (e) {}
  try { STATE.quality = parseInt(localStorage.getItem('rmp_quality') || '320000', 10) || 320000; } catch (e) {}
  try { STATE.neteaseApiBase = localStorage.getItem('rmp_netease_api') || ''; } catch (e) {}
  try { STATE.neteaseCookie = localStorage.getItem('rmp_netease_cookie') || ''; } catch (e) {}

  var audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.volume = STATE.volume;
  audio.preload = 'auto';

  function esc(s) {
    if (s === null || s === undefined) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s)));
    return d.innerHTML;
  }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) return '00:00';
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function showToast(msg) {
    var el = document.getElementById('rmp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rmp-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  function ncmApi(base, path, data, method) {
    method = (method || 'GET').toUpperCase();
    var url = base.replace(/\/+$/, '') + path;
    var opts = { method: method, mode: 'cors' };
    var headers = {};
    if (STATE.neteaseCookie) {
      headers['Cookie'] = STATE.neteaseCookie;
      headers['x-real-cookie'] = STATE.neteaseCookie;
    }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      var body = [];
      if (data) {
        Object.keys(data).forEach(function (k) { body.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k])); });
      }
      if (STATE.neteaseCookie) {
        var m = STATE.neteaseCookie.match(/__csrf=([^;]+)/);
        if (m && m[1]) headers['x-csrf-token'] = m[1];
      }
      opts.body = body.join('&');
    } else if (data && Object.keys(data).length) {
      var qs = [];
      Object.keys(data).forEach(function (k) { qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k])); });
      url += (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
    }
    opts.headers = headers;
    var realIp = localStorage.getItem('rmp_netease_real_ip');
    if (realIp && url.indexOf('/song/url/v1') === -1) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'realIP=' + encodeURIComponent(realIp);
    }
    return fetch(url, opts).then(function (r) {
      if (r.status === 204 || r.status === 200) return r.json();
      return r.text().then(function (t) { throw new Error('HTTP ' + r.status + (t ? ' - ' + t.slice(0, 100) : '')); });
    }).then(function (j) {
      if (j && j.code === 200) return j;
      if (j && j.code === 204) return j;
      if (path === '/check/music' && j && (j.code === 200 || j.success === true)) return j;
      throw new Error('API code ' + (j && j.code) + ' ' + (j && (j.message || j.msg) || ''));
    });
  }

  function neteaseApi(path, data, method) {
    method = method || 'GET';
    var base = (STATE.neteaseApiBase || '').replace(/\/+$/, '');
    if (!base) {
      base = 'https://netease-cloud-music-api.netlify.app';
      STATE.neteaseApiBase = base;
    }
    return ncmApi(base, path, data, method);
  }

  function parseLrc(text) {
    if (!text) return [];
    var lines = String(text).split(/\r?\n/);
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    var out = [];
    lines.forEach(function (line) {
      var text = line.replace(re, '').trim();
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        var mm = parseInt(m[1], 10), ss = parseInt(m[2], 10), ms = parseInt(m[3] || '0', 10);
        if (m[3] && m[3].length === 2) ms *= 10;
        var t = mm * 60 + ss + ms / (m[3] && m[3].length === 2 ? 100 : 1000);
        out.push({ time: t, text: text });
      }
    });
    out.sort(function (a, b) { return a.time - b.time; });
    var dedup = [];
    out.forEach(function (r) {
      if (!dedup.length || Math.abs(dedup[dedup.length - 1].time - r.time) > 0.1 || dedup[dedup.length - 1].text !== r.text) {
        dedup.push(r);
      }
    });
    return dedup;
  }

  audio.addEventListener('timeupdate', function () {
    try {
      var bar = document.querySelector('.rmp-progress-fill');
      var dot = document.querySelector('.rmp-progress-dot');
      var cur = document.querySelector('.rmp-cur-time');
      if (bar) bar.style.width = (audio.duration ? (audio.currentTime / audio.duration * 100) : 0) + '%';
      if (dot) dot.style.left = (audio.duration ? (audio.currentTime / audio.duration * 100) : 0) + '%';
      if (cur) cur.textContent = fmtTime(audio.currentTime);
      highlightLyric();
    } catch (e) {}
  });
  audio.addEventListener('loadedmetadata', function () {
    var tot = document.querySelector('.rmp-tot-time');
    if (tot) tot.textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('ended', function () {
    STATE.isPlaying = false;
    updatePlayBtn();
    if (STATE.mode === 2) {
      audio.currentTime = 0;
      audio.play().catch(function () {});
      return;
    }
    if (STATE.playlist.length > 1) playNext();
  });
  audio.addEventListener('play', function () { STATE.isPlaying = true; updatePlayBtn(); });
  audio.addEventListener('pause', function () { STATE.isPlaying = false; updatePlayBtn(); });
  audio.addEventListener('error', function (e) {
    console.warn('[MusicPlugin] audio error', e);
    if (audio.src && audio.src.indexOf('?') !== -1) {
      showToast('音频加载失败，尝试下一首...');
      setTimeout(playNext, 800);
    }
  });

  function updatePlayBtn() {
    var btn = document.querySelector('.rmp-play');
    var islandPlay = document.querySelector('.rmp-island-play');
    var ico = STATE.isPlaying ? '⏸' : '▶';
    if (btn) btn.innerHTML = '<span class="rmp-play-ico">' + ico + '</span>';
    if (islandPlay) islandPlay.innerHTML = '<span>' + ico + '</span>';
  }

  function highlightLyric() {
    if (!STATE.lyrics || !STATE.lyrics.length || !STATE.lyricsList) return;
    var t = audio.currentTime;
    var active = 0;
    for (var i = 0; i < STATE.lyrics.length; i++) {
      if (STATE.lyrics[i].time <= t) active = i;
      else break;
    }
    var items = STATE.lyricsList.querySelectorAll('.rmp-lyric-item');
    items.forEach(function (it, i) {
      if (i === active) it.classList.add('on');
      else it.classList.remove('on');
    });
    var a = STATE.lyricsList.querySelector('.rmp-lyric-item.on');
    if (a && STATE.lyricsList.parentElement) {
      var wrapRect = STATE.lyricsList.parentElement.getBoundingClientRect();
      var iRect = a.getBoundingClientRect();
      var delta = iRect.top - wrapRect.top - wrapRect.height / 2 + iRect.height / 2;
      STATE.lyricsList.style.transform = 'translateY(' + (-delta) + 'px)';
    }
  }

  function togglePlay() {
    if (!STATE.currentSong) { showToast('当前没有播放歌曲'); return; }
    if (audio.paused) {
      if (!audio.src) {
        playSong(STATE.currentSong, false);
        return;
      }
      audio.play().catch(function (e) { showToast('播放失败：' + (e.message || e)); });
    } else audio.pause();
  }

  function playPrev() {
    if (!STATE.playlist.length) return;
    if (STATE.mode === 1) {
      STATE.currentIdx = Math.floor(Math.random() * STATE.playlist.length);
    } else {
      STATE.currentIdx--;
      if (STATE.currentIdx < 0) STATE.currentIdx = STATE.playlist.length - 1;
    }
    var id = STATE.playlist[STATE.currentIdx];
    playSong(STATE.playlistMap[id], true);
  }

  function playNext() {
    if (!STATE.playlist.length) return;
    if (STATE.mode === 1) {
      STATE.currentIdx = Math.floor(Math.random() * STATE.playlist.length);
    } else {
      STATE.currentIdx++;
      if (STATE.currentIdx >= STATE.playlist.length) STATE.currentIdx = 0;
    }
    var id = STATE.playlist[STATE.currentIdx];
    playSong(STATE.playlistMap[id], true);
  }

  function getContext() {
    try {
      if (window.Roche && typeof window.Roche.getContext === 'function') return window.Roche.getContext();
      if (window.ChatApp && typeof window.ChatApp.getContext === 'function') return window.ChatApp.getContext();
    } catch (e) {}
    return null;
  }

  function getCurrentConversationIdFromNav() {
    try {
      var hash = location.hash || '';
      var m = hash.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) return m[1];
      var path = location.pathname || '';
      m = path.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) return m[1];
    } catch (e) {}
    return null;
  }

  function updateContextInject() {
    if (STATE.contextLen <= 0) return;
    try {
      var ctx = getContext();
      if (!ctx) return;
      var cid = getCurrentConversationIdFromNav();
      if (!cid) return;
      var song = STATE.currentSong;
      if (!song) return;
      var prefix = '[正在播放的音乐]\n';
      var suffix = '\n（以上内容为插件自动注入的当前播放音乐信息，你可以听到这首歌，请基于此与我交流音乐相关内容。当用户问你在听什么时，请自然分享并可以讨论这首歌。）';
      var lines = [];
      var take = STATE.contextLen;
      var haveLyrics = STATE.lyrics && STATE.lyrics.length > 0;
      if (haveLyrics) {
        var curIdx = 0;
        for (var i = 0; i < STATE.lyrics.length; i++) {
          if (STATE.lyrics[i].time <= audio.currentTime) curIdx = i;
          else break;
        }
        var start = Math.max(0, curIdx - Math.floor(take / 2));
        var end = Math.min(STATE.lyrics.length, start + take);
        if (end - start < take) start = Math.max(0, end - take);
        for (var j = start; j < end; j++) {
          if (STATE.lyrics[j].text) lines.push((j === curIdx ? '▶ ' : '  ') + STATE.lyrics[j].text);
        }
      }
      var txt = '歌名：' + song.name + '\n歌手：' + song.artist;
      if (lines.length) txt += '\n当前歌词（▶为正在播放的位置）：\n' + lines.join('\n');
      var full = prefix + txt + suffix;
      var setCtx = ctx.setContext || ctx.setConversationContext;
      if (typeof setCtx === 'function') setCtx.call(ctx, cid, full);
    } catch (e) { console.warn('[MusicPlugin] context inject error', e); }
  }

  var _lastInjectTime = 0;
  setInterval(function () {
    if (!STATE.isPlaying || !STATE.currentSong) return;
    var now = Date.now();
    if (now - _lastInjectTime < 8000) return;
    _lastInjectTime = now;
    updateContextInject();
  }, 3000);

  function doSearch(keyword) {
    return neteaseApi('/cloudsearch', { keywords: keyword, limit: 30, offset: 0 }, 'POST').then(function (d) {
      var songs = (d.result && d.result.songs) || [];
      return Promise.all(songs.map(function (s) {
        return neteaseApi('/song/url/v1', { id: s.id, level: 'standard' }, 'POST').then(function (u) {
          var url = u && u.data && u.data[0] && u.data[0].url;
          return neteaseApi('/lyric/new', { id: s.id }, 'POST').then(function (lr) {
            var lrc = lr && (lr.lrc && lr.lrc.lyric || lr.nolyric || lr.uncollected);
            var hasLrc = lr && !lr.nolyric && !lr.uncollected && lr.lrc && lr.lrc.lyric && lr.lrc.lyric.trim().length > 0;
            return neteaseApi('/song/detail', { ids: String(s.id) }, 'POST').then(function (det) {
              var ar = (s.artists || s.ar || []).map(function (a) { return a.name; }).join('/');
              var al = s.album || s.al || {};
              var pic = al.picUrl || (det && det.songs && det.songs[0] && det.songs[0].al && det.songs[0].al.picUrl) || '';
              var isInst = isInstrumental(s.name);
              var pass = !!url && (isInst || hasLrc);
              if (pass) {
                return { id: 'n_' + s.id, src: 'netease', nid: s.id, name: s.name, artist: ar, pic: pic, url: url, lrc: lrc || '' };
              }
              return null;
            });
          });
        }).catch(function () { return null; });
      })).then(function (arr) { return arr.filter(Boolean); });
    });
  }

  function isInstrumental(name) {
    if (!name) return false;
    var lower = String(name).toLowerCase();
    var keywords = ['纯音乐', '伴奏', 'instrumental', 'piano', '钢琴曲', '钢琴独奏', 'bgm', 'ost', '原声', 'pure music', 'acappella', '阿卡贝拉'];
    return keywords.some(function (k) { return lower.indexOf(k.toLowerCase()) !== -1; });
  }

  function resolveNetease(id, song) {
    return neteaseApi('/song/url/v1', { id: id, level: 'exhigh' }, 'POST').then(function (u) {
      var data = (u.data && u.data[0]) || {};
      var url = data.url;
      if (url) {
        if (url.indexOf('http://') === 0) url = 'https://' + url.slice(7);
        return neteaseApi('/lyric/new', { id: id }, 'POST').then(function (lr) {
          song.url = url;
          song.lrc = lr && lr.lrc && lr.lrc.lyric;
          return song;
        });
      }
      throw new Error('无法获取播放链接（可能需要VIP）');
    });
  }

  function playSong(song, auto) {
    if (!song) return;
    auto = !!auto;
    STATE.currentSong = song;
    if (STATE.playlist.indexOf(song.id) === -1) {
      STATE.playlist.push(song.id);
      STATE.playlistMap[song.id] = song;
      STATE.currentIdx = STATE.playlist.length - 1;
    } else {
      STATE.currentIdx = STATE.playlist.indexOf(song.id);
    }
    renderPlaylist();
    renderPlaying();
    var apply = function (s) {
      STATE.lyrics = parseLrc(s.lrc || '');
      updateLyricsUI();
      audio.src = s.url;
      audio.play().then(function () {
        renderPlaying();
        showToast('♪ ' + s.name);
        updateIsland();
        updateContextInject();
      }).catch(function (e) { showToast('播放失败：' + (e.message || e)); });
    };
    if (song.src === 'netease' && song.nid) {
      resolveNetease(song.nid, song).then(apply).catch(function (e) { showToast('获取播放链接失败：' + (e.message || e)); });
    } else {
      apply(song);
    }
  }

  function updateLyricsUI() {
    var wrap = document.querySelector('.rmp-lyrics-wrap');
    var detailWrap = document.querySelector('.rmp-disc-lyrics');
    var html = '';
    if (!STATE.lyrics.length) html = '<div class="rmp-lyric-item">暂无歌词</div>';
    else STATE.lyrics.forEach(function (l) { html += '<div class="rmp-lyric-item">' + esc(l.text) + '</div>'; });
    if (wrap) wrap.innerHTML = '<div class="rmp-lyrics-list">' + html + '</div>';
    if (detailWrap) detailWrap.innerHTML = '<div class="rmp-lyrics-list">' + html + '</div>';
    var list = wrap ? wrap.querySelector('.rmp-lyrics-list') : null;
    STATE.lyricsList = list;
  }

  function updateIsland() {
    var island = document.querySelector('.rmp-island');
    if (!island) return;
    if (STATE.currentSong) {
      island.classList.add('has-song');
      var title = island.querySelector('.rmp-island-title');
      var artist = island.querySelector('.rmp-island-artist');
      var play = island.querySelector('.rmp-island-play');
      if (title) title.textContent = STATE.currentSong.name;
      if (artist) artist.textContent = STATE.currentSong.artist;
      if (play) play.innerHTML = '<span>' + (STATE.isPlaying ? '⏸' : '▶') + '</span>';
    } else {
      island.classList.remove('has-song');
    }
  }

  function loadHot() {
    if (STATE.hotLoading) return;
    STATE.hotLoading = true;
    var hotBox = document.querySelector('.rmp-hot');
    if (hotBox) hotBox.innerHTML = '<div class="rmp-loading" style="padding:18px;grid-column:1/-1;">热歌榜加载中...</div>';
    neteaseApi('/playlist/detail', { id: 3778678 }, 'POST').then(function (d) {
      STATE.hot = ((d.playlist && d.playlist.trackIds) || []).slice(0, 12).map(function (t) { return t.id; });
      return neteaseApi('/song/detail', { ids: STATE.hot.join(',') }, 'POST');
    }).then(function (d) {
      STATE.hot = ((d && d.songs) || []).map(function (s) {
        var ar = (s.ar || []).map(function (a) { return a.name; }).join('/');
        var pic = s.al && s.al.picUrl;
        return { id: 'n_' + s.id, src: 'netease', nid: s.id, name: s.name, artist: ar, pic: pic };
      });
      if (hotBox) {
        hotBox.innerHTML = '';
        STATE.hot.forEach(function (s) {
          var it = document.createElement('div');
          it.className = 'rmp-card';
          it.setAttribute('data-id', s.id);
          it.innerHTML = '<div class="rmp-card-cover"><img src="' + (s.pic || '') + '" loading="lazy" onerror="this.style.opacity=0"/></div><div class="rmp-card-name">' + esc(s.name) + '</div><div class="rmp-card-artist">' + esc(s.artist) + '</div>';
          hotBox.appendChild(it);
        });
      }
      STATE.hotLoading = false;
    }).catch(function (e) {
      STATE.hotLoading = false;
      if (hotBox) hotBox.innerHTML = '<div class="rmp-error" style="padding:18px;grid-column:1/-1;">热歌榜加载失败：' + esc(e.message || e) + '</div>';
    });
  }

  function loadRecommend() {
    if (STATE.recommendLoading) return;
    STATE.recommendLoading = true;
    var recBox = document.querySelector('.rmp-recommend-list');
    if (recBox) recBox.innerHTML = '<div class="rmp-loading" style="padding:14px;grid-column:1/-1;">推荐歌单加载中...</div>';
    neteaseApi('/personalized', { limit: 6 }, 'POST').then(function (d) {
      STATE.recommend = (d.result || []).slice(0, 6).map(function (p) {
        return { id: p.id, name: p.name, pic: p.picUrl, playcount: p.playCount };
      });
      if (recBox) {
        recBox.innerHTML = '';
        STATE.recommend.forEach(function (p) {
          var cnt = (p.playcount / 10000).toFixed(1) + '万';
          var it = document.createElement('div');
          it.className = 'rmp-card';
          it.setAttribute('data-pid', p.id);
          it.innerHTML = '<div class="rmp-card-cover"><img src="' + (p.pic || '') + '" loading="lazy" onerror="this.style.opacity=0"/><div class="rmp-card-count">▶ ' + cnt + '</div></div><div class="rmp-card-name">' + esc(p.name) + '</div>';
          recBox.appendChild(it);
        });
      }
      STATE.recommendLoading = false;
    }).catch(function (e) {
      STATE.recommendLoading = false;
      if (recBox) recBox.innerHTML = '<div class="rmp-error" style="padding:14px;grid-column:1/-1;">推荐加载失败：' + esc(e.message || e) + '</div>';
    });
  }

  function loadPlaylistSongs(pid, name) {
    var list = document.querySelector('.rmp-ne-songs');
    var detail = document.querySelector('.rmp-ne-detail');
    var neList = document.querySelector('.rmp-ne-list');
    var title = document.querySelector('.rmp-ne-title');
    var loading = document.querySelector('.rmp-ne-loading');
    if (title) title.textContent = name || '歌单';
    if (neList) neList.classList.remove('show');
    if (detail) detail.classList.add('show');
    if (loading) loading.style.display = 'block';
    if (list) list.innerHTML = '';
    neteaseApi('/playlist/detail', { id: pid }, 'POST').then(function (d) {
      var ids = ((d.playlist && d.playlist.trackIds) || []).slice(0, 30).map(function (t) { return t.id; });
      return neteaseApi('/song/detail', { ids: ids.join(',') }, 'POST');
    }).then(function (d) {
      STATE.searchResults = ((d && d.songs) || []).map(function (s) {
        var ar = (s.ar || []).map(function (a) { return a.name; }).join('/');
        var pic = s.al && s.al.picUrl;
        return { id: 'n_' + s.id, src: 'netease', nid: s.id, name: s.name, artist: ar, pic: pic };
      });
      if (list) {
        STATE.searchResults.forEach(function (s, i) {
          var it = document.createElement('div');
          it.className = 'rmp-ne-item';
          it.setAttribute('data-idx', i);
          var num = i + 1 < 10 ? '0' + (i + 1) : (i + 1);
          it.innerHTML = '<span class="rmp-ne-idx">' + num + '</span>'
            + '<img class="rmp-ne-cover" src="' + (s.pic || '') + '" onerror="this.style.opacity=0"/>'
            + '<div class="rmp-ne-info"><div class="rmp-ne-name">' + esc(s.name) + '</div><div class="rmp-ne-art">' + esc(s.artist) + '</div></div>'
            + '<span class="rmp-ne-dur"></span>'
            + '<button class="rmp-ne-play" data-idx="' + i + '">+</button>';
          list.appendChild(it);
        });
      }
      if (loading) loading.style.display = 'none';
    }).catch(function (e) {
      if (loading) loading.style.display = 'none';
      showToast('歌单加载失败：' + (e.message || e));
    });
  }

  function renderPlaying() {
    var container = document.getElementById('roche-music-player-root');
    if (!container) return;
    var s = STATE.currentSong;
    if (!s) return;
    var name = container.querySelector('.rmp-song-name');
    var artist = container.querySelector('.rmp-song-artist');
    var discName = container.querySelector('.rmp-disc-name');
    var discArtist = container.querySelector('.rmp-disc-artist');
    var cover = container.querySelector('.rmp-cover-img');
    var disc = container.querySelector('.rmp-disc-cover');
    var bg = container.querySelector('.rmp-ne-bg');
    if (name) name.textContent = s.name;
    if (artist) artist.textContent = s.artist;
    if (discName) discName.textContent = s.name;
    if (discArtist) discArtist.textContent = s.artist;
    if (cover) {
      if (s.pic) {
        cover.src = s.pic;
        cover.style.display = '';
      } else {
        cover.style.display = 'none';
      }
    }
    if (disc) {
      if (s.pic) {
        disc.style.backgroundImage = 'url(' + s.pic + ')';
      } else {
        var g1 = '#' + Math.floor(Math.random() * 0x555555 + 0x999999).toString(16);
        var g2 = '#' + Math.floor(Math.random() * 0x555555 + 0x555555).toString(16);
        disc.style.background = 'linear-gradient(135deg,' + g1 + ',' + g2 + ')';
      }
    }
    if (bg && s.pic) bg.style.backgroundImage = 'url(' + s.pic + '?param=400y400)';
    updateLyricsUI();
    updatePlayBtn();
  }

  function renderPlaylist() {
    var box = document.querySelector('.rmp-pl-list');
    if (!box) return;
    box.innerHTML = '';
    if (!STATE.playlist.length) {
      box.innerHTML = '<div class="rmp-loading" style="padding:24px;">暂无播放歌曲</div>';
      return;
    }
    STATE.playlist.forEach(function (id, i) {
      var s = STATE.playlistMap[id];
      if (!s) return;
      var it = document.createElement('div');
      it.className = 'rmp-pl-item' + (i === STATE.currentIdx ? ' on' : '');
      it.setAttribute('data-id', id);
      it.innerHTML = '<span class="rmp-pl-idx">' + (i + 1) + '</span>'
        + '<img class="rmp-pl-cover" src="' + (s.pic || '') + '" onerror="this.style.opacity=0"/>'
        + '<div class="rmp-pl-info"><div class="rmp-pl-name">' + esc(s.name) + '</div><div class="rmp-pl-art">' + esc(s.artist) + '</div></div>'
        + '<button class="rmp-pl-remove" data-id="' + id + '">×</button>';
      box.appendChild(it);
    });
    box.querySelectorAll('.rmp-pl-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var rid = btn.getAttribute('data-id');
        var idx = STATE.playlist.indexOf(rid);
        if (idx > -1) {
          STATE.playlist.splice(idx, 1);
          delete STATE.playlistMap[rid];
          if (idx < STATE.currentIdx) STATE.currentIdx--;
          else if (idx === STATE.currentIdx) {
            STATE.currentIdx = -1;
            STATE.currentSong = null;
            audio.pause();
            audio.src = '';
          }
          renderPlaylist();
        }
      });
    });
  }

  function handleHot(e) {
    var card = e.target.closest('.rmp-card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var pid = card.getAttribute('data-pid');
    if (pid) {
      var nm = card.querySelector('.rmp-card-name');
      loadPlaylistSongs(pid, nm ? nm.textContent : '');
      return;
    }
    if (id) {
      var src = id.split('_');
      var song = { id: id, src: src[0], nid: src[0] === 'n' ? src[1] : null, name: card.querySelector('.rmp-card-name').textContent, artist: card.querySelector('.rmp-card-artist') ? card.querySelector('.rmp-card-artist').textContent : '', pic: card.querySelector('img') ? card.querySelector('img').src : '' };
      playSong(song, true);
    }
  }

  function handleNeList(e) {
    var btn = e.target.closest('.rmp-ne-play');
    if (btn) {
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      var s = STATE.searchResults[idx];
      if (s) {
        playSong(s, true);
        switchTab('playing');
        renderPlaying();
      }
    }
  }

  function closePlugin() {
    var app = document.getElementById('roche-music-player-root');
    if (app) app.remove();
    var btn = document.getElementById('roche-music-fab');
    if (btn) btn.style.display = '';
    var mbtn = document.querySelector('.rmp-mount-btn');
    if (mbtn) mbtn.style.display = '';
    inited = false;
  }

  function closeIsland() {
    STATE.islandOpen = false;
    audio.pause();
    audio.src = '';
    STATE.currentSong = null;
    STATE.lyrics = [];
    var island = document.querySelector('.rmp-island');
    if (island) island.classList.remove('open', 'has-song');
    updateContextInject();
  }

  var inited = false;
  function renderApp() {
    if (inited) {
      var old = document.getElementById('roche-music-player-root');
      if (old) old.remove();
    }
    inited = true;
    try {
      var fab = document.getElementById('roche-music-fab');
      if (fab) fab.style.display = 'none';
      var container = document.createElement('div');
      container.id = 'roche-music-player-root';
      container.innerHTML = '\
      <div class="roche-music-player">\
        <div class="rmp-ne-bg"></div>\
        <div class="rmp-topbar">\
          <div class="rmp-brand">\
            <div class="rmp-brand-mark"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>\
            <div class="rmp-brand-text">\
              <span class="rmp-brand-name">网易云音乐</span>\
              <span class="rmp-brand-ver">' + BUILD_TIME.split('-v')[1] + '</span>\
            </div>\
          </div>\
          <button class="rmp-close-btn" title="关闭">关闭</button>\
        </div>\
        <div class="rmp-tabs">\
          <button class="rmp-tab active" data-tab="discover">发现</button>\
          <button class="rmp-tab" data-tab="playing">正在播放</button>\
          <button class="rmp-tab" data-tab="playlist">播放列表</button>\
          <button class="rmp-tab" data-tab="settings">设置</button>\
        </div>\
        <div class="rmp-tab-panel active" data-panel="discover">\
          <div class="rmp-section">\
            <div class="rmp-section-title">🔥 热歌榜</div>\
            <div class="rmp-hot"></div>\
          </div>\
          <div class="rmp-section">\
            <div class="rmp-section-title">💿 推荐歌单</div>\
            <div class="rmp-recommend-list"></div>\
          </div>\
          <div class="rmp-ne-list show">\
            <div class="rmp-section"><div class="rmp-section-title">🔍 搜索音乐</div>\
              <div class="rmp-search-box">\
                <input class="rmp-search-input" type="text" placeholder="输入歌名/歌手，回车搜索"/>\
                <button class="rmp-search-btn">搜索</button>\
              </div>\
            </div>\
          </div>\
          <div class="rmp-ne-detail">\
            <div class="rmp-ne-header">\
              <button class="rmp-ne-back">← 返回</button>\
              <div class="rmp-ne-title">歌单</div>\
            </div>\
            <div class="rmp-ne-loading" style="padding:14px;display:none;">加载中...</div>\
            <div class="rmp-ne-songs"></div>\
          </div>\
        </div>\
        <div class="rmp-tab-panel" data-panel="playing">\
          <div class="rmp-cover-area">\
            <div class="rmp-cover-disc"><div class="rmp-disc-cover"></div></div>\
            <img class="rmp-cover-img" style="display:none;"/>\
          </div>\
          <div class="rmp-song-info">\
            <div class="rmp-song-name">未播放歌曲</div>\
            <div class="rmp-song-artist">--</div>\
          </div>\
          <div class="rmp-lyrics-wrap"></div>\
          <div class="rmp-disc-lyrics-wrap"><div class="rmp-disc-lyrics"></div></div>\
          <div class="rmp-progress">\
            <span class="rmp-cur-time">00:00</span>\
            <div class="rmp-progress-bar"><div class="rmp-progress-fill"></div><div class="rmp-progress-dot"></div></div>\
            <span class="rmp-tot-time">00:00</span>\
          </div>\
          <div class="rmp-controls">\
            <button class="rmp-mode"><span class="rmp-mode-ico">🔀</span><span class="rmp-mode-lbl">顺序</span></button>\
            <button class="rmp-prev">⏮</button>\
            <button class="rmp-play"><span class="rmp-play-ico">▶</span></button>\
            <button class="rmp-next">⏭</button>\
            <div class="rmp-volume-wrap">\
              <button class="rmp-volume-btn"><span class="rmp-vol-icon">🔊</span></button>\
              <div class="rmp-volume-panel"><div class="rmp-volume-bar"><div class="rmp-volume-fill"></div><div class="rmp-volume-dot"></div></div></div>\
            </div>\
          </div>\
        </div>\
        <div class="rmp-tab-panel" data-panel="playlist">\
          <div class="rmp-pl-header">\
            <div class="rmp-pl-title">播放列表</div>\
            <button class="rmp-pl-clear">清空</button>\
          </div>\
          <div class="rmp-pl-list"></div>\
        </div>\
        <div class="rmp-tab-panel" data-panel="settings">\
          <div class="rmp-settings">\
            <div class="rmp-setting-group">\
              <div class="rmp-setting-title">🌐 网易云API地址</div>\
              <input class="rmp-api-input" type="text" placeholder="https://your-app.netlify.app/.netlify/functions/ncm"/>\
              <div style="display:flex;gap:6px;margin-top:8px;">\
                <button class="rmp-api-save">保存</button>\
                <button class="rmp-api-reset">恢复默认</button>\
                <button class="rmp-api-test">测试连接</button>\
              </div>\
            </div>\
            <div class="rmp-setting-group">\
              <div class="rmp-setting-title">🔊 音质设置</div>\
              <select class="rmp-quality"><option value="128000">标准 128kbps</option><option value="192000">较高 192kbps</option><option value="320000" selected>极高 320kbps</option><option value="999000">臻音全景</option></select>\
            </div>\
            <div class="rmp-setting-group">\
              <div class="rmp-setting-title">💬 对话注入歌词行数</div>\
              <select class="rmp-ctx"><option value="0">关闭</option><option value="1">1行</option><option value="3">3行</option><option value="5" selected>5行</option><option value="10">10行</option><option value="30">30行</option></select>\
            </div>\
            <div class="rmp-setting-group">\
              <div class="rmp-setting-title">🍪 网易云Cookie（VIP歌曲可选）</div>\
              <input class="rmp-cookie-input" type="text" placeholder="MUSIC_U=xxx; __csrf=xxx"/>\
              <button class="rmp-cookie-save" style="margin-top:8px;">保存Cookie</button>\
            </div>\
            <div class="rmp-ne-disclaimer">\
              <div class="rmp-disclaimer-title">⚠️ 免责声明</div>\
              <div class="rmp-disclaimer-body">\
                本插件为个人学习与技术研究目的开发，非官方网易云产品。<br/>\
                接口设计参考自 NeteaseCloudMusicApi 开源项目，仅供学习参考使用。<br/>\
                所有音乐版权归网易云音乐及相关权利人所有，禁止用于商业用途。<br/>\
                请支持正版音乐，使用本插件即视为同意以上声明。\
              </div>\
            </div>\
          </div>\
        </div>\
      </div>';
      document.body.appendChild(container);
      var style = document.getElementById('rmp-styles');
      if (!style) {
        style = document.createElement('style');
        style.id = 'rmp-styles';
        style.textContent = getAppStyles();
        document.head.appendChild(style);
      }
      var isStyle = document.getElementById('rmp-island-styles');
      if (!isStyle) {
        isStyle = document.createElement('style');
        isStyle.id = 'rmp-island-styles';
        isStyle.textContent = getIslandStyles();
        document.head.appendChild(isStyle);
      }
      var tabs = container.querySelectorAll('.rmp-tab');
      setTimeout(function () {
        // 标签页切换
        tabs.forEach(function (tab) {
          tab.addEventListener('click', function () {
            var tabName = this.getAttribute('data-tab');
            tabs.forEach(function (t) { t.classList.remove('active'); });
            this.classList.add('active');
            var panels = container.querySelectorAll('.rmp-tab-panel');
            panels.forEach(function (p) { p.classList.remove('active'); });
            var target = container.querySelector('[data-panel="' + tabName + '"]');
            if (target) target.classList.add('active');
            if (tabName === 'discover') {
              loadHot();
              loadRecommend();
            }
            if (tabName === 'search' && STATE.searchKeyword) {
              var input = container.querySelector('.rmp-search-input');
              if (input) input.value = STATE.searchKeyword;
            }
          });
        });
        // 搜索功能
        var searchInput = container.querySelector('.rmp-search-input');
        var searchBtn = container.querySelector('.rmp-search-btn');
        var performSearch = function () {
          var kw = (searchInput.value || '').trim();
          if (!kw) { showToast('请输入搜索关键词'); return; }
          STATE.searchKeyword = kw;
          var list = container.querySelector('.rmp-ne-songs');
          var neList = container.querySelector('.rmp-ne-list');
          var detail = container.querySelector('.rmp-ne-detail');
          var title = container.querySelector('.rmp-ne-title');
          var loading = container.querySelector('.rmp-ne-loading');
          if (title) title.textContent = '搜索：' + kw;
          if (neList) neList.classList.remove('show');
          if (detail) detail.classList.add('show');
          if (loading) loading.style.display = 'block';
          if (list) list.innerHTML = '<div class="rmp-loading" style="padding:20px;">搜索中...</div>';
          doSearch(kw).then(function (songs) {
            STATE.searchResults = songs;
            if (list) {
              list.innerHTML = '';
              if (!songs.length) {
                list.innerHTML = '<div class="rmp-error" style="padding:20px;">未找到可播放歌曲（需要同时有歌词和播放链接）</div>';
                if (loading) loading.style.display = 'none';
                return;
              }
              songs.forEach(function (s, i) {
                var it = document.createElement('div');
                it.className = 'rmp-ne-item';
                it.setAttribute('data-idx', i);
                var num = i + 1 < 10 ? '0' + (i + 1) : (i + 1);
                it.innerHTML = '<span class="rmp-ne-idx">' + num + '</span>'
                  + '<img class="rmp-ne-cover" src="' + (s.pic || '') + '" onerror="this.style.opacity=0"/>'
                  + '<div class="rmp-ne-info"><div class="rmp-ne-name">' + esc(s.name) + '</div><div class="rmp-ne-art">' + esc(s.artist) + '</div></div>'
                  + '<button class="rmp-ne-play" data-idx="' + i + '">+</button>';
                list.appendChild(it);
              });
            }
            if (loading) loading.style.display = 'none';
          }).catch(function (e) {
            if (loading) loading.style.display = 'none';
            if (list) list.innerHTML = '<div class="rmp-error" style="padding:20px;">搜索失败：' + esc(e.message || e) + '</div>';
          });
        };
        if (searchBtn) searchBtn.addEventListener('click', performSearch);
        if (searchInput) searchInput.addEventListener('keydown', function (e) {
          if (e.keyCode === 13) { e.preventDefault(); performSearch(); }
        });
        // 返回按钮
        var backBtn = container.querySelector('.rmp-ne-back');
        if (backBtn) {
          backBtn.addEventListener('click', function () {
            var detail = container.querySelector('.rmp-ne-detail');
            var list = container.querySelector('.rmp-ne-list');
            if (detail) detail.classList.remove('show');
            if (list) list.classList.add('show');
          });
        }
        // 关闭按钮
        var closeBtn = container.querySelector('.rmp-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', function () {
            closePlugin();
          });
        }
        // 热歌榜点击
        var hotWrap = container.querySelector('.rmp-hot');
        if (hotWrap) hotWrap.addEventListener('click', handleHot);
        // 推荐歌单点击
        var recWrap = container.querySelector('.rmp-recommend-list');
        if (recWrap) recWrap.addEventListener('click', handleHot);
        // 网易云歌曲列表点击
        var neList = container.querySelector('.rmp-ne-songs');
        if (neList) neList.addEventListener('click', handleNeList);
        // 清空播放列表
        var plClear = container.querySelector('.rmp-pl-clear');
        if (plClear) plClear.addEventListener('click', function () {
          STATE.playlist = [];
          STATE.playlistMap = {};
          STATE.currentIdx = -1;
          renderPlaylist();
          showToast('列表已清空');
        });
        // 播放列表点击
        var pl = container.querySelector('.rmp-pl-list');
        if (pl) pl.addEventListener('click', function (e) {
          var it = e.target.closest('.rmp-pl-item');
          if (it) {
            var id = it.getAttribute('data-id');
            if (id && STATE.playlistMap[id]) {
              STATE.currentIdx = STATE.playlist.indexOf(id);
              playSong(STATE.playlistMap[id], true);
              switchTab('playing');
              renderPlaying();
            }
          }
        });
        // 播放控制按钮
        var playBtn = container.querySelector('.rmp-play');
        if (playBtn) playBtn.addEventListener('click', togglePlay);
        var prevBtn = container.querySelector('.rmp-prev');
        if (prevBtn) prevBtn.addEventListener('click', playPrev);
        var nextBtn = container.querySelector('.rmp-next');
        if (nextBtn) nextBtn.addEventListener('click', playNext);
        // 进度条
        var prBar = container.querySelector('.rmp-progress-bar');
        if (prBar) {
          prBar.addEventListener('click', function (e) {
            if (!audio.src) return;
            var rect = prBar.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var pct = Math.max(0, Math.min(1, x / rect.width));
            audio.currentTime = pct * audio.duration;
          });
        }
        // 音量控制
        var volWrap = container.querySelector('.rmp-volume-wrap');
        if (volWrap) {
          var volBtn = volWrap.querySelector('.rmp-volume-btn');
          var volPanel = volWrap.querySelector('.rmp-volume-panel');
          var volBar = volWrap.querySelector('.rmp-volume-bar');
          volBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            volPanel.classList.toggle('show');
          });
          document.addEventListener('click', function () { volPanel.classList.remove('show'); });
          volPanel.addEventListener('click', function (e) { e.stopPropagation(); });
          var updateVolBar = function () {
            var fill = volBar.querySelector('.rmp-volume-fill');
            var dot = volBar.querySelector('.rmp-volume-dot');
            if (fill) fill.style.width = Math.round(audio.volume * 100) + '%';
            if (dot) dot.style.left = Math.round(audio.volume * 100) + '%';
            var icon = volBtn.querySelector('.rmp-vol-icon');
            if (icon) icon.textContent = audio.volume === 0 ? '🔇' : (audio.volume < 0.5 ? '🔉' : '🔊');
          };
          volBar.addEventListener('click', function (e) {
            var rect = volBar.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var v = Math.max(0, Math.min(1, x / rect.width));
            audio.volume = v;
            audio.muted = v === 0;
            try { localStorage.setItem('rmp_volume', v); } catch (ee) {}
            updateVolBar();
          });
          updateVolBar();
        }
        // 播放模式
        var modeBtn = container.querySelector('.rmp-mode');
        if (modeBtn) modeBtn.addEventListener('click', function () {
          STATE.mode = (STATE.mode + 1) % 3;
          try { localStorage.setItem('rmp_mode', STATE.mode); } catch (e) {}
          var lbl = ['顺序播放', '随机播放', '单曲循环'];
          var icn = ['🔀', '🔁', '🔂'];
          modeBtn.innerHTML = '<span class="rmp-mode-ico">' + icn[STATE.mode] + '</span><span class="rmp-mode-lbl">' + lbl[STATE.mode] + '</span>';
          showToast(lbl[STATE.mode]);
        });
        // 黑胶唱片点击进入详情
        var discWrap = container.querySelector('.rmp-cover-disc');
        var detailPanel = container.querySelector('[data-panel="playing"]');
        if (discWrap && detailPanel) {
          var _isDisc = false;
          discWrap.addEventListener('click', function (e) {
            if (_isDisc) {
              detailPanel.classList.remove('disc-mode');
              _isDisc = false;
            } else {
              detailPanel.classList.add('disc-mode');
              _isDisc = true;
            }
          });
          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && _isDisc) {
              detailPanel.classList.remove('disc-mode');
              _isDisc = false;
            }
          });
        }
        // 设置面板
        var settingsEl = container.querySelector('.rmp-settings');
        if (settingsEl) {
          var apiInput = settingsEl.querySelector('.rmp-api-input');
          var saveBtn = settingsEl.querySelector('.rmp-api-save');
          var resetBtn = settingsEl.querySelector('.rmp-api-reset');
          var testBtn = settingsEl.querySelector('.rmp-api-test');
          var qualitySel = settingsEl.querySelector('.rmp-quality');
          var ctxSel = settingsEl.querySelector('.rmp-ctx');
          var cookieInput = settingsEl.querySelector('.rmp-cookie-input');
          var cookieSave = settingsEl.querySelector('.rmp-cookie-save');
          if (apiInput) apiInput.value = STATE.neteaseApiBase || '';
          if (qualitySel) qualitySel.value = STATE.quality;
          if (ctxSel) ctxSel.value = String(STATE.contextLen);
          if (cookieInput) cookieInput.value = STATE.neteaseCookie || '';
          if (saveBtn) saveBtn.addEventListener('click', function () {
            var v = (apiInput.value || '').trim().replace(/\/+$/, '');
            STATE.neteaseApiBase = v;
            try { localStorage.setItem('rmp_netease_api', v); } catch (e) {}
            showToast('API地址已保存');
          });
          if (resetBtn) resetBtn.addEventListener('click', function () {
            STATE.neteaseApiBase = '';
            if (apiInput) apiInput.value = '';
            try { localStorage.removeItem('rmp_netease_api'); } catch (e) {}
            showToast('已恢复默认API地址');
          });
          if (testBtn) testBtn.addEventListener('click', function () {
            var b = (apiInput.value || '').trim().replace(/\/+$/, '') || 'https://netease-cloud-music-api.netlify.app';
            testBtn.textContent = '测试中...';
            testBtn.disabled = true;
            ncmApi(b, '/banner', { type: 0 }, 'GET').then(function () {
              testBtn.textContent = '测试连接✓';
              testBtn.disabled = false;
              showToast('连接成功！');
              setTimeout(function () { testBtn.textContent = '测试连接'; }, 2000);
            }).catch(function (e) {
              testBtn.textContent = '测试连接';
              testBtn.disabled = false;
              showToast('连接失败：' + (e.message || e));
            });
          });
          if (qualitySel) qualitySel.addEventListener('change', function () {
            STATE.quality = parseInt(qualitySel.value, 10) || 320000;
            try { localStorage.setItem('rmp_quality', STATE.quality); } catch (e) {}
            showToast('音质设置已保存');
          });
          if (ctxSel) ctxSel.addEventListener('change', function () {
            STATE.contextLen = parseInt(ctxSel.value, 10) || 1;
            if (STATE.contextLen < 0) STATE.contextLen = 0;
            if (STATE.contextLen > 30) STATE.contextLen = 30;
            try { localStorage.setItem('rmp_context_len', STATE.contextLen); } catch (e) {}
            showToast('对话注入长度已设置为：' + STATE.contextLen);
            if (STATE.currentSong && STATE.lyrics.length) {
              updateLyricsUI();
            }
          });
          if (cookieSave) cookieSave.addEventListener('click', function () {
            var v = (cookieInput.value || '').trim();
            STATE.neteaseCookie = v;
            try { localStorage.setItem('rmp_netease_cookie', v); } catch (e) {}
            showToast('Cookie已保存（刷新后生效）');
          });
        }
        loadHot();
        loadRecommend();
        renderPlaylist();
        if (STATE.currentSong) {
          renderPlaying();
        }
      }, 50);
    } catch (e) { console.error('[MusicPlugin] render error', e); }
  }

  function switchTab(tabName) {
    if (!inited) return;
    var container = document.getElementById('roche-music-player-root');
    if (!container) return;
    var tabs = container.querySelectorAll('.rmp-tab');
    tabs.forEach(function (t) {
      t.classList.remove('active');
      if (t.getAttribute('data-tab') === tabName) t.classList.add('active');
    });
    var panels = container.querySelectorAll('.rmp-tab-panel');
    panels.forEach(function (p) { p.classList.remove('active'); });
    var tp = container.querySelector('[data-panel="' + tabName + '"]');
    if (tp) tp.classList.add('active');
  }

  function getAppStyles() {
    return `
    .roche-music-player * { box-sizing: border-box; margin: 0; padding: 0; }
    .roche-music-player {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 420px; max-width: calc(100vw - 20px); max-height: calc(100vh - 100px);
      background: rgba(255,255,255,0.88); backdrop-filter: blur(40px); -webkit-backdrop-filter: blur(40px);
      border-radius: 20px; z-index: 2147483646;
      box-shadow: 0 20px 60px rgba(194,12,12,0.15), 0 0 0 1px rgba(255,255,255,0.6) inset;
      display: flex; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #333;
    }
    .rmp-ne-bg { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-size: cover; background-position: center; opacity: 0.08; filter: blur(30px); z-index: 0; pointer-events: none; }
    .rmp-topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; position: relative; z-index: 1; }
    .rmp-brand { display: flex; align-items: center; gap: 10px; }
    .rmp-brand-mark { width: 28px; height: 28px; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(194,12,12,0.3); }
    .rmp-brand-mark svg { width: 16px; height: 16px; fill: white; }
    .rmp-brand-text { display: flex; flex-direction: column; gap: 1px; }
    .rmp-brand-name { font-size: 15px; font-weight: 700; color: #1a1a1a; letter-spacing: -0.3px; }
    .rmp-brand-ver { font-size: 10px; color: #999; font-weight: 500; }
    .rmp-close-btn { background: rgba(0,0,0,0.04); border: none; color: #888; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 14px; transition: all 0.2s; line-height: 1; }
    .rmp-close-btn:hover { background: rgba(194,12,12,0.1); color: #C20C0C; transform: rotate(90deg); }
    .rmp-tabs { display: flex; gap: 2px; padding: 0 12px; position: relative; z-index: 1; border-bottom: 1px solid rgba(0,0,0,0.04); }
    .rmp-tab { flex: 1; padding: 10px 0; background: none; border: none; font-size: 13px; color: #888; cursor: pointer; position: relative; font-weight: 500; transition: all 0.2s; font-family: inherit; }
    .rmp-tab:hover { color: #C20C0C; }
    .rmp-tab.active { color: #C20C0C; font-weight: 600; }
    .rmp-tab.active::after { content: ''; position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%); width: 20px; height: 3px; background: linear-gradient(90deg, #C20C0C, #E63946); border-radius: 2px; }
    .rmp-tab-panel { flex: 1; overflow-y: auto; padding: 14px; display: none; position: relative; z-index: 1; scrollbar-width: thin; scrollbar-color: rgba(194,12,12,0.2) transparent; }
    .rmp-tab-panel::-webkit-scrollbar { width: 4px; }
    .rmp-tab-panel::-webkit-scrollbar-thumb { background: rgba(194,12,12,0.2); border-radius: 2px; }
    .rmp-tab-panel.active { display: block; }
    .rmp-section { margin-bottom: 18px; }
    .rmp-section-title { font-size: 13px; font-weight: 600; color: #666; margin-bottom: 10px; display: flex; align-items: center; gap: 5px; }
    .rmp-hot, .rmp-recommend-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .rmp-card { background: white; border-radius: 10px; overflow: hidden; cursor: pointer; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
    .rmp-card:hover { transform: translateY(-3px); box-shadow: 0 8px 20px rgba(194,12,12,0.15); }
    .rmp-card-cover { position: relative; width: 100%; aspect-ratio: 1; overflow: hidden; background: linear-gradient(135deg, #f5f5f5, #e8e8e8); }
    .rmp-card-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
    .rmp-card:hover .rmp-card-cover img { transform: scale(1.08); }
    .rmp-card-count { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.5); color: white; font-size: 9px; padding: 2px 6px; border-radius: 8px; backdrop-filter: blur(4px); }
    .rmp-card-name { font-size: 11px; font-weight: 500; padding: 6px 8px 2px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rmp-card-artist { font-size: 10px; color: #999; padding: 0 8px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rmp-loading, .rmp-error { text-align: center; padding: 20px; color: #aaa; font-size: 12px; }
    .rmp-error { color: #E63946; }
    .rmp-search-box { display: flex; gap: 8px; margin-bottom: 10px; }
    .rmp-search-input { flex: 1; padding: 9px 14px; border: 1.5px solid rgba(0,0,0,0.06); border-radius: 20px; font-size: 13px; outline: none; background: rgba(255,255,255,0.8); font-family: inherit; transition: all 0.2s; }
    .rmp-search-input:focus { border-color: #C20C0C; background: white; box-shadow: 0 0 0 3px rgba(194,12,12,0.08); }
    .rmp-search-btn { padding: 9px 18px; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%); color: white; border: none; border-radius: 20px; font-size: 13px; cursor: pointer; font-weight: 500; font-family: inherit; transition: all 0.2s; box-shadow: 0 4px 12px rgba(194,12,12,0.25); }
    .rmp-search-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(194,12,12,0.35); }
    .rmp-ne-list, .rmp-ne-detail { position: relative; }
    .rmp-ne-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .rmp-ne-back { background: rgba(0,0,0,0.04); border: none; color: #666; padding: 6px 12px; border-radius: 16px; cursor: pointer; font-size: 12px; font-family: inherit; transition: all 0.2s; }
    .rmp-ne-back:hover { background: rgba(194,12,12,0.1); color: #C20C0C; }
    .rmp-ne-title { font-size: 15px; font-weight: 600; color: #333; }
    .rmp-ne-detail { display: none; }
    .rmp-ne-detail.show { display: block; }
    .rmp-ne-list { display: none; }
    .rmp-ne-list.show { display: block; }
    .rmp-ne-item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .rmp-ne-item:hover { background: rgba(194,12,12,0.05); }
    .rmp-ne-idx { width: 22px; font-size: 12px; color: #bbb; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }
    .rmp-ne-cover { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: #f0f0f0; }
    .rmp-ne-info { flex: 1; min-width: 0; }
    .rmp-ne-name { font-size: 12px; font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rmp-ne-art { font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .rmp-ne-dur { font-size: 11px; color: #ccc; font-variant-numeric: tabular-nums; }
    .rmp-ne-play { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%); color: white; border: none; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; box-shadow: 0 2px 8px rgba(194,12,12,0.25); flex-shrink: 0; }
    .rmp-ne-play:hover { transform: scale(1.1); box-shadow: 0 4px 12px rgba(194,12,12,0.4); }
    .rmp-cover-area { position: relative; width: 180px; height: 180px; margin: 10px auto 12px; perspective: 800px; }
    .rmp-cover-disc { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at center, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%); box-shadow: 0 12px 40px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.05) inset; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: transform 0.4s cubic-bezier(0.4,0,0.2,1); animation: disc-spin 8s linear infinite; animation-play-state: paused; z-index: 2; }
    .rmp-cover-disc::before { content: ''; position: absolute; inset: 8px; border-radius: 50%; background: repeating-radial-gradient(circle at center, transparent 0, transparent 2px, rgba(255,255,255,0.02) 2px, rgba(255,255,255,0.02) 3px); }
    .rmp-cover-disc::after { content: ''; position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #C20C0C; box-shadow: 0 0 0 4px rgba(194,12,12,0.2), 0 0 0 5px rgba(255,255,255,0.1); z-index: 3; }
    .roche-music-player:not(.disc-mode) .rmp-cover-disc:hover { transform: scale(1.03); }
    .rmp-disc-cover { width: 90px; height: 90px; border-radius: 50%; background-size: cover; background-position: center; z-index: 2; box-shadow: 0 0 0 2px rgba(255,255,255,0.1); }
    @keyframes disc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .rmp-cover-img { display: none; }
    .rmp-song-info { text-align: center; margin-bottom: 10px; }
    .rmp-song-name { font-size: 17px; font-weight: 700; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.5px; }
    .rmp-song-artist { font-size: 12px; color: #888; margin-top: 4px; }
    .rmp-lyrics-wrap { height: 100px; overflow: hidden; position: relative; mask-image: linear-gradient(180deg, transparent 0%, black 20%, black 80%, transparent 100%); -webkit-mask-image: linear-gradient(180deg, transparent 0%, black 20%, black 80%, transparent 100%); }
    .rmp-lyrics-list { transition: transform 0.4s cubic-bezier(0.4,0,0.2,1); padding: 30px 0; }
    .rmp-lyric-item { text-align: center; font-size: 12px; color: #bbb; padding: 4px 0; transition: all 0.3s; line-height: 1.6; }
    .rmp-lyric-item.on { color: #C20C0C; font-weight: 600; font-size: 13px; transform: scale(1.05); }
    .rmp-progress { display: flex; align-items: center; gap: 8px; padding: 8px 0 4px; }
    .rmp-cur-time, .rmp-tot-time { font-size: 10px; color: #aaa; min-width: 32px; font-variant-numeric: tabular-nums; }
    .rmp-tot-time { text-align: right; }
    .rmp-progress-bar { flex: 1; height: 4px; background: rgba(0,0,0,0.06); border-radius: 2px; cursor: pointer; position: relative; }
    .rmp-progress-fill { height: 100%; background: linear-gradient(90deg, #C20C0C, #E63946); border-radius: 2px; width: 0%; transition: width 0.1s linear; }
    .rmp-progress-dot { position: absolute; top: 50%; width: 10px; height: 10px; background: white; border: 2px solid #C20C0C; border-radius: 50%; transform: translate(-50%, -50%); left: 0%; opacity: 0; transition: opacity 0.2s; box-shadow: 0 2px 6px rgba(194,12,12,0.3); }
    .rmp-progress-bar:hover .rmp-progress-dot { opacity: 1; }
    .rmp-controls { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px 0; }
    .rmp-controls button { background: none; border: none; cursor: pointer; color: #555; font-size: 16px; padding: 6px; border-radius: 50%; transition: all 0.2s; display: flex; align-items: center; justify-content: center; font-family: inherit; }
    .rmp-controls button:hover { color: #C20C0C; background: rgba(194,12,12,0.08); }
    .rmp-play { width: 44px !important; height: 44px !important; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%) !important; color: white !important; font-size: 18px !important; box-shadow: 0 6px 20px rgba(194,12,12,0.35) !important; }
    .rmp-play:hover { transform: scale(1.08) !important; box-shadow: 0 8px 24px rgba(194,12,12,0.45) !important; }
    .rmp-play-ico { line-height: 1; }
    .rmp-mode { display: flex; flex-direction: column; align-items: center; gap: 1px; font-size: 10px !important; }
    .rmp-mode-ico { font-size: 14px; }
    .rmp-mode-lbl { font-size: 9px; }
    .rmp-volume-wrap { position: relative; margin-left: 4px; }
    .rmp-volume-btn { font-size: 14px !important; }
    .rmp-volume-panel { position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%); width: 100px; background: white; padding: 16px 12px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); display: none; }
    .rmp-volume-panel.show { display: block; }
    .rmp-volume-bar { height: 4px; background: #f0f0f0; border-radius: 2px; cursor: pointer; position: relative; }
    .rmp-volume-fill { height: 100%; background: linear-gradient(90deg, #C20C0C, #E63946); border-radius: 2px; width: 100%; }
    .rmp-volume-dot { position: absolute; top: 50%; width: 10px; height: 10px; background: white; border: 2px solid #C20C0C; border-radius: 50%; transform: translate(-50%, -50%); left: 100%; box-shadow: 0 2px 6px rgba(194,12,12,0.2); }
    .rmp-pl-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .rmp-pl-title { font-size: 14px; font-weight: 600; color: #333; }
    .rmp-pl-clear { background: rgba(0,0,0,0.04); border: none; color: #999; padding: 5px 12px; border-radius: 14px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.2s; }
    .rmp-pl-clear:hover { background: rgba(230,57,70,0.1); color: #E63946; }
    .rmp-pl-list { max-height: 400px; overflow-y: auto; }
    .rmp-pl-item { display: flex; align-items: center; gap: 8px; padding: 7px 6px; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .rmp-pl-item:hover { background: rgba(194,12,12,0.05); }
    .rmp-pl-item.on { background: rgba(194,12,12,0.08); }
    .rmp-pl-item.on .rmp-pl-name { color: #C20C0C; font-weight: 600; }
    .rmp-pl-idx { width: 20px; font-size: 11px; color: #bbb; text-align: center; font-variant-numeric: tabular-nums; }
    .rmp-pl-cover { width: 32px; height: 32px; border-radius: 5px; object-fit: cover; flex-shrink: 0; background: #f0f0f0; }
    .rmp-pl-info { flex: 1; min-width: 0; }
    .rmp-pl-name { font-size: 12px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .rmp-pl-art { font-size: 10px; color: #999; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rmp-pl-remove { width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.04); border: none; color: #ccc; cursor: pointer; font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.2s; }
    .rmp-pl-remove:hover { background: rgba(230,57,70,0.1); color: #E63946; }
    .rmp-settings { font-size: 13px; }
    .rmp-setting-group { background: white; padding: 14px; border-radius: 12px; margin-bottom: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.03); }
    .rmp-setting-title { font-size: 12px; font-weight: 600; color: #555; margin-bottom: 8px; }
    .rmp-settings input, .rmp-settings select { width: 100%; padding: 9px 12px; border: 1.5px solid rgba(0,0,0,0.06); border-radius: 10px; font-size: 12px; outline: none; font-family: inherit; background: rgba(255,255,255,0.8); transition: all 0.2s; }
    .rmp-settings input:focus, .rmp-settings select:focus { border-color: #C20C0C; box-shadow: 0 0 0 3px rgba(194,12,12,0.08); background: white; }
    .rmp-settings button { padding: 7px 14px; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%); color: white; border: none; border-radius: 14px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 500; transition: all 0.2s; box-shadow: 0 2px 8px rgba(194,12,12,0.2); }
    .rmp-settings button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(194,12,12,0.3); }
    .rmp-settings select { cursor: pointer; }
    .rmp-ne-disclaimer { margin-top: 14px; padding: 14px; background: rgba(230,57,70,0.04); border: 1.5px solid rgba(230,57,70,0.2); border-radius: 12px; }
    .rmp-disclaimer-title { font-size: 12px; font-weight: 600; color: #C20C0C; margin-bottom: 8px; }
    .rmp-disclaimer-body { font-size: 11px; color: #888; line-height: 1.8; }
    /* 黑胶详情模式 */
    .rmp-tab-panel[data-panel="playing"].disc-mode { display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.92); position: relative; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-ne-bg { opacity: 0.2; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-song-name { color: white; font-size: 20px; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-song-artist { color: rgba(255,255,255,0.6); }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-cover-disc { width: 220px; height: 220px; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-disc-cover { width: 110px; height: 110px; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-lyrics-wrap { display: none; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-disc-lyrics-wrap { display: block !important; height: 140px; width: 100%; overflow: hidden; position: relative; mask-image: linear-gradient(180deg, transparent 0%, black 20%, black 80%, transparent 100%); -webkit-mask-image: linear-gradient(180deg, transparent 0%, black 20%, black 80%, transparent 100%); margin: 16px 0; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-disc-lyrics .rmp-lyric-item { color: rgba(255,255,255,0.4); font-size: 13px; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-disc-lyrics .rmp-lyric-item.on { color: white; font-size: 15px; }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-cur-time, .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-tot-time { color: rgba(255,255,255,0.5); }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-progress-bar { background: rgba(255,255,255,0.15); }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-controls button { color: rgba(255,255,255,0.7); }
    .rmp-tab-panel[data-panel="playing"].disc-mode .rmp-controls button:hover { color: white; background: rgba(255,255,255,0.1); }
    .rmp-disc-lyrics-wrap { display: none; }
    @keyframes rmp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    #rmp-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%) translateY(20px); background: rgba(0,0,0,0.8); color: white; padding: 9px 20px; border-radius: 20px; font-size: 12px; z-index: 2147483647; opacity: 0; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); pointer-events: none; backdrop-filter: blur(10px); }
    #rmp-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    `;
  }

  function getIslandStyles() {
    return `
    .rmp-mount-btn { position: fixed; bottom: 20px; right: 20px; width: 44px; height: 44px; background: linear-gradient(135deg, #C20C0C 0%, #E63946 100%); border-radius: 50%; z-index: 2147483645; box-shadow: 0 6px 20px rgba(194,12,12,0.35); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); border: none; color: white; }
    .rmp-mount-btn:hover { transform: scale(1.08); box-shadow: 0 8px 24px rgba(194,12,12,0.45); }
    .rmp-mount-btn svg { width: 22px; height: 22px; fill: currentColor; }
    .rmp-island { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(30,30,30,0.92); backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px); border-radius: 100px; padding: 8px 16px; z-index: 2147483644; display: flex; align-items: center; gap: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06) inset; opacity: 0; pointer-events: none; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); min-width: 200px; max-width: 360px; }
    .rmp-island.has-song { opacity: 1; pointer-events: auto; }
    .rmp-island.open { border-radius: 16px; padding: 0; width: 380px; max-width: calc(100vw - 20px); min-height: 480px; max-height: calc(100vh - 40px); flex-direction: column; bottom: 50%; transform: translateX(-50%) translateY(50%); overflow: hidden; }
    .rmp-island-cover { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .rmp-island.open .rmp-island-cover { display: none; }
    .rmp-island-info { flex: 1; min-width: 0; }
    .rmp-island.open .rmp-island-info { display: none; }
    .rmp-island-title { font-size: 12px; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rmp-island-artist { font-size: 10px; color: rgba(255,255,255,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .rmp-island-play { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.15); border: none; color: white; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; line-height: 1; }
    .rmp-island.open .rmp-island-play { display: none; }
    .rmp-island-play:hover { background: rgba(255,255,255,0.25); }
    .rmp-island-close { width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,0.1); border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 14px; display: none; align-items: center; justify-content: center; flex-shrink: 0; line-height: 1; transition: all 0.2s; padding: 0; }
    .rmp-island.open .rmp-island-close { display: flex; position: absolute; top: 12px; right: 12px; z-index: 10; }
    .rmp-island-close:hover { background: rgba(230,57,70,0.3); color: white; }
    .rmp-island.open-content { display: none; }
    .rmp-island.open .rmp-island.open-content { display: block; }
    @keyframes rmp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
    .rmp-island.audio-playing .rmp-island-cover { animation: rmp-pulse 2s ease-in-out infinite; }
    `;
  }

  function mount() {
    if (document.getElementById('roche-music-mount-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'rmp-mount-btn';
    btn.id = 'roche-music-mount-btn';
    btn.title = '网易云音乐';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
    btn.addEventListener('click', function () {
      if (inited) closePlugin();
      else renderApp();
    });
    document.body.appendChild(btn);
    renderIsland();
  }

  function renderIsland() {
    if (document.querySelector('.rmp-island')) return;
    var island = document.createElement('div');
    island.className = 'rmp-island';
    island.innerHTML = '\
      <img class="rmp-island-cover" src=""/>\
      <div class="rmp-island-info"><div class="rmp-island-title">未播放</div><div class="rmp-island-artist">--</div></div>\
      <button class="rmp-island-play">▶</button>\
      <button class="rmp-island-close">×</button>';
    document.body.appendChild(island);
    var playBtn = island.querySelector('.rmp-island-play');
    var closeBtn = island.querySelector('.rmp-island-close');
    var info = island.querySelector('.rmp-island-info');
    if (playBtn) playBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (STATE.isPlaying) audio.pause();
      else if (STATE.currentSong) {
        if (!audio.src) playSong(STATE.currentSong, false);
        else audio.play().catch(function () {});
      } else {
        if (!inited) renderApp();
        else switchTab('discover');
      }
    });
    if (closeBtn) closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeIsland();
    });
    if (info) info.addEventListener('click', function () {
      if (!inited) renderApp();
      else switchTab('playing');
    });
  }

  function registerTools() {
    try {
      if (window.TraePlugin && typeof window.TraePlugin.registerTool === 'function') {
        window.TraePlugin.registerTool({
          name: 'play_song',
          description: '播放音乐，可以通过歌名或歌手搜索并播放。用户点歌时使用此工具。',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: '歌名或歌手名，例如："晴天 周杰伦"' },
              song_id: { type: 'string', description: '可选，直接指定歌曲ID播放' }
            },
            required: ['keyword']
          },
          execute: async function (args) {
            try {
              var keyword = args.keyword;
              var songs = await doSearch(keyword);
              if (!songs.length) return { success: false, message: '未找到相关歌曲，请尝试更精确的关键词' };
              var song = songs[0];
              playSong(song, true);
              return { success: true, message: '正在播放：' + song.name + ' - ' + song.artist, song: { name: song.name, artist: song.artist } };
            } catch (e) {
              return { success: false, message: '播放失败：' + (e.message || e) };
            }
          }
        });
        window.TraePlugin.registerTool({
          name: 'get_current_song',
          description: '获取当前正在播放的歌曲信息',
          parameters: { type: 'object', properties: {} },
          execute: async function () {
            if (!STATE.currentSong) return { success: false, message: '当前没有播放歌曲' };
            var curLrc = '';
            if (STATE.lyrics.length) {
              var curIdx = 0;
              for (var i = 0; i < STATE.lyrics.length; i++) {
                if (STATE.lyrics[i].time <= audio.currentTime) curIdx = i;
                else break;
              }
              for (var j = Math.max(0, curIdx - 2); j <= Math.min(STATE.lyrics.length - 1, curIdx + 2); j++) {
                curLrc += (j === curIdx ? '▶' : '  ') + STATE.lyrics[j].text + '\n';
              }
            }
            return {
              success: true,
              song: { name: STATE.currentSong.name, artist: STATE.currentSong.artist },
              isPlaying: STATE.isPlaying,
              currentTime: fmtTime(audio.currentTime),
              duration: fmtTime(audio.duration),
              lyrics: curLrc.trim()
            };
          }
        });
        window.TraePlugin.registerTool({
          name: 'control_playback',
          description: '控制音乐播放：暂停/继续/上一首/下一首',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['play', 'pause', 'prev', 'next'], description: '操作类型' }
            },
            required: ['action']
          },
          execute: async function (args) {
            switch (args.action) {
              case 'play':
                if (STATE.currentSong) {
                  if (!audio.src) playSong(STATE.currentSong, false);
                  else audio.play().catch(function () {});
                }
                return { success: true };
              case 'pause':
                audio.pause();
                return { success: true };
              case 'prev':
                playPrev();
                return { success: true };
              case 'next':
                playNext();
                return { success: true };
              default:
                return { success: false, message: '未知操作' };
            }
          }
        });
        console.log('[MusicPlugin] Tools registered');
      }
    } catch (e) { console.warn('[MusicPlugin] registerTools error', e); }
  }

  setTimeout(function () {
    mount();
    registerTools();
    // 自动旋转黑胶唱片
    setInterval(function () {
      var disc = document.querySelector('.rmp-cover-disc');
      if (disc) {
        if (STATE.isPlaying) disc.style.animationPlayState = 'running';
        else disc.style.animationPlayState = 'paused';
      }
      // 同步灵动岛播放状态
      var island = document.querySelector('.rmp-island');
      if (island) {
        if (STATE.isPlaying) island.classList.add('audio-playing');
        else island.classList.remove('audio-playing');
        var cover = island.querySelector('.rmp-island-cover');
        if (cover && STATE.currentSong && STATE.currentSong.pic) cover.src = STATE.currentSong.pic;
      }
    }, 300);
  }, 1000);
})();