/** Roux N Y local application server. No third-party dependencies required. */
import { createServer } from 'node:http';
import { readFile, mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const config = JSON.parse((await readFile(join(projectRoot, 'storage.config.json'), 'utf8')).replace(/^\uFEFF/, ''));
const storageRoot = config.storageRoot;
const dataFile = join(storageRoot, 'roux-ny-data.json');
const port = Number(process.env.PORT || 4173);
const maxUploadBytes = 2 * 1024 * 1024 * 1024;
const seed = { sources: [], questions: [
  { id: 'Q-2481', type: 'IMAGE BASED', topic: 'Vascular surgery', subtopic: 'Aortic aneurysm', question: 'Following endovascular repair, this CT finding most strongly suggests a type II endoleak?', reference: 'Figure 26.14 · Page 356', difficulty: 'INI-SS', status: 'review', createdAt: '2026-07-16T06:15:00.000Z' },
  { id: 'Q-2478', type: 'CASE CLUSTER', topic: 'Vascular surgery', subtopic: 'Peripheral arterial disease', question: 'A 64-year-old with rest pain and a tissue-loss lesion has this angiographic pattern...', reference: 'Table 26.8 · Page 349', difficulty: 'Top 1%', status: 'review', createdAt: '2026-07-16T06:03:00.000Z' }
], activity: [
  { kind: 'approved', text: 'Q-2471 approved', detail: 'Acute mesenteric ischaemia', actor: 'AM', at: '2026-07-16T06:25:00.000Z' },
  { kind: 'flag', text: 'Figure crop flagged', detail: 'Page 341 · requires edge review', actor: 'RK', at: '2026-07-16T06:16:00.000Z' }
] };

async function writeData(data) { await mkdir(storageRoot, { recursive: true }); const temp = `${dataFile}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2), 'utf8'); await rename(temp, dataFile); }
async function ensureStorage() { await Promise.all(Object.values(config.directories).map(dir => mkdir(join(storageRoot, dir), { recursive: true }))); try { await stat(dataFile); } catch { await writeData(seed); } }
async function readData() { await ensureStorage(); return JSON.parse(await readFile(dataFile, 'utf8')); }
function send(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }
function safeFilename(value = 'source.pdf') { const filename = value.replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 180); return filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`; }
async function body(req) { const chunks = []; let total = 0; for await (const chunk of req) { total += chunk.length; if (total > maxUploadBytes) throw new Error('Upload exceeds the 2 GB limit.'); chunks.push(chunk); } return Buffer.concat(chunks); }
async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/dashboard') { const data = await readData(); return send(res, 200, { ...data, processing: data.sources.find(source => source.status === 'processing') }); }
  if (req.method === 'POST' && url.pathname === '/api/sources') {
    const filename = safeFilename(req.headers['x-filename'] || 'source.pdf'); const bytes = await body(req);
    if (!bytes.length || bytes.subarray(0, 4).toString() !== '%PDF') return send(res, 400, { error: 'Please select a valid PDF file.' });
    const id = randomUUID(); const data = await readData(); const destination = join(storageRoot, config.directories.uploads, `${id}-${filename}`); await writeFile(destination, bytes, { flag: 'wx' });
    const source = { id, filename, title: filename.replace(/\.pdf$/i, ''), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'queued', progress: 0, pages: null, createdAt: new Date().toISOString() };
    data.sources.unshift(source); data.activity.unshift({ kind: 'new', text: 'New source uploaded', detail: filename, actor: 'AI', at: source.createdAt }); await writeData(data); return send(res, 201, { source });
  }
  const startMatch = url.pathname.match(/^\/api\/sources\/([\w-]+)\/start$/);
  if (req.method === 'POST' && startMatch) { const data = await readData(); const source = data.sources.find(item => item.id === startMatch[1]); if (!source) return send(res, 404, { error: 'Source not found.' }); source.status = 'processing'; source.progress = Math.max(source.progress, 8); source.updatedAt = new Date().toISOString(); data.activity.unshift({ kind: 'new', text: 'Source processing started', detail: source.filename, actor: 'AI', at: source.updatedAt }); await writeData(data); return send(res, 200, { source }); }
  const questionMatch = url.pathname.match(/^\/api\/questions\/(Q-\d+)$/);
  if (req.method === 'PATCH' && questionMatch) { const changes = JSON.parse((await body(req)).toString('utf8')); const data = await readData(); const question = data.questions.find(item => item.id === questionMatch[1]); if (!question) return send(res, 404, { error: 'Question not found.' }); if (!['review', 'approved', 'rejected'].includes(changes.status)) return send(res, 400, { error: 'Invalid editorial status.' }); question.status = changes.status; question.updatedAt = new Date().toISOString(); data.activity.unshift({ kind: changes.status, text: `${question.id} ${changes.status}`, detail: question.subtopic, actor: 'DR', at: question.updatedAt }); await writeData(data); return send(res, 200, { question }); }
  send(res, 404, { error: 'Route not found.' });
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) return await api(req, res, url); const pathname = url.pathname === '/' ? '/index.html' : url.pathname; const requested = resolve(projectRoot, `.${normalize(pathname)}`); if (!requested.startsWith(projectRoot)) return send(res, 403, { error: 'Forbidden' }); const info = await stat(requested); if (!info.isFile()) throw new Error('Not found'); res.writeHead(200, { 'content-type': mime[extname(requested)] || 'application/octet-stream', 'cache-control': 'no-cache' }); createReadStream(requested).pipe(res); } catch (error) { send(res, error.message === 'Not found' ? 404 : 500, { error: error.message || 'Unexpected server error' }); } });
await ensureStorage(); server.listen(port, () => console.log(`Roux N Y is running at http://localhost:${port}`));
