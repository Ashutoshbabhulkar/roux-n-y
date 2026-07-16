const $ = s => document.querySelector(s);
const modal = $('#modal'), input = $('#file-input'), start = $('#start-processing');
function openModal(){ modal.classList.add('show'); }
function closeModal(){ modal.classList.remove('show'); }
$('#upload-open').onclick = openModal; $('#hero-upload').onclick = openModal; $('#library-upload').onclick = openModal; $('#modal-close').onclick=closeModal;
modal.onclick=e=>{if(e.target===modal)closeModal()};
input.onchange=()=>{if(input.files.length){ $('.dropzone b').textContent=input.files[0].name; $('.dropzone small').textContent='PDF selected · ready for source-grounded processing'; start.disabled=false; }};
$('#dropzone').ondragover=e=>{e.preventDefault();$('.dropzone').style.background='#e6f3ed'};
$('#dropzone').ondragleave=()=>$('.dropzone').style.background='';
$('#dropzone').ondrop=e=>{e.preventDefault(); $('.dropzone').style.background=''; if(e.dataTransfer.files[0]){$('.dropzone b').textContent=e.dataTransfer.files[0].name; $('.dropzone small').textContent='PDF selected · ready for source-grounded processing';start.disabled=false}};
start.onclick=()=>{closeModal(); alert('Source added to the secure processing queue.');};
document.querySelectorAll('.nav').forEach(link=>link.onclick=()=>show(link.dataset.view));
document.querySelectorAll('[data-view-link]').forEach(link=>link.onclick=()=>show(link.dataset.viewLink));
function show(id){document.querySelectorAll('.view').forEach(v=>v.classList.remove('visible'));$('#'+id).classList.add('visible');document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===id));const titles={dashboard:'Good morning, Dr. Mehta.',questions:'Question bank',library:'Source library',coverage:'Coverage audit',exports:'Exports'};$('#page-title').textContent=titles[id];window.scrollTo({top:0,behavior:'smooth'});}
