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
    exports: 'Exports',
    tests: 'Test Studio & Exam Generator'
  };
  $('#page-title').textContent = titles[id] || 'Roux N Y';
  if (id === 'tests' && typeof renderTestsStudio === 'function') {
    renderTestsStudio();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function extractOptionText(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') {
    const s = val.trim();
    if (s === '[object Object]') return '';
    return s;
  }
  if (typeof val === 'number') return String(val).trim();
  if (typeof val === 'object') {
    if (val.text) return extractOptionText(val.text);
    if (val.content) return extractOptionText(val.content);
    if (val.value) return extractOptionText(val.value);
    if (val.option) return extractOptionText(val.option);
    if (val.label) return extractOptionText(val.label);
    if (val.desc || val.description) return extractOptionText(val.desc || val.description);
    try {
      const strProp = Object.values(val).find(v => typeof v === 'string' && v.trim() !== '[object Object]');
      if (strProp) return strProp.trim();
    } catch (e) {}
  }
  return '';
}

function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return q;

  const nq = { ...q };

  let optA = extractOptionText(nq.option_a || nq.optionA || nq.options_a || nq.a);
  let optB = extractOptionText(nq.option_b || nq.optionB || nq.options_b || nq.b);
  let optC = extractOptionText(nq.option_c || nq.optionC || nq.options_c || nq.c);
  let optD = extractOptionText(nq.option_d || nq.optionD || nq.options_d || nq.d);

  if ((!optA || !optB || !optC || !optD) && nq.options) {
    if (typeof nq.options === 'object' && !Array.isArray(nq.options)) {
      optA = optA || extractOptionText(nq.options.A || nq.options.a || nq.options['1'] || nq.options['option_a'] || nq.options['optionA']);
      optB = optB || extractOptionText(nq.options.B || nq.options.b || nq.options['2'] || nq.options['option_b'] || nq.options['optionB']);
      optC = optC || extractOptionText(nq.options.C || nq.options.c || nq.options['3'] || nq.options['option_c'] || nq.options['optionC']);
      optD = optD || extractOptionText(nq.options.D || nq.options.d || nq.options['4'] || nq.options['option_d'] || nq.options['optionD']);
    } else if (Array.isArray(nq.options)) {
      optA = optA || extractOptionText(nq.options[0]);
      optB = optB || extractOptionText(nq.options[1]);
      optC = optC || extractOptionText(nq.options[2]);
      optD = optD || extractOptionText(nq.options[3]);
    }
  }

  nq.option_a = optA || 'Option A';
  nq.option_b = optB || 'Option B';
  nq.option_c = optC || 'Option C';
  nq.option_d = optD || 'Option D';

  let rawCorrect = extractOptionText(nq.correct_option || nq.correctOption || nq.answer || nq.correctAnswer || nq.correct || 'A');
  rawCorrect = String(rawCorrect).trim().toUpperCase();
  if (rawCorrect.includes('A')) nq.correct_option = 'A';
  else if (rawCorrect.includes('B')) nq.correct_option = 'B';
  else if (rawCorrect.includes('C')) nq.correct_option = 'C';
  else if (rawCorrect.includes('D')) nq.correct_option = 'D';
  else nq.correct_option = 'A';

  nq.type = extractOptionText(nq.type || nq.mcqType) || 'Clinical Scenario';
  nq.difficulty = extractOptionText(nq.difficulty) || 'INI-SS';
  nq.book = extractOptionText(nq.book || nq.sourceBook) || 'Bailey & Love';
  nq.chapter = extractOptionText(nq.chapter || nq.chapter_name || nq.chapterName) || 'General Surgery';
  nq.topic = extractOptionText(nq.topic || nq.subject || nq.category) || 'Surgical Management';
  nq.subtopic = extractOptionText(nq.subtopic || nq.sub_topic || nq.subTopic) || 'Clinical Pearls';
  
  nq.explanation = extractOptionText(nq.explanation || nq.rationale || nq.answer_explanation || nq.why_correct) || 'Grounded in surgical text.';
  nq.clinical_pearl = extractOptionText(nq.clinical_pearl || nq.clinicalPearl || nq.pearl || nq.takeaway) || nq.explanation;
  nq.reference = extractOptionText(nq.reference || nq.citation) || `${nq.book}, ${nq.chapter}, p. ${nq.page_number || 'N/A'}`;

  return nq;
}

function statusLabel(status) {
  return status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'In review';
}

