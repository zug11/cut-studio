/* CUT Studio's production webview UI. The browser QA harness supplies the same message bridge. */
(() => {
  'use strict';
  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : {
          postMessage: (message) => window.dispatchEvent(new CustomEvent('cut-message', { detail: message })),
          getState: () => undefined,
          setState: () => undefined
        };
  const role = document.body.dataset.role || 'monitor';
  const root = document.getElementById('studio');
  let revision = 0;
  let model;
  let state = { kind: 'empty', message: 'Open a .cut file to begin.' };
  let position = 0;
  let segment;
  let scale = Number(vscode.getState()?.scale) || 64;
  let selected;
  let lastClipClick;
  let playing = false;
  let pointerDown = false;
  let lastTick = 0;
  let previewGeneration = 0;
  let activePreviewId;
  let previewFetch;
  let blobUrl;
  const post = (type, data = {}) =>
    vscode.postMessage({ type, revision, previewId: activePreviewId, ...data });
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className, action, title) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.title = title || label;
    node.setAttribute('aria-label', title || label);
    node.addEventListener('click', action);
    return node;
  };
  const fps = () => (model ? model.fps.num / model.fps.den : 24);
  const timecode = (seconds) => {
    const frame = Math.max(0, Math.round(seconds * fps()));
    const nominal = Math.round(fps());
    const f = frame % nominal;
    const total = Math.floor(frame / nominal);
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60, f]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  };
  const decimalTime = (seconds) => `${Math.max(0, seconds).toFixed(3)}s`;
  let heading,
    badge,
    title,
    subtitle,
    statusMessage,
    progress,
    video,
    placeholder,
    currentTime,
    totalTime,
    seek,
    play,
    details,
    previewButton,
    exportButton;
  let trackRoot, lanes, ruler, playhead, timelineViewport, timelineSummary;

  function buildMonitor() {
    const header = el('header', 'monitor-header');
    const brand = el('div', 'brand');
    brand.append(el('span', 'brand-mark', '/'), el('span', '', 'CUT'), el('span', 'brand-label', 'STUDIO'));
    badge = el('span', 'status-badge empty', 'NO FILM');
    header.append(brand, badge);
    const filmHeader = el('section', 'film-heading');
    const eyebrow = el('div', 'eyebrow', 'VIDEO MONITOR');
    title = el('h1', '', 'Your film, in focus.');
    subtitle = el('p', 'film-subtitle', 'Open a .cut file in the editor.');
    filmHeader.append(eyebrow, title, subtitle);
    const stage = el('section', 'monitor-stage');
    stage.setAttribute('aria-label', 'Video preview');
    video = el('video', 'preview-video');
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-label', 'Rendered film preview');
    placeholder = el('div', 'stage-placeholder');
    placeholder.append(
      el('span', 'placeholder-icon', '⌁'),
      el('span', 'placeholder-title', 'The code is the movie.'),
      el('span', 'placeholder-hint', 'Write a film. See it here.')
    );
    const safeArea = el('div', 'safe-area');
    safeArea.setAttribute('aria-hidden', 'true');
    const stageState = el('div', 'stage-status');
    statusMessage = el('span', '', state.message);
    progress = el('div', 'render-progress');
    progress.append(el('div', 'render-progress-fill'));
    stageState.append(statusMessage, progress);
    stage.append(video, placeholder, safeArea, stageState);
    const controls = el('section', 'playback');
    const timeRow = el('div', 'time-row');
    currentTime = el('span', 'timecode', '00:00:00:00');
    totalTime = el('span', 'duration', '/ 00:00:00:00');
    const frameTag = el('span', 'frame-tag', 'FRAME ACCURATE');
    timeRow.append(currentTime, totalTime, frameTag);
    seek = el('input', 'seek');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1';
    seek.step = '0.001';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Film playhead position');
    seek.addEventListener('input', () => {
      position = Number(seek.value);
      updatePosition();
    });
    seek.addEventListener('change', () => requestSeek(Number(seek.value)));
    const controlRow = el('div', 'control-row');
    const transport = el('div', 'transport');
    transport.append(
      button('↤', 'icon-button', () => requestSeek(0), 'Go to beginning (Home)'),
      button('‹', 'icon-button', () => step(-1), 'Previous frame (Left arrow)')
    );
    play = button('▶', 'play-button', togglePlayback, 'Play / pause (Space)');
    transport.append(
      play,
      button('›', 'icon-button', () => step(1), 'Next frame (Right arrow)')
    );
    previewButton = button(
      'Refresh preview',
      'text-button',
      () => post('render'),
      'Render the current preview segment'
    );
    controlRow.append(transport, previewButton);
    controls.append(timeRow, seek, controlRow);
    const inspector = el('section', 'inspector');
    const inspectorHeader = el('div', 'section-heading');
    inspectorHeader.append(el('span', '', 'AT THE PLAYHEAD'), el('span', 'tiny-label', 'SOURCE → OUTPUT'));
    details = el('div', 'active-clips');
    inspector.append(inspectorHeader, details);
    const footer = el('footer', 'monitor-footer');
    const local = el('span', 'local-indicator', '●  Local processing');
    exportButton = button(
      document.body.dataset.host === 'studio' ? 'Export…' : 'Export MP4 ↗',
      'export-button',
      () => post('export')
    );
    footer.append(local, exportButton);
    root.append(header, filmHeader, stage, controls, inspector, footer);
    video.addEventListener('timeupdate', () => {
      if (!segment || state.kind !== 'ready') return;
      if (segment.ended && video.paused) return;
      position = Math.min(segment.to, segment.from + video.currentTime - segment.sourceIn);
      updatePosition();
      if (checkDirectEnd()) return;
      const now = performance.now();
      if (now - lastTick > 70) {
        post('tick', { position });
        lastTick = now;
      }
    });
    video.addEventListener('play', () => {
      playing = true;
      updatePlay();
      requestAnimationFrame(guardDirectPlayback);
    });
    video.addEventListener('pause', () => {
      playing = false;
      updatePlay();
    });
    video.addEventListener('ended', () => {
      playing = false;
      updatePlay();
      post('next');
    });
    video.addEventListener('error', () => {
      const error = video.error;
      if (!error || segment?.loadingResource) return;
      if (segment?.direct) {
        segment = undefined;
        post('proxyFallback');
      } else if (segment)
        post('playbackError', {
          message: `Media error ${error.code}${error.message ? ': ' + error.message : ''} [transport ${video.currentSrc.startsWith('blob:') ? 'blob' : 'resource'}; ${segment.debug || 'header unavailable'}]`
        });
    });
  }

  function checkDirectEnd() {
    if (!segment?.direct || segment.ended || state.kind !== 'ready') return false;
    if (video.currentTime < segment.sourceIn + segment.to - segment.from) return false;
    segment.ended = true;
    video.pause();
    position = segment.to;
    video.currentTime = Math.max(segment.sourceIn, segment.sourceIn + segment.to - segment.from - 1 / fps());
    updatePosition();
    post('next');
    return true;
  }
  function guardDirectPlayback() {
    if (!video || video.paused) return;
    if (!checkDirectEnd()) requestAnimationFrame(guardDirectPlayback);
  }

  function releasePreviewResource(clearVideo = false) {
    previewFetch?.abort();
    previewFetch = undefined;
    if (video) {
      video.pause();
      video.onloadedmetadata = null;
      video.oncanplay = null;
      if (clearVideo) {
        video.removeAttribute('src');
        video.load();
      }
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
  }

  async function loadPreview(data) {
    const generation = ++previewGeneration;
    releasePreviewResource(true);
    activePreviewId = data.previewId;
    segment = {
      from: data.from,
      to: data.to,
      sourceIn: data.sourceIn || 0,
      direct: !!data.direct,
      loadingResource: !data.direct
    };
    const requested = Math.max(0, segment.sourceIn + data.position - data.from);
    const current = () => generation === previewGeneration && data.revision === revision && !!segment;
    video.muted = !!data.direct;
    try {
      let playbackSrc = data.src;
      if (!data.direct) {
        // VS Code's resource service worker can fail Chromium's streaming range demuxer.
        // Short, bounded proxies are fetched whole and decoded from a local Blob instead.
        const controller = new AbortController();
        previewFetch = controller;
        const response = await fetch(data.src, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`Local proxy request returned HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!current() || controller.signal.aborted) return;
        if (buffer.byteLength === 0) throw new Error('The local proxy was empty');
        const contentRange = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(response.headers.get('Content-Range') || '');
        if (contentRange && (Number(contentRange[1]) !== 0 || Number(contentRange[3]) !== buffer.byteLength))
          throw new Error('The local proxy resource returned an incomplete file');
        if (buffer.byteLength > 64 * 1024 * 1024)
          throw new Error(
            'Preview segment exceeds 64 MB. Reduce CUT previewSegmentSeconds and render it again'
          );
        segment.debug = `${buffer.byteLength} bytes; header ${[...new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        const mimeType = data.mimeType || (/\.mp4(?:[?#]|$)/i.test(data.src) ? 'video/mp4' : 'video/webm');
        blobUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
        playbackSrc = blobUrl;
        segment.loadingResource = false;
      }
      if (!current()) return;
      const ready = () => {
        if (!current() || video.getAttribute('src') !== playbackSrc) return;
        video.oncanplay = null;
        position = data.position;
        placeholder.hidden = true;
        state = {
          kind: 'ready',
          message: data.direct
            ? 'Preview current · direct source · video track muted'
            : 'Preview current · decoded locally'
        };
        drawState();
        post('playbackReady');
        if (data.autoplay) void video.play().catch(() => {});
      };
      video.onloadedmetadata = () => {
        if (current()) video.currentTime = requested;
      };
      video.oncanplay = ready;
      video.src = playbackSrc;
      video.load();
    } catch (error) {
      if (!current() || previewFetch?.signal.aborted) return;
      post('playbackError', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  function buildTimeline() {
    const header = el('header', 'timeline-header');
    const label = el('div', 'timeline-title');
    label.append(el('span', 'timeline-symbol', '/'), el('strong', '', 'TIMELINE'));
    timelineSummary = el('span', 'timeline-summary', 'Open a .cut file');
    badge = el('span', 'status-badge empty', 'NO FILM');
    const tools = el('div', 'timeline-tools');
    tools.append(
      button('▶', 'icon-button', () => post('toggle'), 'Play / pause preview'),
      button('−', 'icon-button', () => setScale(scale / 1.4), 'Zoom out'),
      button('+', 'icon-button', () => setScale(scale * 1.4), 'Zoom in'),
      button('Fit', 'fit-button', fit, 'Fit timeline to panel')
    );
    header.append(label, timelineSummary, badge, tools);
    timelineViewport = el('div', 'timeline-viewport');
    timelineViewport.tabIndex = 0;
    timelineViewport.setAttribute(
      'aria-label',
      'Film timeline. Click a clip to open its source, or click the ruler to seek.'
    );
    trackRoot = el('div', 'timeline-content');
    const rulerRow = el('div', 'ruler-row');
    const sourceLabel = el('div', 'ruler-label', 'TRACK / SOURCE');
    ruler = el('div', 'ruler');
    rulerRow.append(sourceLabel, ruler);
    lanes = el('div', 'track-rows');
    playhead = el('div', 'playhead');
    playhead.append(el('span', 'playhead-cap'));
    trackRoot.append(rulerRow, lanes, playhead);
    timelineViewport.append(trackRoot);
    const footer = el('footer', 'timeline-footer');
    statusMessage = el('span', '', state.message);
    const hint = el('span', 'timeline-hint', 'Click clip → source  ·  Click ruler → seek  ·  Space → play');
    footer.append(statusMessage, hint);
    root.append(header, timelineViewport, footer);
    timelineViewport.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        event.target.closest('.timeline-clip') ||
        !event.target.closest('.lane, .ruler')
      )
        return;
      pointerDown = true;
      timelineViewport.setPointerCapture(event.pointerId);
      seekFromPointer(event);
    });
    timelineViewport.addEventListener('pointermove', (event) => {
      if (pointerDown) {
        const rect = ruler.getBoundingClientRect();
        position = Math.max(0, Math.min(model?.duration || 0, (event.clientX - rect.left) / scale));
        updatePosition();
      }
    });
    timelineViewport.addEventListener('pointerup', (event) => {
      if (pointerDown) {
        pointerDown = false;
        seekFromPointer(event);
        timelineViewport.releasePointerCapture(event.pointerId);
      }
    });
    timelineViewport.addEventListener('pointercancel', () => {
      pointerDown = false;
    });
  }
  function seekFromPointer(event) {
    const rect = ruler.getBoundingClientRect();
    requestSeek((event.clientX - rect.left) / scale);
  }
  function setScale(next) {
    scale = Math.max(3, Math.min(1200, next));
    vscode.setState({ scale });
    drawTimeline();
  }
  function fit() {
    if (model?.duration) setScale((timelineViewport.clientWidth - 176) / model.duration);
  }
  function step(direction) {
    requestSeek(position + direction / fps());
  }
  function requestSeek(seconds, autoplay = false) {
    if (!model) return;
    position = Math.max(0, Math.min(model.duration, Math.round(seconds * fps()) / fps()));
    updatePosition();
    if (
      role === 'monitor' &&
      segment &&
      position >= segment.from &&
      position < segment.to &&
      state.kind === 'ready'
    ) {
      video.currentTime = segment.sourceIn + position - segment.from;
      if (autoplay) void video.play().catch(() => {});
    }
    post('seek', { position, autoplay });
  }
  function togglePlayback() {
    if (!video) {
      post('toggle');
      return;
    }
    if (state.kind !== 'ready' || !segment) {
      post('render');
      return;
    }
    if (!video.paused) video.pause();
    else if (position >= (model?.duration || 0) - 0.5 / fps()) requestSeek(0, true);
    else
      void video.play().catch(() => {
        statusMessage.textContent = 'Press play to start playback.';
      });
  }
  function updatePlay() {
    if (play) {
      play.textContent = playing ? 'Ⅱ' : '▶';
      play.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    }
  }
  function updatePosition() {
    if (currentTime) currentTime.textContent = timecode(position);
    if (seek && !pointerDown) seek.value = String(position);
    if (playhead) playhead.style.left = `${144 + position * scale}px`;
    if (details) drawDetails();
  }
  function drawDetails() {
    details.replaceChildren();
    if (!model) {
      details.append(el('p', 'quiet', 'Your active source clips will appear here.'));
      return;
    }
    const active = model.tracks.flatMap((track) =>
      track.clips
        .filter(
          (clip) => position >= clip.at && (clip.duration == null || position < clip.at + clip.duration)
        )
        .map((clip) => ({ track, clip }))
    );
    if (!active.length) {
      details.append(el('div', 'empty-frame', 'Black frame · no active clips'));
      return;
    }
    for (const { track, clip } of active) {
      const row = el('div', `active-clip ${track.kind}`);
      const dot = el('span', 'track-dot');
      const names = el('div', 'active-clip-names');
      const label = `${track.kind === 'video' ? 'V' : 'A'}${clip.layer ?? track.layer ?? model.tracks.filter((item) => item.kind === track.kind).indexOf(track) + 1}`;
      names.append(
        el('span', 'active-clip-name', clip.label),
        el('span', 'active-track-name', `${label} · ${track.name}`)
      );
      const value = el(
        'span',
        'clip-value',
        track.kind === 'audio'
          ? `${clip.gain > 0 ? '+' : ''}${clip.gain} dB`
          : `${Math.round(clip.opacity * 100)}%`
      );
      row.append(dot, names, value);
      row.title = `${clip.path} · layer ${label} · line ${clip.line}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Go to ${clip.label}, line ${clip.line}`);
      row.addEventListener('click', () => post('select', { id: clip.id }));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') post('select', { id: clip.id });
      });
      details.append(row);
    }
  }
  function drawTimeline() {
    if (!trackRoot) return;
    lanes.replaceChildren();
    ruler.replaceChildren();
    if (!model) {
      lanes.append(
        el('div', 'timeline-empty', 'The timeline is a view of your code. Open a .cut film to begin.')
      );
      return;
    }
    const width = Math.max((timelineViewport?.clientWidth || 800) - 144, model.duration * scale + 32);
    trackRoot.style.width = `${width + 144}px`;
    ruler.style.width = `${width}px`;
    const stepSeconds =
      [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((step) => step * scale >= 72) || 3600;
    for (let time = 0; time <= width / scale; time += stepSeconds) {
      const tick = el(
        'span',
        'ruler-tick',
        time >= 60
          ? `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`
          : `${Number(time.toFixed(2))}s`
      );
      tick.style.left = `${time * scale}px`;
      ruler.append(tick);
    }
    const numbered = (kind) =>
      model.tracks.filter((track) => track.kind === kind).sort((a, b) => (a.layer || 0) - (b.layer || 0));
    const ordered = [...numbered('video').reverse(), ...numbered('audio')];
    let videoIndex = 0,
      audioIndex = 0;
    for (const track of ordered) {
      const index =
        track.layer == null ? (track.kind === 'video' ? videoIndex++ : audioIndex++) : track.layer - 1;
      const row = el('div', `track-row ${track.kind} color-${index % 4}`);
      const trackLabel = el('div', 'track-label');
      const type = el(
        'span',
        'track-type',
        `${track.kind === 'video' ? 'V' : 'A'}${track.layer ?? model.tracks.filter((item) => item.kind === track.kind).indexOf(track) + 1}`
      );
      const name = el('span', 'track-name', track.name);
      trackLabel.append(type, name);
      const lane = el('div', 'lane');
      lane.style.width = `${width}px`;
      lane.style.setProperty('--grid', `${stepSeconds * scale}px`);
      for (const clip of track.clips) {
        const duration = clip.duration == null ? 1 : clip.duration;
        const block = el(
          'button',
          'timeline-clip' +
            (clip.duration == null ? ' unresolved' : '') +
            (selected === clip.id ? ' selected' : '')
        );
        block.type = 'button';
        block.style.left = `${clip.at * scale}px`;
        block.style.width = `${Math.max(3, duration * scale)}px`;
        const clipName = el('span', 'timeline-clip-name', clip.label);
        const meta = el(
          'span',
          'timeline-clip-meta',
          track.kind === 'audio'
            ? `${clip.gain} dB · ${clip.duration == null ? 'checking duration' : decimalTime(duration)}`
            : `${decimalTime(clip.in)} → ${clip.out == null ? 'media end' : decimalTime(clip.out)}`
        );
        block.append(clipName, meta);
        if (document.body.dataset.host === 'studio') {
          block.addEventListener('contextmenu', event => { event.preventDefault(); post('editClip', {id:clip.id}); });
          block.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); post('editClip', {id:clip.id}); } });
        }
        block.title = `${clip.path}\nLayer ${track.kind === 'video' ? 'V' : 'A'}${clip.layer ?? track.layer ?? index + 1} · At ${decimalTime(clip.at)} · ${clip.duration == null ? 'Duration will be resolved from source' : `Duration ${decimalTime(duration)}`}\nClick to open line ${clip.line}${document.body.dataset.host==='studio' ? ' · Double-click to edit' : ''}`;
        block.setAttribute(
          'aria-label',
          `${track.name}: ${clip.label} at ${decimalTime(clip.at)}, source line ${clip.line}`
        );
        block.addEventListener('click', (event) => {
          event.stopPropagation();
          const now=performance.now();
          const edit=document.body.dataset.host === 'studio' && lastClipClick?.id === clip.id && now-lastClipClick.time<550;
          selected = clip.id;
          lastClipClick = edit ? undefined : {id:clip.id,time:now};
          post(edit ? 'editClip' : 'select', { id: clip.id });
          if (!edit) {
            for (const b of lanes.querySelectorAll('.timeline-clip.selected')) b.classList.remove('selected');
            block.classList.add('selected');
          }
        });
        lane.append(block);
      }
      row.append(trackLabel, lane);
      lanes.append(row);
    }
    updatePosition();
  }
  function drawState() {
    const kindLabel = {
      empty: 'NO FILM',
      stale: 'OUT OF DATE',
      checking: 'CHECKING',
      rendering: 'RENDERING',
      ready: 'CURRENT',
      error: 'NEEDS ATTENTION',
      untrusted: 'WORKSPACE TRUST'
    };
    badge.textContent = kindLabel[state.kind] || state.kind.toUpperCase();
    badge.className = `status-badge ${state.kind}`;
    statusMessage.textContent = state.message;
    document.body.dataset.state = state.kind;
    if (state.kind !== 'ready' && video && !video.paused) video.pause();
    if (title) {
      title.textContent = model?.name || 'Your film, in focus.';
      subtitle.textContent = model
        ? `${model.fileName}  ·  ${model.resolution.width} × ${model.resolution.height}  ·  ${model.fps.num === 24000 && model.fps.den === 1001 ? '23.976' : Number(fps().toFixed(3))} fps`
        : 'Open a .cut file in the editor.';
      totalTime.textContent = `/ ${timecode(model?.duration || 0)}`;
      seek.max = String(model?.duration || 1);
      seek.disabled = !model;
      play.disabled = !model || state.kind === 'error' || state.kind === 'untrusted';
      exportButton.disabled = !model || !model.resolved || state.kind === 'untrusted';
      previewButton.disabled =
        !model ||
        (state.kind === 'error' && !model.resolved) ||
        ['untrusted', 'checking', 'rendering'].includes(state.kind);
      placeholder.hidden = !!video.getAttribute('src');
      progress.hidden = state.kind !== 'rendering';
      progress.firstElementChild.style.width = `${Math.max(0, Math.min(1, state.progress || 0)) * 100}%`;
      updatePosition();
    }
    if (timelineSummary) {
      timelineSummary.textContent = model
        ? `${model.name} · ${model.tracks.length} tracks · ${decimalTime(model.duration)}`
        : 'Open a .cut file';
      drawTimeline();
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'state') {
      if (data.revision < revision) return;
      if (data.revision !== revision) {
        previewGeneration++;
        segment = undefined;
        playing = false;
        releasePreviewResource(true);
      }
      revision = data.revision;
      model = data.model;
      state = data.state;
      position = data.position || 0;
      drawState();
    } else if (data.type === 'preview' && data.revision === revision && video) {
      void loadPreview(data);
    } else if (data.type === 'seek' && data.revision === revision && video && segment) {
      position = data.position;
      segment.ended = false;
      video.currentTime = Math.max(0, segment.sourceIn + position - segment.from);
      if (data.autoplay) void video.play().catch(() => {});
      updatePosition();
    } else if (data.type === 'position') {
      position = data.position;
      updatePosition();
    } else if (data.type === 'toggle') togglePlayback();
  });
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      step(1);
    } else if (event.code === 'Home') {
      event.preventDefault();
      requestSeek(0);
    }
  });
  if (role === 'timeline') buildTimeline();
  else buildMonitor();
  window.addEventListener('resize', () => {
    if (role === 'timeline') drawTimeline();
  });
  window.addEventListener('pagehide', () => {
    previewGeneration++;
    releasePreviewResource(true);
  });
  drawState();
  post('ready', { role, build: 'mp4-mp3-20261106-3' });
})();
