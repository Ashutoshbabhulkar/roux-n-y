const $ = s => document.querySelector(s);
const modal = $('#modal'), input = $('#file-input'), start = $('#start-processing');
let selectedFile = null;
function openModal(){ modal.classList.add('show'); }
function closeModal(){ modal.classList.remove('show'); }
$('#upload-open').onclick = openModal; $('#hero-upload').onclick = openModal; $('#library-upload').onclick = openModal; $('#modal-close').onclick=closeModal;
modal.onclick=e=>{if(e.target===modal)closeModal()};
function formatBytes(bytes) { if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function selectFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { alert('Please select a PDF textbook.'); return; }
  selectedFile = file;
  $('.dropzone b').textContent = file.name;
  $('.dropzone small').textContent = `${formatBytes(file.size)} selected · ready for source-grounded processing`;
  start.disabled = false;
}
input.onchange=()=>selectFile(input.files[0]);
$('#dropzone').ondragover=e=>{e.preventDefault();$('.dropzone').style.background='#e6f3ed'};
$('#dropzone').ondragleave=()=>$('.dropzone').style.background='';
$('#dropzone').ondrop=e=>{e.preventDefault(); $('.dropzone').style.background=''; selectFile(e.dataTransfer.files[0]);};
start.onclick=async()=>{
  if (!selectedFile) return;
  start.disabled = true; start.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-filename': selectedFile.name }, body: selectedFile });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The source could not be uploaded.');
    await fetch(`/api/sources/${result.source.id}/start`, { method: 'POST' });
    closeModal(); selectedFile = null; input.value = ''; $('.dropzone b').textContent = 'Drop PDF here, or browse'; $('.dropzone small').textContent = 'PDF up to 2 GB · textbook images retained at 300 dpi';
    await loadDashboard();
  } catch (error) { alert(error.message); }
  finally { start.textContent = 'Start processing'; start.disabled = !selectedFile; }
};
document.querySelectorAll('.nav').forEach(link=>link.onclick=()=>show(link.dataset.view));
document.querySelectorAll('[data-view-link]').forEach(link=>link.onclick=()=>show(link.dataset.viewLink));
function show(id){document.querySelectorAll('.view').forEach(v=>v.classList.remove('visible'));$('#'+id).classList.add('visible');document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===id));const titles={dashboard:'Good morning, Dr. Mehta.',questions:'Question bank',library:'Source library',coverage:'Coverage audit',exports:'Exports'};$('#page-title').textContent=titles[id];window.scrollTo({top:0,behavior:'smooth'});}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function statusLabel(status) { return status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'In review'; }
function renderQuestions(questions) {
  const body = $('.question-table'); if (!body) return;
  const head = body.querySelector('.table-head'); body.replaceChildren(head);
  questions.forEach(question => {
    const row = document.createElement('div'); row.className = 'table-item';
    row.innerHTML = `<div><b>${escapeHtml(question.question)}</b><small>${escapeHtml(question.topic)} · ${escapeHtml(question.subtopic)}</small></div><div>Source-grounded<br><small>${escapeHtml(question.reference)}</small></div><div><span class="badge ${question.type.includes('IMAGE') ? 'image' : 'case'}">${escapeHtml(question.type)}</span></div><div><button class="status-action ${question.status === 'approved' ? 'approved' : question.status === 'rejected' ? 'rejected' : 'pending'}" data-question="${question.id}" data-status="${question.status}">● ${statusLabel(question.status)}</button></div>`;
    body.append(row);
  });
  body.querySelectorAll('.status-action').forEach(button => button.onclick = async () => {
    const next = button.dataset.status === 'approved' ? 'review' : 'approved';
    const response = await fetch(`/api/questions/${button.dataset.question}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) });
    if (response.ok) loadDashboard();
  });
}
function renderSources(sources) {
  const library = $('.library-grid'); if (!library || !sources.length) return;
  library.replaceChildren(...sources.map(source => {
    const card = document.createElement('article'); card.className = 'source-card';
    const percentage = source.status === 'processing' ? source.progress : source.status === 'queued' ? 0 : 100;
    card.innerHTML = `<div class="large-book">R</div><div><span class="${source.status === 'processing' ? 'pending' : 'approved'}">● ${escapeHtml(source.status)}</span><h3>${escapeHtml(source.title)}</h3><p>${formatBytes(source.bytes)} · SHA-256 recorded</p><div class="progress"><i style="width:${percentage}%"></i></div><small>${percentage}% processing complete</small></div>`;
    return card;
  }));
}
async function loadDashboard() {
  try {
    const response = await fetch('/api/dashboard'); if (!response.ok) throw new Error(); const data = await response.json();
    renderQuestions(data.questions); renderSources(data.sources);
    const queue = document.querySelector('.nav[data-view="questions"] b'); if (queue) queue.textContent = data.questions.filter(q => q.status === 'review').length;
    const reviewCount = document.querySelector('.metrics article:last-child strong'); if (reviewCount) reviewCount.textContent = data.questions.filter(q => q.status === 'review').length;
    if (data.processing) { const status = $('.status'); const title = $('.processing h3'); if (status) status.innerHTML = `<span class="pulse"></span> Processing source securely <strong>${data.processing.progress}%</strong>`; if (title) title.textContent = data.processing.title; }
  } catch { /* The designed static view remains available if the API is offline. */ }
}
loadDashboard();