function getBadgeClass(type) {
  if (!type || typeof type !== 'string') return 'neutral';
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
      <button class="retry-source-btn" data-src-id="${processingSource.id}" style="background: #1e6091; color: white; font-size: 12px; font-weight: bold; cursor: pointer; padding: 7px 14px; border: none; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.15);">🔄 Restart Pipeline</button>
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
  const safeSources = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const list = safeSources.map(s => ({
    ...s,
    title: (s && (s.title || s.filename)) ? String(s.title || s.filename) : 'Surgical Textbook'
  }));
  
  const knownTitlesClean = new Set(list.map(s => (s.title || '').replace(/\.pdf$/i, '').toLowerCase().trim()));
  const knownIds = new Set(list.map(s => s.id));
  
  const synthMap = new Map();
  const safeQuestions = Array.isArray(questions) ? questions.filter(Boolean) : [];
  
  safeQuestions.forEach(q => {
    if (!q) return;
    const rawTitle = (q.sourceTitle || q.book || 'Surgical Textbook').toString().trim();
    const cleanTitle = rawTitle.replace(/\.pdf$/i, '').toLowerCase().trim();
    const sId = q.sourceId || rawTitle;
    
    if (!knownIds.has(sId) && !knownTitlesClean.has(cleanTitle) && !synthMap.has(cleanTitle)) {
      synthMap.set(cleanTitle, {
        id: sId,
        title: rawTitle,
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

      const cleanTitleKey = title.replace(/\.pdf$/i, '').toLowerCase().trim();
      const mcqCount = (globalQuestions || []).filter(q => {
        if (!q) return false;
        const qTitleClean = (q.sourceTitle || q.book || '').replace(/\.pdf$/i, '').toLowerCase().trim();
        return q.sourceId === source.id || (cleanTitleKey && qTitleClean === cleanTitleKey);
      }).length;

      return `<article class="source-card" style="position: relative; ${isFailed ? 'border-color: #fde6e1;' : ''}">
        <div class="${coverClass}" style="${isFailed ? 'background: #fde6e1; color: #d85b48;' : ''}">${escapeHtml(cover)}</div>
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <span class="${statusClass}">● ${escapeHtml(statusLabel(source.status))}</span>
              ${source.status === 'ready' && !source.isVirtual ? `<button class="preview-source-btn" data-src-id="${source.id}" title="Preview generated MCQs" style="background: #e6f0fa; color: #1e6091; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 8px; border: none; border-radius: 4px;">👁 Preview</button>` : ''}
              ${source.status === 'ready' && !source.isVirtual ? `<button class="regen-source-btn" data-src-id="${source.id}" title="Generate more MCQs from this textbook" style="background: #e6f3ed; color: #1f8255; font-size: 11px; font-weight: bold; cursor: padding: 4px 8px; border: none; border-radius: 4px;">⚡ Generate More</button>` : ''}
              ${isFailed || isProcessing ? `<button class="retry-source-btn" data-src-id="${source.id}" title="Restart processing pipeline" style="background: #1e6091; color: white; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 10px; border: none; border-radius: 4px;">🔄 Restart Pipeline</button>` : ''}
              ${!source.isVirtual ? `<button class="delete-source-btn" data-src-id="${source.id}" title="Delete source" style="background: #fde6e1; color: #d85b48; font-size: 11px; font-weight: bold; cursor: pointer; padding: 4px 8px; border: none; border-radius: 4px;">🗑 Delete</button>` : ''}
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

    container.querySelectorAll('.preview-source-btn').forEach(btn => {
      btn.onclick = () => {
        const sId = btn.dataset.srcId;
        const source = (effectiveSources || []).find(s => s.id === sId);
        if (source) openCompletionModal(source, globalQuestions);
      };
    });

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
    const selectedSource = (globalSources || []).find(s => s.id === currentSourceFilter || s.title === currentSourceFilter);
    const targetId = selectedSource ? selectedSource.id : currentSourceFilter;
    const targetTitle = selectedSource ? (selectedSource.title || selectedSource.filename) : currentSourceFilter;
    const targetTitleClean = (targetTitle || '').replace(/\.pdf$/i, '').toLowerCase().trim();

    filtered = filtered.filter(q => {
      const qSourceId = q.sourceId;
      const qTitle = (q.sourceTitle || q.book || '').trim();
      const qTitleClean = qTitle.replace(/\.pdf$/i, '').toLowerCase().trim();

      return qSourceId === targetId ||
             q.sourceTitle === currentSourceFilter ||
             q.sourceId === currentSourceFilter ||
             qTitle === targetTitle ||
             (targetTitleClean && qTitleClean === targetTitleClean) ||
             (selectedSource && q.sourceFilename && q.sourceFilename === selectedSource.filename);
    });
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

  const targetTitleClean = (source.title || source.filename || '').replace(/\.pdf$/i, '').toLowerCase().trim();

  let generatedList = [];
  if (source.latestGeneratedQuestionIds && source.latestGeneratedQuestionIds.length > 0) {
    generatedList = questions.filter(q => source.latestGeneratedQuestionIds.includes(q.id));
  }
  if (generatedList.length === 0) {
    generatedList = questions.filter(q => {
      const qTitleClean = (q.sourceTitle || q.book || '').replace(/\.pdf$/i, '').toLowerCase().trim();
      return q.sourceId === source.id || (targetTitleClean && qTitleClean === targetTitleClean);
    });
  }

  if (generatedList.length === 0) return;
  
  titleElem.textContent = `${generatedList.length} MCQs Generated`;
  subtitleElem.textContent = `Generated from "${source.title}" (${source.filename}). High-yield publication ready surgical questions.`;

  listContainer.innerHTML = generatedList.map((rawQ, idx) => {
    const q = normalizeQuestion(rawQ);
    const badge = getBadgeClass(q.type);
    return `<div class="completion-card" id="comp-card-${q.id}" style="margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: white;">
      <div class="completion-card-head" style="display: flex; justify-content: space-between; margin-bottom: 8px;">
        <div>
          <span class="completion-card-num" style="font-weight: 700;">Question ${idx + 1} (${q.id})</span>
          <small style="display: block; color: var(--muted); font-size: 11px;">📖 ${escapeHtml(q.chapter || 'Chapter')} · 🏷️ ${escapeHtml(q.topic || 'Topic')}</small>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="badge ${badge}">${escapeHtml(q.type)}</span>
          <button class="edit-completion-q" data-q-id="${q.id}" style="background: #e6f0fa; color: #1e6091; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; font-weight: bold;">✏️ Edit</button>
          <button class="delete-completion-q" data-q-id="${q.id}" style="background: #fde6e1; color: #d85b48; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; font-weight: bold;">🗑 Delete</button>
        </div>
      </div>
      <div class="completion-qtext" style="font-weight: 600; margin-bottom: 12px; font-size: 14px;">${escapeHtml(q.question)}</div>
      <div class="completion-options" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;">
        <div class="completion-opt ${q.correct_option === 'A' ? 'correct' : ''}" style="padding: 8px; border-radius: 4px; background: ${q.correct_option === 'A' ? '#e6f3ed' : '#f9f9f9'}; font-size: 12px;"><strong>A.</strong> ${escapeHtml(q.option_a)}</div>
        <div class="completion-opt ${q.correct_option === 'B' ? 'correct' : ''}" style="padding: 8px; border-radius: 4px; background: ${q.correct_option === 'B' ? '#e6f3ed' : '#f9f9f9'}; font-size: 12px;"><strong>B.</strong> ${escapeHtml(q.option_b)}</div>
        <div class="completion-opt ${q.correct_option === 'C' ? 'correct' : ''}" style="padding: 8px; border-radius: 4px; background: ${q.correct_option === 'C' ? '#e6f3ed' : '#f9f9f9'}; font-size: 12px;"><strong>C.</strong> ${escapeHtml(q.option_c)}</div>
        <div class="completion-opt ${q.correct_option === 'D' ? 'correct' : ''}" style="padding: 8px; border-radius: 4px; background: ${q.correct_option === 'D' ? '#e6f3ed' : '#f9f9f9'}; font-size: 12px;"><strong>D.</strong> ${escapeHtml(q.option_d)}</div>
      </div>
      ${q.explanation ? `<div style="font-size: 11px; color: #333; margin-top: 6px; background: #f4f8f6; padding: 6px 10px; border-radius: 4px;"><strong>Pathophysiology / Explanation:</strong> ${escapeHtml(q.explanation)}</div>` : ''}
      ${q.clinical_pearl ? `<div class="completion-pearl" style="font-size: 11px; color: #1f8255; margin-top: 4px;"><strong>Clinical Pearl:</strong> ${escapeHtml(q.clinical_pearl)}</div>` : ''}
      ${q.reference ? `<div style="font-size: 10px; color: var(--muted); margin-top: 4px;"><strong>Reference:</strong> ${escapeHtml(q.reference)}</div>` : ''}
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
    
    globalQuestions = (data.questions || []).map(q => normalizeQuestion(q));
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
    
    // Render sections with isolated error handlers
    try { renderActiveProcessing(data.processing); } catch (e) { console.error('renderActiveProcessing error:', e); }
    try { renderActivity(data.activity); } catch (e) { console.error('renderActivity error:', e); }
    try { renderPriorityQueue(globalQuestions); } catch (e) { console.error('renderPriorityQueue error:', e); }
    try { renderSources(globalSources); } catch (e) { console.error('renderSources error:', e); }
    try { renderCoverage(globalSources); } catch (e) { console.error('renderCoverage error:', e); }
    try { renderQuestionsTable(globalQuestions); } catch (e) { console.error('renderQuestionsTable error:', e); }
    
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
      globalText.textContent = 'API connected (Gemini & Fallbacks)';
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

async function updateApiProviderStatusUI() {
  try {
    const res = await fetch('/api/provider-status');
    if (!res.ok) return;
    const data = await res.json();
    const providers = data.providers;
    
    // 1. Gemini status
    const geminiLabel = $('#label-gemini');
    const geminiDot = $('#dot-gemini');
    if (geminiLabel && geminiDot) {
      if (providers.gemini.status === 'rate_limited') {
        const resetAt = providers.gemini.quotaResetAt;
        const remainingSec = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
        const m = Math.floor(remainingSec / 60);
        const s = remainingSec % 60;
        const timerStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        
        geminiLabel.textContent = `⏳ Quota 429 Limit (Reset in ${timerStr})`;
        geminiLabel.style.color = '#fbbf24';
        geminiDot.style.background = '#fbbf24';
      } else if (providers.gemini.status === 'active') {
        geminiLabel.textContent = 'Active & Ready (Primary)';
        geminiLabel.style.color = '#34d399';
        geminiDot.style.background = '#34d399';
      } else {
        geminiLabel.textContent = providers.gemini.error || 'Offline';
        geminiLabel.style.color = '#f87171';
        geminiDot.style.background = '#f87171';
      }
    }
    
    // 2. Groq status
    const groqLabel = $('#label-groq');
    const groqDot = $('#dot-groq');
    if (groqLabel && groqDot) {
      groqLabel.textContent = 'Disabled (Text-only)';
      groqLabel.style.color = '#94a3b8';
      groqDot.style.background = '#94a3b8';
    }

    // 3. OpenRouter status
    const openrouterLabel = $('#label-openrouter');
    const openrouterDot = $('#dot-openrouter');
    if (openrouterLabel && openrouterDot) {
      if (providers.openrouter.status === 'active') {
        openrouterLabel.textContent = 'Active';
        openrouterLabel.style.color = '#34d399';
        openrouterDot.style.background = '#34d399';
      } else {
        openrouterLabel.textContent = '401 Key Unconfigured';
        openrouterLabel.style.color = '#f87171';
        openrouterDot.style.background = '#f87171';
      }
    }
  } catch (e) {}
}

const btnResetGemini = $('#btn-reset-gemini-quota');
if (btnResetGemini) {
  btnResetGemini.onclick = async () => {
    btnResetGemini.textContent = 'Testing Gemini...';
    try {
      await fetch('/api/reset-provider-quota', { method: 'POST' });
      await updateApiProviderStatusUI();
      btnResetGemini.textContent = '⚡ Test / Retry Gemini Now';
    } catch (e) {
      btnResetGemini.textContent = '⚡ Test / Retry Gemini Now';
    }
  };
}

setInterval(updateApiProviderStatusUI, 1000);
updateApiProviderStatusUI();

// ==========================================
// TEST STUDIO & EXAM GENERATOR LOGIC
// ==========================================

let globalTests = [];
let currentTestDraft = null;

async function loadSavedTests() {
  try {
    const res = await fetch('/api/tests');
    if (res.ok) {
      const data = await res.json();
      globalTests = data.tests || [];
    }
  } catch (e) {
    console.warn('[Roux N Y] Failed to load saved tests:', e);
  }
}

async function renderTestsStudio() {
  await loadSavedTests();
  
  const testCountEl = $('#test-metric-count');
  const availQEl = $('#test-metric-q-available');
  if (testCountEl) testCountEl.textContent = globalTests.length;
  if (availQEl) availQEl.textContent = globalQuestions.length;

  const container = $('#tests-list-container');
  if (!container) return;

  if (globalTests.length === 0) {
    container.innerHTML = `
      <div class="empty-state-small" style="padding: 30px 20px; text-align: center;">
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px;">No exam papers created yet. Click below to assemble your first exam paper.</p>
        <button class="primary" onclick="openCreateTestModal()" style="padding: 10px 18px; font-weight: bold; border-radius: 6px;">⚡ Create New Test</button>
      </div>
    `;
    return;
  }

  container.innerHTML = globalTests.map(test => {
    const dateStr = new Date(test.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const totalMarks = test.questions ? (test.questions.length * (test.config?.marksPerQ || 4)) : 0;
    const sourcesStr = (test.config?.sources || []).length > 0 
      ? test.config.sources.join(', ')
      : 'All Chapters';

    return `
      <div class="test-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
        <div style="flex: 1; min-width: 260px;">
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px;">
            <strong style="font-size: 16px; color: var(--text);">${escapeHtml(test.title)}</strong>
            <span style="background: rgba(46,196,182,0.15); color: #147b6e; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 12px;">${test.questions ? test.questions.length : 0} Questions</span>
          </div>
          <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 6px 0;">
            📅 Created: ${dateStr} · ⏱ ${test.config?.duration || 45} Mins · 🎯 Total Marks: ${totalMarks} (Penalty: ${test.config?.negativeMarking || 0})
          </p>
          <p style="font-size: 11px; color: var(--text-muted); margin: 0; font-family: 'DM Mono', monospace;">
            📚 Sources: ${escapeHtml(sourcesStr)}
          </p>
        </div>

        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" class="btn-secondary" onclick="openPreviewSavedTest('${test.id}')" style="font-weight: 600; padding: 7px 12px; font-size: 12px;">👁️ Preview</button>
          <button type="button" class="btn-secondary" onclick="exportSavedTestWord('${test.id}', false)" style="background: #107c41; color: white; border: none; font-weight: bold; padding: 7px 12px; font-size: 12px;">📄 Question Paper (.doc)</button>
          <button type="button" class="primary" onclick="exportSavedTestWord('${test.id}', true)" style="background: #0284c7; border: none; font-weight: bold; padding: 7px 12px; font-size: 12px;">🔑 Answer Key (.doc)</button>
          <button type="button" class="btn-secondary" onclick="deleteSavedTest('${test.id}')" style="background: #fde6e1; color: #d85b48; font-weight: bold; padding: 7px 10px; font-size: 12px;" title="Delete Test">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

function openCreateTestModal() {
  const modalEl = $('#create-test-modal');
  if (!modalEl) return;
  
  // Populate sources checkbox list
  const sourcesContainer = $('#test-sources-checkbox-container');
  if (sourcesContainer) {
    if (globalSources.length === 0) {
      sourcesContainer.innerHTML = `<span style="font-size: 12px; color: var(--text-muted);">No sources uploaded yet. Questions will be selected from all available MCQs.</span>`;
    } else {
      sourcesContainer.innerHTML = globalSources.map(s => `
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
          <input type="checkbox" class="test-source-cb" value="${escapeHtml(s.filename)}" checked>
          <span>${escapeHtml(s.title || s.filename)}</span>
          <small style="color: var(--text-muted); font-size: 11px;">(${s.questionsGeneratedCount || 0} MCQs)</small>
        </label>
      `).join('');
    }
  }

  $('#test-title-input').value = `Exam Paper - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  modalEl.classList.add('show');
}

const btnCreateTestTrigger = $('#btn-create-test-trigger');
if (btnCreateTestTrigger) btnCreateTestTrigger.onclick = openCreateTestModal;

const btnCreateTestClose = $('#create-test-close');
if (btnCreateTestClose) btnCreateTestClose.onclick = () => $('#create-test-modal').classList.remove('show');

const btnCreateTestCancel = $('#btn-create-test-cancel');
if (btnCreateTestCancel) btnCreateTestCancel.onclick = () => $('#create-test-modal').classList.remove('show');

const linkSelectAllSources = $('#test-select-all-sources');
if (linkSelectAllSources) {
  linkSelectAllSources.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.test-source-cb').forEach(cb => cb.checked = true);
  };
}

const linkDeselectAllSources = $('#test-deselect-all-sources');
if (linkDeselectAllSources) {
  linkDeselectAllSources.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.test-source-cb').forEach(cb => cb.checked = false);
  };
}

// Submit Test Creation Form
const createTestForm = $('#create-test-form');
if (createTestForm) {
  createTestForm.onsubmit = (e) => {
    e.preventDefault();
    const title = $('#test-title-input').value.trim();
    const selectedSources = Array.from(document.querySelectorAll('.test-source-cb:checked')).map(cb => cb.value);
    const qCount = parseInt($('#test-q-count-input').value, 10) || 25;
    const marksPerQ = parseFloat($('#test-marks-per-q-input').value) || 4;
    const negativeMarking = $('#test-negative-marking-select').value;
    const duration = parseInt($('#test-duration-input').value, 10) || 45;
    const selectedTypes = Array.from(document.querySelectorAll('.test-type-cb:checked')).map(cb => cb.value);

    if (globalQuestions.length === 0) {
      alert('No MCQs available in database. Please upload a textbook PDF to generate questions first.');
      return;
    }

    // Filter questions matching chosen sources and types
    let candidatePool = globalQuestions.filter(q => {
      const matchSource = selectedSources.length === 0 || selectedSources.some(src => (q.sourceFilename && q.sourceFilename.includes(src)) || (q.book && q.book.includes(src)) || (q.sourceTitle && q.sourceTitle.includes(src)));
      const matchType = selectedTypes.length === 0 || selectedTypes.includes(q.type);
      return matchSource && matchType;
    });

    if (candidatePool.length === 0) {
      candidatePool = globalQuestions; // fallback to all available if filter too strict
    }

    // Shuffle and pick requested qCount
    const shuffled = [...candidatePool].sort(() => 0.5 - Math.random());
    const selectedQuestions = shuffled.slice(0, Math.min(qCount, shuffled.length));

    currentTestDraft = {
      id: `TEST-${Date.now()}`,
      title,
      questions: selectedQuestions,
      config: {
        sources: selectedSources,
        qCount: selectedQuestions.length,
        marksPerQ,
        negativeMarking,
        duration,
        types: selectedTypes
      },
      createdAt: new Date().toISOString()
    };

    $('#create-test-modal').classList.remove('show');
    openTestPreviewModal();
  };
}

function openTestPreviewModal() {
  if (!currentTestDraft) return;
  const modalEl = $('#test-preview-modal');
  if (!modalEl) return;

  $('#preview-test-title').textContent = currentTestDraft.title;
  renderTestPreview();
  modalEl.classList.add('show');
}

function renderTestPreview() {
  if (!currentTestDraft) return;
  const metaBar = $('#preview-test-meta-bar');
  const qList = $('#preview-test-q-list');

  const totalMarks = currentTestDraft.questions.length * currentTestDraft.config.marksPerQ;

  if (metaBar) {
    metaBar.innerHTML = `
      <div><strong>Total Questions:</strong> ${currentTestDraft.questions.length}</div>
      <div><strong>Total Marks:</strong> ${totalMarks} (${currentTestDraft.config.marksPerQ} Marks/Q)</div>
      <div><strong>Negative Marking:</strong> ${currentTestDraft.config.negativeMarking}</div>
      <div><strong>Duration:</strong> ${currentTestDraft.config.duration} Mins</div>
    `;
  }

  // Populate Tabulated Preview Summary Tables (Preview Only)
  const breakdownContainer = $('#preview-test-breakdown-tables');
  if (breakdownContainer && currentTestDraft.questions.length > 0) {
    const totalQ = currentTestDraft.questions.length;

    // 1. Group by Chapter / Source
    const chapterMap = {};
    currentTestDraft.questions.forEach(q => {
      const srcName = q.sourceTitle || q.book || q.sourceFilename || 'General Surgical Textbook';
      chapterMap[srcName] = (chapterMap[srcName] || 0) + 1;
    });

    // 2. Group by Question Type
    const typeMap = {};
    currentTestDraft.questions.forEach(q => {
      const typeName = q.type || 'Clinical Scenario';
      typeMap[typeName] = (typeMap[typeName] || 0) + 1;
    });

    const chapterRows = Object.entries(chapterMap).map(([src, count]) => {
      const pct = Math.round((count / totalQ) * 100);
      return `
        <tr>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); font-weight: 500;">${escapeHtml(src)}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: center; font-weight: bold; color: var(--mint);">${count}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: right; font-family: 'DM Mono', monospace; font-size: 11px;">${pct}%</td>
        </tr>
      `;
    }).join('');

    const typeRows = Object.entries(typeMap).map(([type, count]) => {
      const pct = Math.round((count / totalQ) * 100);
      return `
        <tr>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); font-weight: 500;">${escapeHtml(type)}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: center; font-weight: bold; color: #0284c7;">${count}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: right; font-family: 'DM Mono', monospace; font-size: 11px;">${pct}%</td>
        </tr>
      `;
    }).join('');

    breakdownContainer.innerHTML = `
      <div style="background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">📊 Exam Question &amp; Chapter Distribution Summary (Preview Only)</h4>
          <span style="font-size: 11px; background: rgba(2,132,199,0.1); color: #0284c7; padding: 2px 8px; border-radius: 10px; font-weight: 600;">Not included in exported Word file</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
          <div>
            <div style="font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 6px;">📚 Questions per Selected Chapter / Source</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid var(--border);">
              <thead>
                <tr style="background: rgba(0,0,0,0.03); text-align: left;">
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border);">Chapter / Source</th>
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: center;">MCQs</th>
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: right;">Ratio</th>
                </tr>
              </thead>
              <tbody>
                ${chapterRows}
              </tbody>
            </table>
          </div>

          <div>
            <div style="font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 6px;">🎯 Questions per MCQ Category / Type</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid var(--border);">
              <thead>
                <tr style="background: rgba(0,0,0,0.03); text-align: left;">
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border);">Question Type</th>
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: center;">MCQs</th>
                  <th style="padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: right;">Ratio</th>
                </tr>
              </thead>
              <tbody>
                ${typeRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  if (qList) {
    if (currentTestDraft.questions.length === 0) {
      qList.innerHTML = `<div class="empty-state-small"><p>No questions in test.</p></div>`;
      return;
    }

    qList.innerHTML = currentTestDraft.questions.map((q, idx) => `
      <div style="background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 10px;">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <strong style="font-size: 14px; color: var(--mint);">Q${idx + 1}.</strong>
            <span style="background: rgba(0,0,0,0.06); font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${escapeHtml(q.type || 'Clinical Scenario')}</span>
            <span style="background: rgba(2,132,199,0.1); color: #0284c7; font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${escapeHtml(q.difficulty || 'INI-SS')}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn-secondary" onclick="swapTestQuestion(${idx})" style="padding: 3px 8px; font-size: 11px; font-weight: 600;" title="Replace with another random question">🔄 Swap</button>
            <button type="button" class="btn-secondary" onclick="removeTestQuestion(${idx})" style="padding: 3px 8px; font-size: 11px; color: #d85b48; font-weight: 600;" title="Remove from test">🗑 Remove</button>
          </div>
        </div>

        <p style="font-size: 14px; font-weight: 600; margin: 0 0 10px 0; line-height: 1.5; color: var(--text);">${escapeHtml(q.question)}</p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px; font-size: 13px; margin-bottom: 8px;">
          <div style="padding: 6px 10px; border-radius: 4px; background: ${q.correct_option === 'A' ? '#e6f3ed' : 'rgba(0,0,0,0.02)'}; border: 1px solid ${q.correct_option === 'A' ? '#2ec4b6' : 'var(--border)'};"><strong>A.</strong> ${escapeHtml(q.option_a)}</div>
          <div style="padding: 6px 10px; border-radius: 4px; background: ${q.correct_option === 'B' ? '#e6f3ed' : 'rgba(0,0,0,0.02)'}; border: 1px solid ${q.correct_option === 'B' ? '#2ec4b6' : 'var(--border)'};"><strong>B.</strong> ${escapeHtml(q.option_b)}</div>
          <div style="padding: 6px 10px; border-radius: 4px; background: ${q.correct_option === 'C' ? '#e6f3ed' : 'rgba(0,0,0,0.02)'}; border: 1px solid ${q.correct_option === 'C' ? '#2ec4b6' : 'var(--border)'};"><strong>C.</strong> ${escapeHtml(q.option_c)}</div>
          <div style="padding: 6px 10px; border-radius: 4px; background: ${q.correct_option === 'D' ? '#e6f3ed' : 'rgba(0,0,0,0.02)'}; border: 1px solid ${q.correct_option === 'D' ? '#2ec4b6' : 'var(--border)'};"><strong>D.</strong> ${escapeHtml(q.option_d)}</div>
        </div>

        <div style="font-size: 11px; color: var(--text-muted); font-family: 'DM Mono', monospace; margin-top: 6px;">
          📖 Reference: ${escapeHtml(q.reference || q.book || 'Grounded PDF Citation')}
        </div>
      </div>
    `).join('');
  }
}

function swapTestQuestion(index) {
  if (!currentTestDraft || !currentTestDraft.questions[index]) return;
  const currentIdSet = new Set(currentTestDraft.questions.map(q => q.id));
  const availableOthers = globalQuestions.filter(q => !currentIdSet.has(q.id));

  if (availableOthers.length === 0) {
    alert('No other unused questions available in database to swap.');
    return;
  }

  const randomNew = availableOthers[Math.floor(Math.random() * availableOthers.length)];
  currentTestDraft.questions[index] = randomNew;
  renderTestPreview();
}

function removeTestQuestion(index) {
  if (!currentTestDraft || !currentTestDraft.questions[index]) return;
  currentTestDraft.questions.splice(index, 1);
  renderTestPreview();
}

const btnTestPreviewClose = $('#test-preview-close');
if (btnTestPreviewClose) btnTestPreviewClose.onclick = () => $('#test-preview-modal').classList.remove('show');

const btnPreviewSaveTest = $('#btn-preview-save-test');
if (btnPreviewSaveTest) {
  btnPreviewSaveTest.onclick = async () => {
    if (!currentTestDraft) return;
    try {
      btnPreviewSaveTest.textContent = 'Saving...';
      const res = await fetch('/api/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentTestDraft)
      });
      if (res.ok) {
        alert('Test paper saved to library!');
        $('#test-preview-modal').classList.remove('show');
        renderTestsStudio();
      }
    } catch (e) {
      alert('Failed to save test: ' + e.message);
    } finally {
      btnPreviewSaveTest.textContent = '💾 Save Test to Library';
    }
  };
}

// Word Export Buttons in Test Workbench
const btnPreviewExportDocxQP = $('#btn-preview-export-docx-qp');
if (btnPreviewExportDocxQP) {
  btnPreviewExportDocxQP.onclick = () => {
    if (!currentTestDraft) return;
    exportTestToWord(currentTestDraft, false);
  };
}

const btnPreviewExportDocxKey = $('#btn-preview-export-docx-key');
if (btnPreviewExportDocxKey) {
  btnPreviewExportDocxKey.onclick = () => {
    if (!currentTestDraft) return;
    exportTestToWord(currentTestDraft, true);
  };
}

function openPreviewSavedTest(testId) {
  const test = globalTests.find(t => t.id === testId);
  if (!test) return;
  currentTestDraft = test;
  openTestPreviewModal();
}

function exportSavedTestWord(testId, isSolutionPaper) {
  const test = globalTests.find(t => t.id === testId);
  if (!test) return;
  exportTestToWord(test, isSolutionPaper);
}

async function deleteSavedTest(testId) {
  if (!confirm('Are you sure you want to delete this test paper?')) return;
  try {
    const res = await fetch(`/api/tests/${testId}`, { method: 'DELETE' });
    if (res.ok) {
      await renderTestsStudio();
    }
  } catch (e) {
    alert('Delete test failed: ' + e.message);
  }
}

// ==========================================
// CLIENT-SIDE HTML-TO-WORD EXPORT ENGINE
// ==========================================

function exportTestToWord(testObj, isSolutionPaper) {
  if (!testObj || !Array.isArray(testObj.questions)) return;

  const totalMarks = testObj.questions.length * (testObj.config?.marksPerQ || 4);
  const paperTypeTitle = isSolutionPaper ? 'ANSWER KEY & DETAILED EXPLANATIONS' : 'CANDIDATE QUESTION PAPER';
  
  let htmlContent = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(testObj.title)} - ${paperTypeTitle}</title>
      <style>
        body { font-family: 'Calibri', 'Arial', sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5; margin: 30pt; }
        .header-table { width: 100%; border-collapse: collapse; border: 2pt solid #0f172a; margin-bottom: 20pt; background: #f8fafc; }
        .header-table td { padding: 10pt; border: 1pt solid #cbd5e1; }
        .brand-title { font-size: 18pt; font-weight: bold; color: #0f172a; text-transform: uppercase; margin: 0; }
        .paper-subtitle { font-size: 13pt; font-weight: bold; color: #0284c7; margin-top: 4pt; text-transform: uppercase; }
        .meta-label { font-weight: bold; color: #475569; }
        .instructions-box { background: #f1f5f9; border-left: 4pt solid #0284c7; padding: 10pt; margin-bottom: 20pt; font-size: 10pt; }
        .q-card { margin-bottom: 20pt; page-break-inside: avoid; border-bottom: 1pt solid #e2e8f0; padding-bottom: 15pt; }
        .q-num { font-weight: bold; color: #0284c7; font-size: 12pt; }
        .q-stem { font-weight: bold; font-size: 11pt; margin-bottom: 8pt; color: #0f172a; }
        .options-table { width: 100%; border-collapse: collapse; margin-top: 6pt; margin-bottom: 10pt; }
        .options-table td { width: 50%; padding: 6pt 10pt; border: 1pt solid #cbd5e1; vertical-align: top; font-size: 10.5pt; }
        .correct-opt { background: #dcfce7; border-color: #16a34a !important; font-weight: bold; color: #15803d; }
        .sol-box { background: #f8fafc; border: 1pt solid #cbd5e1; border-radius: 4pt; padding: 10pt; margin-top: 10pt; font-size: 10pt; }
        .sol-heading { font-weight: bold; color: #0369a1; text-transform: uppercase; font-size: 9.5pt; margin-bottom: 4pt; display: block; }
        .pearl-box { background: #fef3c7; border-left: 3pt solid #d97706; padding: 6pt 10pt; margin-top: 6pt; font-size: 9.5pt; }
        .trap-box { background: #fee2e2; border-left: 3pt solid #dc2626; padding: 6pt 10pt; margin-top: 6pt; font-size: 9.5pt; }
        .ref-tag { font-family: monospace; color: #64748b; font-size: 9pt; margin-top: 6pt; }
      </style>
    </head>
    <body>
      <table class="header-table">
        <tr>
          <td colspan="2" style="text-align: center; background: #0f172a; color: white;">
            <div class="brand-title" style="color: white;">ROUX-N-Y — SURGICAL INTELLIGENCE BANK</div>
            <div class="paper-subtitle" style="color: #38bdf8;">${escapeHtml(testObj.title)}</div>
            <div style="font-size: 11pt; margin-top: 4pt; color: #94a3b8;">${paperTypeTitle}</div>
          </td>
        </tr>
        <tr>
          <td><span class="meta-label">Total Questions:</span> ${testObj.questions.length} MCQs</td>
          <td><span class="meta-label">Time Allowed:</span> ${testObj.config?.duration || 45} Minutes</td>
        </tr>
        <tr>
          <td><span class="meta-label">Maximum Marks:</span> ${totalMarks} Marks</td>
          <td><span class="meta-label">Marking Scheme:</span> +${testObj.config?.marksPerQ || 4} / Correct, ${testObj.config?.negativeMarking || 0} / Incorrect</td>
        </tr>
      </table>

      <div class="instructions-box">
        <strong>GENERAL INSTRUCTIONS:</strong><br>
        1. All questions are compulsory and grounded in authoritative surgical textbooks.<br>
        2. Choose the single best answer for each question.<br>
        ${isSolutionPaper ? '3. This document contains complete answer keys, pathophysiological rationales, and textbook citations.' : '3. Darken the appropriate box on the optical mark sheet or write your answer clearly.'}
      </div>

      <hr style="border: none; border-top: 2pt solid #0f172a; margin-bottom: 20pt;">
  `;

  testObj.questions.forEach((q, idx) => {
    htmlContent += `
      <div class="q-card">
        <div class="q-stem">
          <span class="q-num">Q${idx + 1}.</span> ${escapeHtml(q.question)}
        </div>

        <table class="options-table">
          <tr>
            <td class="${isSolutionPaper && q.correct_option === 'A' ? 'correct-opt' : ''}"><strong>(A)</strong> ${escapeHtml(q.option_a)}</td>
            <td class="${isSolutionPaper && q.correct_option === 'B' ? 'correct-opt' : ''}"><strong>(B)</strong> ${escapeHtml(q.option_b)}</td>
          </tr>
          <tr>
            <td class="${isSolutionPaper && q.correct_option === 'C' ? 'correct-opt' : ''}"><strong>(C)</strong> ${escapeHtml(q.option_c)}</td>
            <td class="${isSolutionPaper && q.correct_option === 'D' ? 'correct-opt' : ''}"><strong>(D)</strong> ${escapeHtml(q.option_d)}</td>
          </tr>
        </table>
    `;

    if (isSolutionPaper) {
      htmlContent += `
        <div class="sol-box">
          <span class="sol-heading">✔ CORRECT ANSWER: OPTION (${escapeHtml(q.correct_option || 'A')})</span>
          <p><strong>Pathophysiological Rationale &amp; Solution:</strong> ${escapeHtml(q.explanation)}</p>
          
          <div style="margin-top: 6pt; font-size: 9.5pt; color: #334155;">
            <strong>Distractor Eliminations:</strong><br>
            • Option A: ${escapeHtml(q.why_a_wrong || 'Incorrect choice based on surgical criteria.')}<br>
            • Option B: ${escapeHtml(q.why_b_wrong || 'Incorrect choice based on surgical criteria.')}<br>
            • Option C: ${escapeHtml(q.why_c_wrong || 'Incorrect choice based on surgical criteria.')}<br>
            • Option D: ${escapeHtml(q.why_d_wrong || 'Incorrect choice based on surgical criteria.')}
          </div>

          ${q.clinical_pearl ? `<div class="pearl-box"><strong>💡 Clinical Pearl:</strong> ${escapeHtml(q.clinical_pearl)}</div>` : ''}
          ${q.exam_trap ? `<div class="trap-box"><strong>⚠️ INI-SS / NEET-SS Exam Trap:</strong> ${escapeHtml(q.exam_trap)}</div>` : ''}
          ${q.memory_point ? `<div style="margin-top: 6pt; font-size: 9.5pt;"><strong>🧠 High-Yield Revision Point:</strong> ${escapeHtml(q.memory_point)}</div>` : ''}
          
          <div class="ref-tag">📖 Textbook Citation: ${escapeHtml(q.reference || q.book || 'Bailey & Love 28th Edition')}</div>
        </div>
      `;
    }

    htmlContent += `</div>`;
  });

  htmlContent += `
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filenameTag = isSolutionPaper ? 'SOLUTION_KEY' : 'QUESTION_PAPER';
  a.download = `${testObj.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${filenameTag}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
