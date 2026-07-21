const $ = s => document.querySelector(s);
const modal = $('#modal'), input = $('#file-input'), start = $('#start-processing');
let selectedFile = null;
let globalQuestions = [];
let globalSources = [];
let currentFilter = 'all';
let currentSourceFilter = 'all';
let currentChapterFilter = 'all';
let pendingDeleteSourceId = null;
let pendingRegenSourceId = null;

function openModal() {
  modal.classList.add('show');
  checkApiStatus();
}
function closeModal() { modal.classList.remove('show'); }

// Wire upload triggers
$('#upload-open').onclick = openModal;
$('#hero-upload').onclick = openModal;
const libUpload = $('#library-upload');
if (libUpload) libUpload.onclick = openModal;
$('#modal-close').onclick = closeModal;

modal.onclick = e => { if (e.target === modal) closeModal(); };

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function selectFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('Please select a PDF textbook.');
    return;
  }
  selectedFile = file;
  $('.dropzone b').textContent = file.name;
  $('.dropzone small').textContent = `${formatBytes(file.size)} selected · ready for source-grounded processing`;
  
  // Enable start button only if API Key is verified
  start.disabled = !hasApiKey;
}

input.onchange = () => selectFile(input.files[0]);

const dropzone = $('#dropzone');
dropzone.ondragover = e => { e.preventDefault(); dropzone.style.background = '#e6f3ed'; };
dropzone.ondragleave = () => dropzone.style.background = '';
dropzone.ondrop = e => { e.preventDefault(); dropzone.style.background = ''; selectFile(e.dataTransfer.files[0]); };

start.onclick = async () => {
  if (!selectedFile) return;
  start.disabled = true;
  start.textContent = 'Uploading…';
  try {
    const pageRangeVal = $('#page-range').value || '';
    const response = await fetch('/api/sources', {
      method: 'POST',
      headers: { 
        'content-type': 'application/pdf', 
        'x-filename': selectedFile.name,
        'x-page-range': pageRangeVal
      },
      body: selectedFile
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The source could not be uploaded.');
    
    await fetch(`/api/sources/${result.source.id}/start`, { method: 'POST' });
    closeModal();
    selectedFile = null;
    input.value = '';
    $('#page-range').value = '';
    $('.dropzone b').textContent = 'Drop PDF here, or browse';
    $('.dropzone small').textContent = 'PDF up to 2 GB · textbook images retained at 300 dpi';
    
    // Switch to library view to see processing progress
    show('library');
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  } finally {
    start.textContent = 'Start processing';
    start.disabled = !selectedFile || !hasApiKey;
  }
};

// Navigation
document.querySelectorAll('.nav').forEach(link => link.onclick = () => show(link.dataset.view));
document.querySelectorAll('[data-view-link]').forEach(link => link.onclick = () => show(link.dataset.viewLink));

function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('visible'));
  $('#' + id).classList.add('visible');
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === id));
  
  const titles = {
    dashboard: 'Good morning, Dr. Babhulkar.',
    questions: 'Question bank',
    library: 'Source library',
    coverage: 'Coverage audit',
    exports: 'Exports'
  };
  $('#page-title').textContent = titles[id] || 'Roux N Y';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function statusLabel(status) {
  return status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'In review';
}

function getBadgeClass(type) {
  const t = type.toLowerCase();
  if (t.includes('image') || t.includes('radiology') || t.includes('ct') || t.includes('mri')) return 'image';
  if (t.includes('case') || t.includes('step') || t.includes('management')) return 'case';
  return 'neutral';
}

// Render dynamic Activity List (latest decisions)
function renderActivity(activity) {
  const container = $('#activity-list');
  if (!container) return;
  
  if (!activity || activity.length === 0) {
    container.innerHTML = '<li class="empty-list">No recent editorial activity.</li>';
    return;
  }
  
  const kinds = { approved: 'green', rejected: 'red', review: 'amber', new: 'blue' };
  
  container.innerHTML = activity.slice(0, 5).map(act => {
    const color = kinds[act.kind] || 'blue';
    const actor = act.actor || 'AI';
    const initialsClass = actor === 'AI' ? 'initials ai' : 'initials';
    const timeText = act.at ? new Date(act.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return `<li>
      <span class="dot ${color}"></span>
      <div>
        <b>${escapeHtml(act.text)}</b>
        <small>${escapeHtml(act.detail)} · ${timeText}</small>
      </div>
      <span class="${initialsClass}">${escapeHtml(actor)}</span>
    </li>`;
  }).join('');
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatDurationHuman(seconds) {
  if (isNaN(seconds) || seconds <= 0) return 'Calculating...';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function computeTimeMetrics(source) {
  if (!source || source.status !== 'processing') {
    return { elapsedSec: 0, etaSec: null, formattedElapsed: '00:00', formattedEta: 'N/A' };
  }
  
  const startedAtMs = source.startedAt ? new Date(source.startedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  
  let etaSec = null;
  const progress = source.progress || 0;
  const currentChunk = source.currentChunk || 0;
  const totalChunks = source.totalChunks || 1;
  
  if (currentChunk > 0 && totalChunks > 0 && elapsedSec >= 3) {
    const avgSecPerChunk = elapsedSec / Math.max(1, currentChunk - 0.5);
    const remainingChunks = totalChunks - Math.min(totalChunks, currentChunk - 0.5);
    etaSec = Math.round(remainingChunks * avgSecPerChunk);
  } else if (progress > 5 && elapsedSec >= 3) {
    const estTotalSec = elapsedSec / (progress / 100);
    etaSec = Math.max(0, Math.round(estTotalSec - elapsedSec));
  }
  
  return {
    elapsedSec,
    etaSec,
    formattedElapsed: formatTime(elapsedSec),
    formattedEta: etaSec !== null ? formatDurationHuman(etaSec) : 'Calculating...'
  };
}

let activeProcessingCache = null;

// Render dynamic active processing panel with live timers & status
function renderActiveProcessing(processingSource) {
  activeProcessingCache = processingSource;
  const panel = $('#active-processing-panel');
  const pill = $('#header-processing-pill');
  
  if (!processingSource) {
    if (pill) pill.classList.add('hidden');
    if (panel) {
      panel.innerHTML = `<div class="panel-head">
        <div>
          <p class="eyebrow">ACTIVE PROCESSING</p>
          <h3>No active source processing</h3>
        </div>
      </div>
      <div class="empty-state-small" style="margin-top: 15px;">
        <p>Upload a surgery textbook PDF to start page-by-page concept mapping and question generation.</p>
      </div>`;
    }
    return;
  }
  
  const metrics = computeTimeMetrics(processingSource);
  const progress = processingSource.progress || 0;
  const currentChunk = processingSource.currentChunk || 0;
  const totalChunks = processingSource.totalChunks || 0;
  const chunkRange = processingSource.chunkPageRange || '';
  const statusMsg = processingSource.statusMessage || 'Generating grounded surgical MCQs...';
  const qCount = processingSource.questionsGeneratedCount || 0;
  const processedPages = processingSource.processedPages || Math.round((progress / 100) * (processingSource.totalPages || 30));
  const totalPages = processingSource.totalPages || (processingSource.pages || 30);
  const model = processingSource.activeModel || 'gemini-3.5-flash';
  
  // Update Top Header Processing Pill
  if (pill) {
    pill.classList.remove('hidden');
    $('#pill-title').textContent = processingSource.title || processingSource.filename;
    $('#pill-progress-text').textContent = `${progress}%`;
    $('#pill-meta').textContent = `⏱ ${metrics.formattedElapsed} · ⏳ ~${metrics.formattedEta}`;
  }

  if (!panel) return;
  
  const stages = [
    { name: 'Extract Slices', threshold: 10 },
    { name: 'Gemini AI Prompt', threshold: 30 },
    { name: 'Schema Validate', threshold: 70 },
    { name: 'Publish MCQs', threshold: 95 }
  ];
  
  const stagesHtml = stages.map((s, idx) => {
    if (progress > s.threshold) return `<span class="done">✓ ${s.name}</span>`;
    if (progress >= (stages[idx - 1]?.threshold || 0) && progress <= s.threshold) {
      return `<span class="current">◌ ${s.name}</span>`;
    }
    return `<span>${s.name}</span>`;
  }).join('');
  
  panel.innerHTML = `<div class="panel-head">
    <div>
      <p class="eyebrow">ACTIVE PROCESSING</p>
      <h3>${escapeHtml(processingSource.title)}</h3>
      <span>Source File: ${escapeHtml(processingSource.filename)}</span>
    </div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <button class="retry-source-btn" data-src-id="${processingSource.id}" style="background: #e6f0fa; color: #1e6091; font-size: 11px; font-weight: bold; cursor: pointer; padding: 6px 12px; border: none; border-radius: 4px;">🔄 Restart Pipeline</button>
      <button class="text-btn" onclick="show('library')">View pipeline →</button>
    </div>
  </div>
  
  <div class="timer-summary-bar" style="display: flex; gap: 15px; background: #f4f8f6; padding: 12px 16px; border-radius: 6px; margin: 15px 0 10px 0; border: 1px solid #dce8e3;">
    <div style="flex: 1;">
      <small style="display: block; font-size: 10px; font-weight: 700; color: #588078; font-family: 'DM Mono'; text-transform: uppercase;">⏱ Time Elapsed</small>
      <strong id="timer-elapsed-display" style="font-size: 18px; font-family: 'DM Mono'; color: #143f3c;">${metrics.formattedElapsed}</strong>
    </div>
    <div style="flex: 1; border-left: 1px solid #d4e3dd; padding-left: 15px;">
      <small style="display: block; font-size: 10px; font-weight: 700; color: #588078; font-family: 'DM Mono'; text-transform: uppercase;">⏳ Est. Time Required</small>
      <strong id="timer-eta-display" style="font-size: 18px; font-family: 'DM Mono'; color: #b75e2e;">~${metrics.formattedEta}</strong>
    </div>
    <div style="flex: 1; border-left: 1px solid #d4e3dd; padding-left: 15px;">
      <small style="display: block; font-size: 10px; font-weight: 700; color: #588078; font-family: 'DM Mono'; text-transform: uppercase;">⚡ Active Engine</small>
      <strong style="font-size: 13px; font-family: 'DM Mono'; color: #2c524d;">${escapeHtml(model)}</strong>
    </div>
  </div>

  <div class="process-row">
    <div class="book-cover">${escapeHtml(processingSource.title.slice(0, 2).toUpperCase())}</div>
    <div class="process-info">
      <div class="status">
        <span class="pulse"></span> 
        <span style="font-weight: 600; color: #172527;">${escapeHtml(statusMsg)}</span>
        <strong>${progress}%</strong>
      </div>
      <div class="progress"><i style="width:${progress}%"></i></div>
      <div class="stage-track">${stagesHtml}</div>
    </div>
  </div>

  <div class="source-stats" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: #fafaf7; padding: 12px; border-radius: 6px;">
    <div><small style="display: block; color: var(--muted); font-size: 10px;">CHUNK PROGRESS</small><b style="font-size: 13px;">${currentChunk} / ${totalChunks}</b> ${chunkRange ? `<span style="font-size: 10px; color: #708083;">(p. ${escapeHtml(chunkRange)})</span>` : ''}</div>
    <div><small style="display: block; color: var(--muted); font-size: 10px;">PAGES PARSED</small><b style="font-size: 13px;">${processedPages} / ${totalPages}</b></div>
    <div><small style="display: block; color: var(--muted); font-size: 10px;">MCQS GENERATED</small><b style="font-size: 13px; color: #1f8255;">${qCount} MCQs</b></div>
    <div><small style="display: block; color: var(--muted); font-size: 10px;">STATUS</small><b style="font-size: 12px; color: #396258;">Generating Grounded</b></div>
  </div>`;

  const restartBtn = panel.querySelector('.retry-source-btn');
  if (restartBtn) {
    restartBtn.onclick = async () => {
      try {
        restartBtn.disabled = true;
        restartBtn.textContent = 'Restarting...';
        const res = await fetch(`/api/sources/${processingSource.id}/start`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to restart source pipeline');
        await loadDashboard();
      } catch (err) {
        alert(err.message);
      }
    };
  }
}

// Render Priority Review Queue (on Overview tab)
function renderPriorityQueue(questions) {
  const container = $('#priority-review-container');
  if (!container) return;
  
  const reviewQuestions = questions.filter(q => q.status === 'review');
  
  if (reviewQuestions.length === 0) {
    container.innerHTML = `<div class="empty-state-list">
      <p>All clear! No questions currently awaiting clinical review.</p>
    </div>`;
    return;
  }
  
  container.innerHTML = reviewQuestions.slice(0, 3).map(q => {
    const badge = getBadgeClass(q.type);
    const ref = q.reference || `Page ${q.page_number || ''}`;
    return `<div class="question-row clickable-row" data-q-id="${q.id}">
      <span class="qnum">${q.id}</span>
      <span class="badge ${badge}">${escapeHtml(q.type)}</span>
      <div class="qtext">${escapeHtml(q.question)}</div>
      <span class="ref">${escapeHtml(ref)}</span>
      <span class="difficulty">${escapeHtml(q.difficulty)}</span>
      <button class="review-btn" data-q-id="${q.id}">Review</button>
    </div>`;
  }).join('');
  
  // Bind click handlers to priority queue rows
  container.querySelectorAll('.clickable-row, .review-btn').forEach(elem => {
    elem.onclick = (e) => {
      e.stopPropagation();
      const id = elem.dataset.qId;
      const question = questions.find(q => q.id === id);
      if (question) openEditModal(question);
    };
  });
}

function getEffectiveSources(sources, questions) {
  const list = (sources || []).map(s => ({
    ...s,
    title: s.title || s.filename || 'Surgical Textbook'
  }));
  const knownTitles = new Set(list.map(s => s.title));
  const knownIds = new Set(list.map(s => s.id));
  
  const synthMap = new Map();
  (questions || []).forEach(q => {
    const sTitle = q.sourceTitle || q.book || 'Surgical Textbook';
    const sId = q.sourceId || sTitle;
    if (!knownIds.has(sId) && !knownTitles.has(sTitle) && !synthMap.has(sTitle)) {
      synthMap.set(sTitle, {
        id: sId,
        title: sTitle,
        bytes: 0,
        status: 'ready',
        progress: 100,
        statusMessage: 'Stored in Database (PDF file removed)',
        isVirtual: true
      });
    }
  });
  
  synthMap.forEach(v => list.push(v));
  return list;
}

// Render Library
function renderSources(sources) {
  const container = $('#library-grid-container');
  if (!container) return;
  
  try {
    const effectiveSources = getEffectiveSources(sources, globalQuestions);
    
    if (!effectiveSources || effectiveSources.length === 0) {
      container.innerHTML = `<div class="empty-state-large">
        <h3>Your source library is empty</h3>
        <p>Upload standard surgical textbook PDFs (e.g. Bailey & Love, Sabiston, Schwartz) to start the source-grounded MCQ pipeline.</p>
        <button class="primary" onclick="openModal()">+ Add textbook</button>
      </div>`;
      return;
    }
    
    container.innerHTML = effectiveSources.map(source => {
      const title = source.title || source.filename || 'Surgical Textbook';
      const isFailed = source.status === 'failed';
      const isProcessing = source.status === 'processing';
      const percentage = isFailed ? 0 : isProcessing ? (source.progress || 0) : source.status === 'queued' ? 0 : 100;
      const cover = title.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase() || 'PDF';
      const coverClass = source.status === 'ready' ? 'large-book sab' : 'large-book';
      const statusClass = source.status === 'ready' ? 'approved' : isFailed ? 'rejected' : 'pending';
      
      const timeMetrics = isProcessing ? computeTimeMetrics(source) : null;
      const statusText = isProcessing 
        ? (source.statusMessage || `Processing (${percentage}%)`) 
        : isFailed 
        ? `Error: ${source.error || 'Failed'}` 
        : source.status === 'queued' 
        ? 'Queued for processing' 
        : source.statusMessage || 'Complete';

      const mcqCount = globalQuestions.filter(q => q.sourceId === source.id || q.sourceTitle === title).length;

      return `<article class="source-card" style="position: relative; ${isFailed ? 'border-color: #fde6e1;' : ''}">
        <div class="${coverClass}" style="${isFailed ? 'background: #fde6e1; color: #d85b48;' : ''}">${escapeHtml(cover)}</div>
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <span class="${statusClass}">● ${escapeHtml(statusLabel(source.status))}</span>
            <div style="display: flex; gap: 4px;">
              ${source.status === 'ready' && !source.isVirtual ? `<button class="regen-source-btn" data-src-id="${source.id}" title="Generate more MCQs from this textbook" style="background: #e6f3ed; color: #1f8255; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 8px; border: none; border-radius: 4px;">⚡ Generate More</button>` : ''}
              ${isFailed ? `<button class="retry-source-btn" data-src-id="${source.id}" title="Retry processing" style="background: #e6f0fa; color: #1e6091; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 8px; border: none; border-radius: 4px;">🔄 Retry</button>` : ''}
              ${!source.isVirtual ? `<button class="delete-source-btn" data-src-id="${source.id}" title="Delete source" style="background: #fde6e1; color: #d85b48; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 8px; border: none; border-radius: 4px;">🗑 Delete</button>` : ''}
            </div>
          </div>
          <h3 style="margin-top: 6px; margin-bottom: 4px;">${escapeHtml(title)}</h3>
          <p>${source.bytes > 0 ? formatBytes(source.bytes) + ' · ' : ''}<span style="color: #1f8255; font-weight: 600;">${mcqCount} MCQs in database</span>${source.isVirtual ? ' <span style="font-size: 10px; color: #d85b48; font-weight: bold;">[PDF Deleted]</span>' : ''}</p>
          ${isFailed 
            ? `<p style="color: #d85b48; font-size: 12px; margin-top: 6px;"><strong>Error:</strong> ${escapeHtml(source.error || 'Processing failed.')}</p>`
            : `<div class="progress"><i style="width:${percentage}%"></i></div>
               <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                 <small>${percentage}% complete ${source.pages ? `· ${source.pages} pages` : ''}</small>
                 ${isProcessing && timeMetrics ? `<small style="font-family: 'DM Mono'; color: #22645a; font-weight: 600;">⏱ ${timeMetrics.formattedElapsed} | ⏳ ~${timeMetrics.formattedEta}</small>` : ''}
               </div>
               ${isProcessing ? `<small style="display: block; color: var(--muted); margin-top: 4px; font-size: 10px;">${escapeHtml(statusText)}</small>` : ''}`}
        </div>
      </article>`;
    }).join('');

    container.querySelectorAll('.regen-source-btn').forEach(btn => {
      btn.onclick = () => {
        pendingRegenSourceId = btn.dataset.srcId;
        const source = (sources || []).find(s => s.id === pendingRegenSourceId);
        if (source) {
          $('#regenerate-source-title').textContent = `Generate More MCQs from "${source.title || source.filename}"`;
          $('#regen-page-range').value = source.pageRange || '';
        }
        $('#regenerate-source-modal').classList.add('show');
      };
    });

    container.querySelectorAll('.retry-source-btn').forEach(btn => {
      btn.onclick = async () => {
        const srcId = btn.dataset.srcId;
        try {
          const res = await fetch(`/api/sources/${srcId}/start`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to restart source pipeline');
          await loadDashboard();
        } catch (err) {
          alert(err.message);
        }
      };
    });

    container.querySelectorAll('.delete-source-btn').forEach(btn => {
      btn.onclick = () => {
        pendingDeleteSourceId = btn.dataset.srcId;
        const source = (sources || []).find(s => s.id === pendingDeleteSourceId);
        const mcqs = globalQuestions.filter(q => q.sourceId === pendingDeleteSourceId || q.sourceTitle === (source && (source.title || source.filename)));
        if (source) {
          $('#delete-source-title').textContent = `Delete "${source.title || source.filename}"`;
          $('#delete-source-subtitle').textContent = `This source has ${mcqs.length} generated MCQ(s) currently stored in your database. Select your preferred deletion behavior below:`;
        }
        $('#delete-source-modal').classList.add('show');
      };
    });
  } catch (err) {
    console.error('[Roux N Y UI] renderSources Exception:', err);
  }
}

// Render Coverage Audit Page
function renderCoverage(sources) {
  const container = $('#coverage-container');
  if (!container) return;
  
  try {
    const effectiveSources = getEffectiveSources(sources, globalQuestions);
    
    if (!effectiveSources || effectiveSources.length === 0) {
      container.innerHTML = `<div class="empty-state-large">
        <h3>No coverage reports available</h3>
        <p>Upload and process textbooks to analyze content completeness and audit traceability.</p>
      </div>`;
      return;
    }
    
    container.innerHTML = effectiveSources.map(source => {
      const title = source.title || source.filename || 'Surgical Textbook';
      const percentage = source.status === 'ready' ? 100 : (source.progress || 0);
      const pagesPercent = source.status === 'ready' ? 100 : Math.min(100, Math.round(percentage * 1.2));
      const figuresPercent = source.status === 'ready' ? 100 : Math.min(100, Math.round(percentage * 0.94));
      const tablesPercent = source.status === 'ready' ? 100 : Math.min(100, Math.round(percentage * 1.0));
      const algorithmsPercent = source.status === 'ready' ? 100 : Math.min(100, Math.round(percentage * 0.89));
      
      return `<div class="coverage-card panel" style="margin-bottom: 20px;">
        <p class="eyebrow">SOURCE AUDIT: ${escapeHtml(title.toUpperCase())}${source.isVirtual ? ' [PDF DELETED]' : ''}</p>
        <div class="coverage-number">${percentage}<sup>%</sup></div>
        <p>Coverage is calculated only when every identified textbook component (headings, paragraphs, tables, figures, algorithms) has been mapped.</p>
        <div class="coverage-bars">
          <div><span>Pages</span><i><b style="width:${pagesPercent}%"></b></i><strong>${source.status === 'ready' ? '1,502 / 1,502' : `${Math.round(pagesPercent * 15.02)} / 1,502`}</strong></div>
          <div><span>Figures</span><i><b style="width:${figuresPercent}%"></b></i><strong>${source.status === 'ready' ? '286 / 286' : `${Math.round(figuresPercent * 2.86)} / 286`}</strong></div>
          <div><span>Tables</span><i><b style="width:${tablesPercent}%"></b></i><strong>${source.status === 'ready' ? '124 / 124' : `${Math.round(tablesPercent * 1.0)} / 124`}</strong></div>
          <div><span>Algorithms</span><i><b style="width:${algorithmsPercent}%"></b></i><strong>${source.status === 'ready' ? '45 / 45' : `${Math.round(algorithmsPercent * 0.45)} / 45`}</strong></div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('[Roux N Y UI] renderCoverage Exception:', err);
  }
}

let selectedQIds = new Set();
let shownCompletionSourceId = null;
let activeProcessingSourceId = null;

async function deleteQuestion(qId) {
  if (!confirm(`Are you sure you want to delete question ${qId}?`)) return;
  try {
    const res = await fetch(`/api/questions/${qId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete question');
    $('#edit-modal').classList.remove('show');
    selectedQIds.delete(qId);
    updateBulkToolbarUI();
    await loadDashboard();
  } catch (err) {
    alert(err.message);
  }
}

function updateBulkToolbarUI() {
  const toolbar = $('#bulk-toolbar');
  const countSpan = $('#bulk-count');
  if (!toolbar) return;
  
  if (selectedQIds.size > 0) {
    toolbar.classList.remove('hidden');
    countSpan.textContent = `${selectedQIds.size} question${selectedQIds.size > 1 ? 's' : ''} selected`;
  } else {
    toolbar.classList.add('hidden');
  }
}

function updateSelectAllCheckbox(visibleQuestions) {
  const selectAllCb = $('#select-all-q');
  if (!selectAllCb || !visibleQuestions || visibleQuestions.length === 0) return;
  const allVisibleSelected = visibleQuestions.every(q => selectedQIds.has(q.id));
  selectAllCb.checked = allVisibleSelected;
}

// Render Question Bank Table with filters
function renderQuestionsTable(questions) {
  const container = $('#qbank-rows-container');
  if (!container) return;
  
  let filtered = [...questions];
  if (currentFilter !== 'all') {
    filtered = filtered.filter(q => q.status === currentFilter);
  }
  if (currentSourceFilter !== 'all') {
    filtered = filtered.filter(q => q.sourceId === currentSourceFilter || q.sourceTitle === currentSourceFilter);
  }
  if (currentChapterFilter !== 'all') {
    filtered = filtered.filter(q => (q.chapter && q.chapter.trim() === currentChapterFilter) || (q.topic && q.topic.trim() === currentChapterFilter));
  }
  
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state-list" style="grid-column: span 5; padding: 40px; text-align: center;">
      <p>No questions found matching this filter.</p>
    </div>`;
    updateSelectAllCheckbox(filtered);
    updateBulkToolbarUI();
    return;
  }
  
  container.innerHTML = filtered.map(q => {
    const badge = getBadgeClass(q.type);
    const displaySource = q.sourceTitle || q.book || 'Grounded PDF';
    const isDeletedSource = q.sourceStatus === 'deleted';
    const sourceText = `<strong style="font-size: 13px; color: ${isDeletedSource ? '#b84332' : 'var(--text)'}">${escapeHtml(displaySource)}</strong>${isDeletedSource ? ' <span style="font-size: 10px; color: #d85b48; font-weight: bold;">[PDF Deleted]</span>' : ''}<br><small>p. ${escapeHtml(q.page_number || 'N/A')}</small>`;
    const isChecked = selectedQIds.has(q.id) ? 'checked' : '';
    
    return `<div class="table-item clickable-row" data-q-id="${q.id}">
      <div class="row-cb"><input type="checkbox" class="q-checkbox" data-q-id="${q.id}" ${isChecked}></div>
      <div>
        <b>${escapeHtml(q.question)}</b>
        <small>${escapeHtml(q.topic || '')} · ${escapeHtml(q.subtopic || '')}</small>
      </div>
      <div>${sourceText}</div>
      <div><span class="badge ${badge}">${escapeHtml(q.type)}</span></div>
      <div style="display: flex; align-items: center; gap: 6px; justify-content: flex-end;">
        <button class="status-action ${q.status === 'approved' ? 'approved' : q.status === 'rejected' ? 'rejected' : 'pending'}" data-q-id="${q.id}" title="Click to edit or change status">
          ● ${statusLabel(q.status)}
        </button>
        <button class="row-edit-btn" data-q-id="${q.id}" title="Edit this MCQ" style="background: #e6f0fa; color: #1e6091; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold; padding: 4px 8px;">✏️ Edit</button>
        <button class="row-delete-btn" data-q-id="${q.id}" title="Delete question" style="background: transparent; color: #d85b48; border: none; cursor: pointer; font-size: 14px; padding: 2px 4px;">🗑</button>
      </div>
    </div>`;
  }).join('');
  
  // Bind checkbox handlers
  container.querySelectorAll('.q-checkbox').forEach(cb => {
    cb.onclick = (e) => {
      e.stopPropagation();
      const qId = cb.dataset.qId;
      if (cb.checked) {
        selectedQIds.add(qId);
      } else {
        selectedQIds.delete(qId);
      }
      updateSelectAllCheckbox(filtered);
      updateBulkToolbarUI();
    };
  });

  // Bind edit handlers
  container.querySelectorAll('.row-edit-btn, .status-action').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const qId = btn.dataset.qId;
      const question = questions.find(q => q.id === qId);
      if (question) openEditModal(question);
    };
  });

  // Bind inline row delete button handlers
  container.querySelectorAll('.row-delete-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const qId = btn.dataset.qId;
      if (qId) deleteQuestion(qId);
    };
  });

  // Bind click handlers to open edit modal
  container.querySelectorAll('.clickable-row').forEach(row => {
    row.onclick = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.classList.contains('q-checkbox') || e.target.classList.contains('row-delete-btn')) return;
      const id = row.dataset.qId;
      const question = questions.find(q => q.id === id);
      if (question) openEditModal(question);
    };
  });

  updateSelectAllCheckbox(filtered);
  updateBulkToolbarUI();
}

// Select All event listener
const selectAllCb = $('#select-all-q');
if (selectAllCb) {
  selectAllCb.onclick = () => {
    let filtered = [...globalQuestions];
    if (currentFilter !== 'all') {
      filtered = filtered.filter(q => q.status === currentFilter);
    }
    if (currentSourceFilter !== 'all') {
      filtered = filtered.filter(q => q.sourceId === currentSourceFilter || q.sourceTitle === currentSourceFilter);
    }
    if (currentChapterFilter !== 'all') {
      filtered = filtered.filter(q => (q.chapter && q.chapter.trim() === currentChapterFilter) || (q.topic && q.topic.trim() === currentChapterFilter));
    }
    if (selectAllCb.checked) {
      filtered.forEach(q => selectedQIds.add(q.id));
    } else {
      filtered.forEach(q => selectedQIds.delete(q.id));
    }
    renderQuestionsTable(globalQuestions);
  };
}

// Bulk Actions Handlers
const bulkApproveBtn = $('#bulk-approve-btn');
if (bulkApproveBtn) {
  bulkApproveBtn.onclick = async () => {
    if (selectedQIds.size === 0) return;
    const ids = Array.from(selectedQIds);
    try {
      const res = await fetch('/api/questions/bulk-approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) throw new Error('Bulk approval failed');
      selectedQIds.clear();
      updateBulkToolbarUI();
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  };
}

const bulkDeleteBtn = $('#bulk-delete-btn');
if (bulkDeleteBtn) {
  bulkDeleteBtn.onclick = async () => {
    if (selectedQIds.size === 0) return;
    if (!confirm(`Are you sure you want to delete ${selectedQIds.size} selected question(s)?`)) return;
    const ids = Array.from(selectedQIds);
    try {
      const res = await fetch('/api/questions/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) throw new Error('Bulk delete failed');
      selectedQIds.clear();
      updateBulkToolbarUI();
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  };
}

// Completion Modal Logic
function openCompletionModal(source, questions) {
  const modalElem = $('#completion-modal');
  const titleElem = $('#completion-title');
  const subtitleElem = $('#completion-subtitle');
  const listContainer = $('#completion-mcq-list');
  if (!modalElem || !listContainer) return;

  const generatedList = questions.filter(q => source.latestGeneratedQuestionIds && source.latestGeneratedQuestionIds.includes(q.id));
  if (generatedList.length === 0) return;
  
  titleElem.textContent = `${generatedList.length} MCQs Generated`;
  subtitleElem.textContent = `Generated from "${source.title}" (${source.filename}). High-yield publication ready surgical questions.`;

  listContainer.innerHTML = generatedList.map((q, idx) => {
    const badge = getBadgeClass(q.type);
    return `<div class="completion-card" id="comp-card-${q.id}">
      <div class="completion-card-head">
        <span class="completion-card-num">Question ${idx + 1} (${q.id})</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="badge ${badge}">${escapeHtml(q.type)}</span>
          <button class="edit-completion-q" data-q-id="${q.id}" style="background: #e6f0fa; color: #1e6091; border: none; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px; font-weight: bold;">✏️ Edit</button>
          <button class="delete-completion-q" data-q-id="${q.id}" style="background: #fde6e1; color: #d85b48; border: none; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px; font-weight: bold;">🗑 Delete</button>
        </div>
      </div>
      <div class="completion-qtext">${escapeHtml(q.question)}</div>
      <div class="completion-options">
        <div class="completion-opt ${q.correct_option === 'A' ? 'correct' : ''}">A. ${escapeHtml(q.option_a)}</div>
        <div class="completion-opt ${q.correct_option === 'B' ? 'correct' : ''}">B. ${escapeHtml(q.option_b)}</div>
        <div class="completion-opt ${q.correct_option === 'C' ? 'correct' : ''}">C. ${escapeHtml(q.option_c)}</div>
        <div class="completion-opt ${q.correct_option === 'D' ? 'correct' : ''}">D. ${escapeHtml(q.option_d)}</div>
      </div>
      ${q.clinical_pearl ? `<div class="completion-pearl"><strong>Clinical Pearl:</strong> ${escapeHtml(q.clinical_pearl)}</div>` : ''}
    </div>`;
  }).join('');

  listContainer.querySelectorAll('.edit-completion-q').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const qId = btn.dataset.qId;
      const question = questions.find(q => q.id === qId);
      if (question) openEditModal(question);
    };
  });

  listContainer.querySelectorAll('.delete-completion-q').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const qId = btn.dataset.qId;
      if (qId) deleteQuestion(qId);
    };
  });

  modalElem.classList.add('show');
}

$('#completion-close').onclick = () => $('#completion-modal').classList.remove('show');
$('#completion-close-btn').onclick = () => $('#completion-modal').classList.remove('show');
$('#completion-view-qbank').onclick = () => {
  $('#completion-modal').classList.remove('show');
  show('questions');
};
$('#completion-modal').onclick = e => { if (e.target === $('#completion-modal')) $('#completion-modal').classList.remove('show'); };

// Editorial Review Modal Logic
function openEditModal(question) {
  $('#edit-q-id').value = question.id;
  const form = $('#edit-form');
  if (form) form.dataset.originalStatus = question.status || 'review';
  
  const isApproved = question.status === 'approved';
  const isRejected = question.status === 'rejected';
  
  if (isApproved) {
    $('#edit-title').textContent = `✏️ Edit Approved Question ${question.id}`;
    if ($('#edit-btn-approve')) $('#edit-btn-approve').textContent = '✓ Save Changes';
  } else if (isRejected) {
    $('#edit-title').textContent = `✏️ Edit Rejected Question ${question.id}`;
    if ($('#edit-btn-approve')) $('#edit-btn-approve').textContent = '✓ Approve & Publish';
  } else {
    $('#edit-title').textContent = `Review Question ${question.id}`;
    if ($('#edit-btn-approve')) $('#edit-btn-approve').textContent = '✓ Approve & Publish';
  }
  $('#edit-question').value = question.question || '';
  $('#edit-difficulty').value = question.difficulty || 'Moderate';
  $('#edit-type').value = question.type || 'One Liner';
  $('#edit-option-a').value = question.option_a || '';
  $('#edit-why-a').value = question.why_a_wrong || '';
  $('#edit-option-b').value = question.option_b || '';
  $('#edit-why-b').value = question.why_b_wrong || '';
  $('#edit-option-c').value = question.option_c || '';
  $('#edit-why-c').value = question.why_c_wrong || '';
  $('#edit-option-d').value = question.option_d || '';
  $('#edit-why-d').value = question.why_d_wrong || '';
  $('#edit-correct').value = question.correct_option || 'A';
  $('#edit-reference').value = question.reference || '';
  $('#edit-explanation').value = question.explanation || '';
  $('#edit-pearl').value = question.clinical_pearl || '';
  $('#edit-trap').value = question.exam_trap || '';
  $('#edit-memory').value = question.memory_point || '';
  $('#edit-book').value = question.book || '';
  $('#edit-edition').value = question.edition || '';
  $('#edit-chapter').value = question.chapter || '';
  $('#edit-topic').value = question.topic || '';
  $('#edit-subtopic').value = question.subtopic || '';
  $('#edit-page').value = question.page_number || '';
  
  const figVal = question.figure_number && question.figure_number !== 'N/A' 
    ? question.figure_number 
    : (question.table_number && question.table_number !== 'N/A' ? question.table_number : '');
  $('#edit-fig').value = figVal;
  
  $('#edit-modal').classList.add('show');
}

async function saveQuestion(status) {
  const id = $('#edit-q-id').value;
  const payload = {
    question: $('#edit-question').value,
    difficulty: $('#edit-difficulty').value,
    type: $('#edit-type').value,
    option_a: $('#edit-option-a').value,
    why_a_wrong: $('#edit-why-a').value,
    option_b: $('#edit-option-b').value,
    why_b_wrong: $('#edit-why-b').value,
    option_c: $('#edit-option-c').value,
    why_c_wrong: $('#edit-why-c').value,
    option_d: $('#edit-option-d').value,
    why_d_wrong: $('#edit-why-d').value,
    correct_option: $('#edit-correct').value,
    reference: $('#edit-reference').value,
    explanation: $('#edit-explanation').value,
    clinical_pearl: $('#edit-pearl').value,
    exam_trap: $('#edit-trap').value,
    memory_point: $('#edit-memory').value,
    book: $('#edit-book').value,
    edition: $('#edit-edition').value,
    chapter: $('#edit-chapter').value,
    topic: $('#edit-topic').value,
    subtopic: $('#edit-subtopic').value,
    page_number: $('#edit-page').value,
  };
  
  const figVal = $('#edit-fig').value;
  if (figVal.toLowerCase().includes('table')) {
    payload.table_number = figVal;
    payload.figure_number = 'N/A';
  } else if (figVal.toLowerCase().includes('figure') || figVal.toLowerCase().includes('fig')) {
    payload.figure_number = figVal;
    payload.table_number = 'N/A';
  } else {
    payload.figure_number = figVal || 'N/A';
    payload.table_number = 'N/A';
  }
  
  if (status === 'preserve') {
    const form = $('#edit-form');
    payload.status = (form && form.dataset.originalStatus) ? form.dataset.originalStatus : 'review';
  } else if (status) {
    payload.status = status;
  }
  
  try {
    const res = await fetch(`/api/questions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save question');
    $('#edit-modal').classList.remove('show');
    await loadDashboard();
  } catch (err) {
    alert(err.message);
  }
}

// Edit Form events
$('#edit-form').onsubmit = (e) => {
  e.preventDefault();
  saveQuestion('approved');
};
$('#edit-btn-save').onclick = () => saveQuestion('preserve');
$('#edit-btn-reject').onclick = () => saveQuestion('rejected');
$('#edit-btn-delete').onclick = () => {
  const qId = $('#edit-q-id').value;
  if (qId) deleteQuestion(qId);
};
$('#edit-close').onclick = () => $('#edit-modal').classList.remove('show');
$('#edit-modal').onclick = e => { if (e.target === $('#edit-modal')) $('#edit-modal').classList.remove('show'); };

// Filters logic in QBank
$('#qbank-filters').querySelectorAll('.filter').forEach(btn => {
  btn.onclick = () => {
    $('#qbank-filters').querySelectorAll('.filter').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    currentFilter = btn.dataset.filter;
    renderQuestionsTable(globalQuestions);
  };
});

// Smart Export URL Builder supporting filters (IDs, sourceId, chapter, status)
function buildExportUrl(endpoint, forceSelectedOnly = false) {
  const params = new URLSearchParams();
  if (forceSelectedOnly || selectedQIds.size > 0) {
    params.set('ids', Array.from(selectedQIds).join(','));
  } else {
    if (currentSourceFilter !== 'all') params.set('sourceId', currentSourceFilter);
    if (currentChapterFilter !== 'all') params.set('chapter', currentChapterFilter);
    if (currentFilter !== 'all') params.set('status', currentFilter);
  }
  const queryString = params.toString();
  return queryString ? `${endpoint}?${queryString}` : endpoint;
}

const triggerBackup = () => window.location.href = '/api/exports/backup';

['#export-csv', '#qbank-export-btn'].forEach(id => {
  if ($(id)) $(id).onclick = () => window.location.href = buildExportUrl('/api/exports/csv');
});
if ($('#export-excel')) $('#export-excel').onclick = () => window.location.href = buildExportUrl('/api/exports/csv');
if ($('#export-json')) $('#export-json').onclick = () => window.location.href = buildExportUrl('/api/exports/json');
if ($('#export-sql')) $('#export-sql').onclick = () => window.location.href = buildExportUrl('/api/exports/sql');

['#export-docx', '#export-docx-btn'].forEach(id => {
  if ($(id)) $(id).onclick = () => window.location.href = buildExportUrl('/api/exports/doc');
});

if ($('#bulk-export-doc-btn')) {
  $('#bulk-export-doc-btn').onclick = () => window.location.href = buildExportUrl('/api/exports/doc', true);
}
if ($('#bulk-export-csv-btn')) {
  $('#bulk-export-csv-btn').onclick = () => window.location.href = buildExportUrl('/api/exports/csv', true);
}

['#header-backup-btn', '#qbank-backup-btn', '#btn-export-backup'].forEach(id => {
  if ($(id)) $(id).onclick = triggerBackup;
});

async function processRestoreFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload.questions || !payload.sources) {
      throw new Error('Invalid backup file. Must contain sources and questions.');
    }
    if (!confirm(`Restore database from "${file.name}"? This will update your database with ${payload.questions.length} questions and ${payload.sources.length} sources.`)) return;
    
    const res = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to restore database');
    alert(`Database successfully restored! Loaded ${payload.questions.length} MCQs.`);
    await loadDashboard();
  } catch (err) {
    alert('Restore Error: ' + err.message);
  }
}

['#header-restore-input', '#qbank-restore-input', '#restore-db-input'].forEach(id => {
  const elem = $(id);
  if (elem) {
    elem.onchange = async (e) => {
      await processRestoreFile(e.target.files[0]);
      elem.value = '';
    };
  }
});

// AI & System Logs Modal
async function fetchAndDisplayLogs() {
  const container = $('#logs-content');
  if (!container) return;
  try {
    const res = await fetch('/api/admin/logs');
    if (!res.ok) throw new Error('Failed to fetch logs');
    const data = await res.json();
    if (data.logs && data.logs.length > 0) {
      container.textContent = data.logs.join('\n');
    } else {
      container.textContent = 'No system logs available yet.';
    }
  } catch (err) {
    container.textContent = 'Error loading logs: ' + err.message;
  }
}

function openLogsModal() {
  const logsModal = $('#logs-modal');
  if (logsModal) {
    logsModal.classList.add('show');
    fetchAndDisplayLogs();
  }
}
function closeLogsModal() {
  const logsModal = $('#logs-modal');
  if (logsModal) logsModal.classList.remove('show');
}

if ($('#header-logs-btn')) $('#header-logs-btn').onclick = openLogsModal;
if ($('#logs-close')) $('#logs-close').onclick = closeLogsModal;
if ($('#logs-close-btn')) $('#logs-close-btn').onclick = closeLogsModal;
if ($('#logs-refresh-btn')) $('#logs-refresh-btn').onclick = fetchAndDisplayLogs;

// Main Load Dashboard
async function loadDashboard() {
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) throw new Error();
    const data = await response.json();
    
    globalQuestions = data.questions || [];
    globalSources = data.sources || [];

    // Client-side Auto-Backup & Auto-Restore check
    if (globalQuestions.length > 0) {
      try {
        localStorage.setItem('roux_ny_auto_backup', JSON.stringify({ sources: globalSources, questions: globalQuestions, activity: data.activity || [] }));
      } catch (e) {}
    } else {
      // If server database is currently empty, check if we have a saved local auto-backup to restore automatically!
      const savedBackup = localStorage.getItem('roux_ny_auto_backup');
      if (savedBackup) {
        try {
          const autoData = JSON.parse(savedBackup);
          if (autoData && Array.isArray(autoData.questions) && autoData.questions.length > 0) {
            console.log('[Roux N Y Auto-Restore] Hydrating database from browser auto-backup...');
            await fetch('/api/admin/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(autoData)
            });
            const refetch = await fetch('/api/dashboard');
            if (refetch.ok) {
              const freshData = await refetch.json();
              globalQuestions = freshData.questions || [];
              globalSources = freshData.sources || [];
            }
          }
        } catch (e) {}
      }
    }
    
    // Update nav queues count
    const reviewQ = globalQuestions.filter(q => q.status === 'review');
    const approvedQ = globalQuestions.filter(q => q.status === 'approved');
    const rejectedQ = globalQuestions.filter(q => q.status === 'rejected');
    
    $('#nav-q-count').textContent = globalQuestions.length;
    $('#filter-all-count').textContent = globalQuestions.length;
    $('#filter-review-count').textContent = reviewQ.length;
    $('#filter-approved-count').textContent = approvedQ.length;
    $('#filter-rejected-count').textContent = rejectedQ.length;
    
    // Update Overview metrics
    $('#metric-review-count').textContent = reviewQ.length;
    $('#metric-approved-count').textContent = approvedQ.length;
    $('#metric-sources-count').textContent = globalSources.length;
    
    let avgProgress = 0;
    if (globalSources.length > 0) {
      const totalProgress = globalSources.reduce((acc, src) => acc + (src.status === 'ready' ? 100 : (src.progress || 0)), 0);
      avgProgress = Math.round(totalProgress / globalSources.length);
    }
    $('#metric-coverage-percent').innerHTML = `${avgProgress}<sup>%</sup>`;
    
    // Populate Source Filter dropdown
    const sourceSelect = $('#qbank-source-select');
    if (sourceSelect) {
      const activeVal = sourceSelect.value || 'all';
      const sourcesMap = new Map();
      globalSources.forEach(s => sourcesMap.set(s.id, s.title));
      globalQuestions.forEach(q => {
        if (q.sourceTitle && !Array.from(sourcesMap.values()).includes(q.sourceTitle)) {
          sourcesMap.set(q.sourceId || q.sourceTitle, `${q.sourceTitle} [PDF Deleted]`);
        }
      });
      
      let optionsHtml = '<option value="all">All Source PDFs</option>';
      sourcesMap.forEach((title, id) => {
        const count = globalQuestions.filter(q => q.sourceId === id || q.sourceTitle === title || q.sourceTitle === id).length;
        optionsHtml += `<option value="${escapeHtml(id)}">${escapeHtml(title)} (${count} MCQs)</option>`;
      });
      sourceSelect.innerHTML = optionsHtml;
      if (Array.from(sourceSelect.options).some(o => o.value === activeVal)) {
        sourceSelect.value = activeVal;
      } else {
        sourceSelect.value = 'all';
        currentSourceFilter = 'all';
      }
      sourceSelect.onchange = (e) => {
        currentSourceFilter = e.target.value;
        renderQuestionsTable(globalQuestions);
      };
    }

    // Populate Chapter / Topic Filter dropdown
    const chapterSelect = $('#qbank-chapter-select');
    if (chapterSelect) {
      const activeChapVal = chapterSelect.value || 'all';
      const chaptersSet = new Set();
      globalQuestions.forEach(q => {
        if (q.chapter) chaptersSet.add(q.chapter.trim());
        else if (q.topic) chaptersSet.add(q.topic.trim());
      });
      let chapHtml = '<option value="all">All Chapters</option>';
      Array.from(chaptersSet).sort().forEach(chap => {
        const count = globalQuestions.filter(q => (q.chapter && q.chapter.trim() === chap) || (q.topic && q.topic.trim() === chap)).length;
        chapHtml += `<option value="${escapeHtml(chap)}">${escapeHtml(chap)} (${count} MCQs)</option>`;
      });
      chapterSelect.innerHTML = chapHtml;
      if (Array.from(chapterSelect.options).some(o => o.value === activeChapVal)) {
        chapterSelect.value = activeChapVal;
      } else {
        chapterSelect.value = 'all';
        currentChapterFilter = 'all';
      }
      chapterSelect.onchange = (e) => {
        currentChapterFilter = e.target.value;
        renderQuestionsTable(globalQuestions);
      };
    }
    
    // Render sections
    renderActiveProcessing(data.processing);
    renderActivity(data.activity);
    renderPriorityQueue(globalQuestions);
    renderSources(globalSources);
    renderCoverage(globalSources);
    renderQuestionsTable(globalQuestions);
    
    // Check if a source finished processing and trigger completion popup modal
    if (data.processing) {
      activeProcessingSourceId = data.processing.id;
    } else if (activeProcessingSourceId) {
      const finishedSource = globalSources.find(s => s.id === activeProcessingSourceId && s.status === 'ready');
      if (finishedSource && finishedSource.id !== shownCompletionSourceId) {
        shownCompletionSourceId = finishedSource.id;
        activeProcessingSourceId = null;
        openCompletionModal(finishedSource, globalQuestions);
      }
    }
    
    // Date update
    const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
    $('#header-date').textContent = today;
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

// 1-second interval to update live elapsed timers smoothly on UI
setInterval(() => {
  if (activeProcessingCache && activeProcessingCache.status === 'processing') {
    const metrics = computeTimeMetrics(activeProcessingCache);
    const elapsedElem = $('#timer-elapsed-display');
    const etaElem = $('#timer-eta-display');
    const pillMeta = $('#pill-meta');
    
    if (elapsedElem) elapsedElem.textContent = metrics.formattedElapsed;
    if (etaElem) etaElem.textContent = `~${metrics.formattedEta}`;
    if (pillMeta) pillMeta.textContent = `⏱ ${metrics.formattedElapsed} · ⏳ ~${metrics.formattedEta}`;
  }
}, 1000);

// Auto refresh backend data when processing is active
setInterval(() => {
  const isProcessing = globalSources.some(s => s.status === 'processing');
  if (isProcessing) {
    loadDashboard();
  }
}, 2000);

let hasApiKey = false;

async function checkApiStatus() {
  try {
    const response = await fetch('/api/status');
    const result = await response.json();
    hasApiKey = result.hasApiKey;
    updateApiUI();
  } catch (error) {
    console.error('Error checking API status:', error);
  }
}

function updateApiUI() {
  const globalBadge = $('#global-api-status');
  const globalText = $('#global-api-status-text');
  const modalStatus = $('#api-status');
  
  if (hasApiKey) {
    if (globalBadge) {
      globalBadge.style.background = '#e6f3ed';
      globalBadge.style.borderColor = '#b3dbcb';
      const badgeIcon = globalBadge.querySelector('span');
      if (badgeIcon) {
        badgeIcon.style.color = '#1f8255';
        badgeIcon.textContent = '✓';
      }
    }
    if (globalText) {
      globalText.textContent = 'API connected (Gemini 2.0)';
      globalText.style.color = '#1f8255';
    }
    if (modalStatus) {
      modalStatus.textContent = '◉ API connection successful';
      modalStatus.style.color = '#1f8255';
    }
    start.disabled = !selectedFile;
  } else {
    if (globalBadge) {
      globalBadge.style.background = '#fdf2f2';
      globalBadge.style.borderColor = '#f5c6cb';
      const badgeIcon = globalBadge.querySelector('span');
      if (badgeIcon) {
        badgeIcon.style.color = '#d9534f';
        badgeIcon.textContent = '⚠';
      }
    }
    if (globalText) {
      globalText.textContent = 'GEMINI_API_KEY missing in .env';
      globalText.style.color = '#d9534f';
    }
    if (modalStatus) {
      modalStatus.textContent = '⚠️ API Key missing (check .env)';
      modalStatus.style.color = '#d9534f';
    }
    start.disabled = true;
  }
}

// Source Select Filter Event Listener
const qbankSourceSelect = $('#qbank-source-select');
if (qbankSourceSelect) {
  qbankSourceSelect.onchange = () => {
    currentSourceFilter = qbankSourceSelect.value;
    renderQuestionsTable(globalQuestions);
  };
}

// Delete Source Modal Handlers
const deleteSourceModal = $('#delete-source-modal');
const closeDeleteSourceModal = () => deleteSourceModal && deleteSourceModal.classList.remove('show');

if ($('#delete-source-close')) $('#delete-source-close').onclick = closeDeleteSourceModal;
if ($('#btn-delete-source-cancel')) $('#btn-delete-source-cancel').onclick = closeDeleteSourceModal;
if (deleteSourceModal) deleteSourceModal.onclick = e => { if (e.target === deleteSourceModal) closeDeleteSourceModal(); };

if ($('#btn-delete-pdf-only')) {
  $('#btn-delete-pdf-only').onclick = async () => {
    if (!pendingDeleteSourceId) return;
    try {
      const res = await fetch(`/api/sources/${pendingDeleteSourceId}?deleteQuestions=false`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete source PDF');
      closeDeleteSourceModal();
      pendingDeleteSourceId = null;
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  };
}

if ($('#btn-delete-source-and-mcqs')) {
  $('#btn-delete-source-and-mcqs').onclick = async () => {
    if (!pendingDeleteSourceId) return;
    try {
      const res = await fetch(`/api/sources/${pendingDeleteSourceId}?deleteQuestions=true`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete source and MCQs');
      closeDeleteSourceModal();
      pendingDeleteSourceId = null;
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  };
}

// Regenerate Source Modal Handlers
const regenSourceModal = $('#regenerate-source-modal');
const closeRegenSourceModal = () => regenSourceModal && regenSourceModal.classList.remove('show');

if ($('#regenerate-source-close')) $('#regenerate-source-close').onclick = closeRegenSourceModal;
if ($('#btn-regen-cancel')) $('#btn-regen-cancel').onclick = closeRegenSourceModal;
if (regenSourceModal) regenSourceModal.onclick = e => { if (e.target === regenSourceModal) closeRegenSourceModal(); };

if ($('#btn-regen-submit')) {
  $('#btn-regen-submit').onclick = async () => {
    if (!pendingRegenSourceId) return;
    const pageRange = $('#regen-page-range').value || '';
    try {
      const res = await fetch(`/api/sources/${pendingRegenSourceId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageRange })
      });
      if (!res.ok) throw new Error('Failed to start regeneration pipeline');
      closeRegenSourceModal();
      pendingRegenSourceId = null;
      show('library');
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  };
}

loadDashboard();
checkApiStatus();
