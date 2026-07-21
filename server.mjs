/** Roux N Y local application server. No third-party dependencies required. */
import { createServer } from 'node:http';
import { readFile, mkdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

process.on('uncaughtException', (err) => {
  console.error('[Roux N Y Server] Uncaught Exception caught (prevented crash):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Roux N Y Server] Unhandled Rejection caught (prevented crash):', reason);
});

// Load environment variables from .env file
try {
  const envPath = join(projectRoot, '.env');
  const envContent = await readFile(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
} catch (err) {
  // .env file might not exist, ignore
}

import { existsSync } from 'node:fs';

const config = JSON.parse((await readFile(join(projectRoot, 'storage.config.json'), 'utf8')).replace(/^\uFEFF/, ''));

function resolveStorageRoot() {
  if (process.env.STORAGE_ROOT) {
    return resolve(process.env.STORAGE_ROOT);
  }
  try {
    if (existsSync('/var/data')) return '/var/data';
    if (existsSync('/data')) return '/data';
  } catch (e) {}
  return config.storageRoot ? resolve(config.storageRoot) : join(projectRoot, 'storage');
}

const storageRoot = resolveStorageRoot();
const dataFile = join(storageRoot, 'roux-ny-data.json');
const port = Number(process.env.PORT || 4173);
const maxUploadBytes = 2 * 1024 * 1024 * 1024;

// Clean seed - no demo data
const seed = { sources: [], questions: [], activity: [] };

// Helper to parse page range (e.g. "1-5", "10", or blank for Full PDF)
function parsePageRange(rangeStr, maxPages) {
  const cleaned = (rangeStr || '').trim().toLowerCase();
  // If no page number input given, scan the FULL PDF!
  if (!cleaned || cleaned === 'all' || cleaned === 'full') {
    return { start: 1, end: maxPages };
  }
  const match = cleaned.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) {
    return { start: 1, end: maxPages };
  }
  let start = parseInt(match[1], 10);
  let requestedEnd = match[2] ? parseInt(match[2], 10) : start;
  
  if (isNaN(start) || start < 1) start = 1;
  if (start > maxPages) start = 1;
  if (isNaN(requestedEnd) || requestedEnd < start) requestedEnd = maxPages;
  
  const end = Math.min(requestedEnd, maxPages);
  return { start, end };
}

// Slices a PDF file and returns the sliced bytes
async function slicePdf(inputBuffer, rangeStr) {
  const srcDoc = await PDFDocument.load(inputBuffer);
  const maxPages = srcDoc.getPageCount();
  
  const { start, end } = parsePageRange(rangeStr, maxPages);
  
  const destDoc = await PDFDocument.create();
  const pageIndices = [];
  for (let i = start - 1; i <= end - 1; i++) {
    if (i >= 0 && i < maxPages) {
      pageIndices.push(i);
    }
  }
  
  if (pageIndices.length === 0) {
    throw new Error(`Requested page range (${start}-${end}) is outside document pages (1-${maxPages}).`);
  }
  
  const copiedPages = await destDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach(page => destDoc.addPage(page));
  
  const savedBytes = await destDoc.save();
  return {
    bytes: savedBytes,
    totalPages: maxPages,
    actualStart: start,
    actualEnd: end
  };
}

async function updateSourceProgress(sourceId, progress) {
  try {
    const data = await readData();
    const source = data.sources.find(s => s.id === sourceId);
    if (source) {
      source.progress = progress;
      source.updatedAt = new Date().toISOString();
      await writeData(data);
    }
  } catch (err) {
    console.warn('[Roux N Y] updateSourceProgress warning:', err.message);
  }
}

async function updateSourceProgressDetails(sourceId, details) {
  try {
    const data = await readData();
    const source = data.sources.find(s => s.id === sourceId);
    if (source) {
      Object.assign(source, details);
      source.updatedAt = new Date().toISOString();
      await writeData(data);
    }
  } catch (err) {
    console.warn('[Roux N Y] updateSourceProgressDetails warning:', err.message);
  }
}

async function callMultiProviderApiWithInstantFallback(prompt, base64Pdf, statusCallback) {
  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const openrouterKeys = (process.env.OPENROUTER_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const groqKeys = (process.env.GROQ_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);

  let lastError = 'No valid API keys configured.';

  const geminiModels = [
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-3.5-flash',
    'gemini-1.5-pro'
  ];

  const openrouterModels = [
    'google/gemini-2.0-flash-001',
    'google/gemini-2.0-flash-lite:free',
    'meta-llama/llama-3.3-70b-instruct:free'
  ];

  const groqModels = [
    'llama-3.3-70b-versatile',
    'mixtral-8x7b-32768'
  ];

  const geminiSchemaConfig = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { "type": "STRING", "description": "Type of surgical MCQ: One Liner, Clinical Scenario, Image Based, Case Cluster, Assertion Reason, Best Next Step, Most Appropriate Management, Most Likely Diagnosis, Operative Decision Making" },
          difficulty: { "type": "STRING", "description": "Difficulty: Moderate, Difficult, INI-SS, AIIMS MCh, Top 1%" },
          book: { "type": "STRING", "description": "Book name, e.g. Bailey & Love" },
          edition: { "type": "STRING", "description": "Edition name, e.g. 28th Edition" },
          chapter: { "type": "STRING", "description": "Chapter name and number" },
          topic: { "type": "STRING", "description": "Broad clinical topic" },
          subtopic: { "type": "STRING", "description": "Specific clinical subtopic" },
          page_number: { "type": "STRING", "description": "Direct page number from the PDF" },
          figure_number: { "type": "STRING", "description": "Figure citation or N/A" },
          table_number: { "type": "STRING", "description": "Table citation or N/A" },
          question: { "type": "STRING", "description": "Strictly grounded MCQ question text" },
          option_a: { "type": "STRING", "description": "Option A text" },
          option_b: { "type": "STRING", "description": "Option B text" },
          option_c: { "type": "STRING", "description": "Option C text" },
          option_d: { "type": "STRING", "description": "Option D text" },
          correct_option: { "type": "STRING", "description": "Single letter: A, B, C, or D" },
          explanation: { "type": "STRING", "description": "Core pathophysiology explanation of the correct choice" },
          why_a_wrong: { "type": "STRING", "description": "Why option A is wrong (or correct if it is the answer)" },
          why_b_wrong: { "type": "STRING", "description": "Why option B is wrong (or correct if it is the answer)" },
          why_c_wrong: { "type": "STRING", "description": "Why option C is wrong (or correct if it is the answer)" },
          why_d_wrong: { "type": "STRING", "description": "Why option D is wrong (or correct if it is the answer)" },
          clinical_pearl: { "type": "STRING", "description": "High yield takeaway pearl" },
          exam_trap: { "type": "STRING", "description": "Common distractor trick alerts" },
          memory_point: { "type": "STRING", "description": "Mnemonic or easy fact to remember" },
          reference: { "type": "STRING", "description": "Exact citation reference (e.g. Bailey & Love, 28th Edition, Chapter 74, Page 1224)" }
        },
        required: [
          "type", "difficulty", "book", "chapter", "topic", "question",
          "option_a", "option_b", "option_c", "option_d", "correct_option",
          "explanation", "why_a_wrong", "why_b_wrong", "why_c_wrong", "why_d_wrong",
          "clinical_pearl", "exam_trap", "memory_point", "reference"
        ]
      }
    }
  };

  // Run up to 2 passes across all configured keys & models
  for (let pass = 1; pass <= 2; pass++) {
    // 1. Direct Gemini API Keys
    for (let keyIdx = 0; keyIdx < geminiKeys.length; keyIdx++) {
      const apiKey = geminiKeys[keyIdx];
      for (const model of geminiModels) {
        try {
          const keyTag = geminiKeys.length > 1 ? ` (Key ${keyIdx + 1})` : '';
          if (statusCallback) statusCallback(`Calling Gemini Direct (${model}${keyTag})...`, model);
          console.log(`[Roux N Y] Calling Gemini Direct (${model}${keyTag})...`);
          
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inlineData: { mimeType: 'application/pdf', data: base64Pdf } }
                  ]
                }
              ],
              generationConfig: geminiSchemaConfig
            })
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              console.log(`[Roux N Y] Successfully generated response with Gemini ${model}`);
              return text;
            }
          } else if (res.status === 429) {
            lastError = `429 Rate Limited on Direct ${model}`;
            console.warn(`[Roux N Y] Rate limited on ${model}. Instantly switching to next candidate model...`);
            if (statusCallback) statusCallback(`Rate limited on ${model}. Instantly trying next model...`, model);
            // INSTANT FALLBACK: Do not sleep 60s, move immediately to next model
            continue;
          } else {
            const errText = await res.text();
            lastError = `Gemini ${model} (${res.status}): ${errText.slice(0, 100)}`;
            console.warn(`[Roux N Y] ${lastError}`);
            continue;
          }
        } catch (err) {
          lastError = `Gemini fetch error on ${model}: ${err.message}`;
          console.warn(`[Roux N Y] ${lastError}`);
          continue;
        }
      }
    }

    // 2. OpenRouter API
    for (const apiKey of openrouterKeys) {
      for (const model of openrouterModels) {
        try {
          if (statusCallback) statusCallback(`Calling OpenRouter (${model.split('/')[1] || model})...`, model);
          console.log(`[Roux N Y] Calling OpenRouter (${model})...`);
          
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://roux-n-y.onrender.com',
              'X-Title': 'Roux N Y',
              'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    {
                      type: 'image_url',
                      image_url: { url: `data:application/pdf;base64,${base64Pdf}` }
                    }
                  ]
                }
              ]
            })
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (text) {
              console.log(`[Roux N Y] Successfully generated response via OpenRouter (${model})`);
              return text;
            }
          } else {
            const errText = await res.text();
            lastError = `OpenRouter ${model} (${res.status}): ${errText.slice(0, 100)}`;
            console.warn(`[Roux N Y] ${lastError}`);
            continue;
          }
        } catch (err) {
          lastError = `OpenRouter error on ${model}: ${err.message}`;
          console.warn(`[Roux N Y] ${lastError}`);
          continue;
        }
      }
    }

    // 3. Groq API
    for (const apiKey of groqKeys) {
      for (const model of groqModels) {
        try {
          if (statusCallback) statusCallback(`Calling Groq Ultra-Fast AI (${model})...`, model);
          console.log(`[Roux N Y] Calling Groq API (${model})...`);
          
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: prompt
                }
              ],
              response_format: { type: 'json_object' }
            })
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (text) {
              console.log(`[Roux N Y] Successfully generated response via Groq (${model})`);
              return text;
            }
          } else {
            const errText = await res.text();
            lastError = `Groq ${model} (${res.status}): ${errText.slice(0, 100)}`;
            console.warn(`[Roux N Y] ${lastError}`);
            continue;
          }
        } catch (err) {
          lastError = `Groq error on ${model}: ${err.message}`;
          console.warn(`[Roux N Y] ${lastError}`);
          continue;
        }
      }
    }

    if (pass === 1) {
      if (statusCallback) statusCallback('Rate limits reached across models. Brief 6s pause before retrying...', 'rate-limit');
      await new Promise(r => setTimeout(r, 6000));
    }
  }

  throw new Error(`All fallback AI providers and models failed. Last error: ${lastError}`);
}

async function runProcessingPipeline(sourceId) {
  const pipelineStartedAt = new Date().toISOString();
  try {
    const data = await readData();
    const source = data.sources.find(s => s.id === sourceId);
    if (!source) return;
    
    const uploadsDir = join(storageRoot, config.directories.uploads);
    const filePath = join(uploadsDir, `${source.id}-${source.filename}`);
    
    const fileBytes = await readFile(filePath);
    const srcDoc = await PDFDocument.load(fileBytes);
    const totalDocPages = srcDoc.getPageCount();
    
    // Determine overall page range
    const { start: overallStart, end: overallEnd } = parsePageRange(source.pageRange, totalDocPages);
    
    const hasAnyKeys = !!process.env.GEMINI_API_KEY || !!process.env.OPENROUTER_API_KEY || !!process.env.GROQ_API_KEY;
    if (!hasAnyKeys) {
      throw new Error('No API keys configured. Please add GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY.');
    }
    
    // Batch into chunks of 5 pages per chunk for ultra-fast processing & progress updates
    const CHUNK_SIZE = 5;
    const chunks = [];
    for (let cStart = overallStart; cStart <= overallEnd; cStart += CHUNK_SIZE) {
      const cEnd = Math.min(cStart + CHUNK_SIZE - 1, overallEnd);
      chunks.push({ start: cStart, end: cEnd });
    }
    
    const totalSelectionPages = overallEnd - overallStart + 1;
    
    await updateSourceProgressDetails(sourceId, {
      status: 'processing',
      progress: 5,
      startedAt: pipelineStartedAt,
      statusMessage: `Analyzing PDF pages (${overallStart}-${overallEnd}) in ${chunks.length} chunk(s)...`,
      currentChunk: 0,
      totalChunks: chunks.length,
      chunkPageRange: `${overallStart}-${Math.min(overallStart + CHUNK_SIZE - 1, overallEnd)}`,
      questionsGeneratedCount: 0,
      processedPages: 0,
      totalPages: totalSelectionPages,
      activeModel: 'multi-provider'
    });
    
    console.log(`[Roux N Y] Processing source ${source.filename} (${overallStart}-${overallEnd}) in ${chunks.length} chunk(s)...`);
    
    const allGeneratedQuestions = [];
    
    for (let idx = 0; idx < chunks.length; idx++) {
      if (idx > 0) {
        await updateSourceProgressDetails(sourceId, {
          statusMessage: `Pausing 3s between chunks to optimize quota...`
        });
        await new Promise(r => setTimeout(r, 3000));
      }
      
      const chunk = chunks[idx];
      const chunkProgress = 5 + Math.round(((idx) / chunks.length) * 90);
      const processedPagesCount = Math.max(0, chunk.start - overallStart);
      
      await updateSourceProgressDetails(sourceId, {
        progress: chunkProgress,
        currentChunk: idx + 1,
        totalChunks: chunks.length,
        chunkPageRange: `${chunk.start}-${chunk.end}`,
        statusMessage: `Slicing pages ${chunk.start}–${chunk.end} (Chunk ${idx + 1}/${chunks.length})...`,
        questionsGeneratedCount: allGeneratedQuestions.length,
        processedPages: processedPagesCount
      });
      
      const sliceResult = await slicePdf(fileBytes, `${chunk.start}-${chunk.end}`);
      const base64Pdf = Buffer.from(sliceResult.bytes).toString('base64');
      const chunkPageCount = (chunk.end - chunk.start + 1);
      const targetMcqCount = Math.max(4, chunkPageCount * 4);
      
      const prompt = `You are an elite surgical education question setter for NEET-SS / INI-SS examinations.
Your objective is to generate at least ${targetMcqCount} publication-ready multiple choice questions (MCQs) (generating approximately 4 to 5 distinct, high-yield questions per page) strictly grounded in the attached PDF page slice.

CRITICAL RULES:
1. Grounding: You must construct questions, choices, and explanations strictly based on facts, clinical guidance, tables, or figures explicitly mentioned in the PDF. Do not invent any facts, data, or references.
2. If there are tables or figures in the PDF slice, try to base questions on them, citing the correct table_number or figure_number.
3. Provide option justifications: For each option A, B, C, and D, write a clear, concise sentence explaining why it is correct or incorrect based on the text.
4. Ensure the output strictly conforms to the JSON schema.`;

      let candidateText;
      for (let chunkAttempt = 1; chunkAttempt <= 3; chunkAttempt++) {
        try {
          candidateText = await callMultiProviderApiWithInstantFallback(
            prompt,
            base64Pdf,
            (msg, model) => {
              updateSourceProgressDetails(sourceId, {
                statusMessage: `[Chunk ${idx + 1}/${chunks.length} - p.${chunk.start}–${chunk.end}] ${msg}`,
                activeModel: model
              });
            }
          );
          break;
        } catch (chunkErr) {
          console.warn(`[Roux N Y] Chunk ${idx + 1}/${chunks.length} attempt ${chunkAttempt} failed: ${chunkErr.message}`);
          if (chunkAttempt < 3) {
            await updateSourceProgressDetails(sourceId, {
              statusMessage: `Chunk ${idx + 1}/${chunks.length} attempt ${chunkAttempt} failed. Retrying...`
            });
            await new Promise(r => setTimeout(r, 5000));
          } else {
            throw chunkErr;
          }
        }
      }
      
      if (candidateText) {
        let cleanText = candidateText.trim();
        cleanText = cleanText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try {
          const parsed = JSON.parse(cleanText);
          if (Array.isArray(parsed)) {
            allGeneratedQuestions.push(...parsed);
          } else if (parsed && Array.isArray(parsed.questions)) {
            allGeneratedQuestions.push(...parsed.questions);
          }
        } catch (parseErr) {
          console.warn(`[Roux N Y] Failed to parse JSON chunk ${idx + 1}: ${parseErr.message}`);
        }
      }

      const completedChunkProgress = 5 + Math.round(((idx + 1) / chunks.length) * 90);
      await updateSourceProgressDetails(sourceId, {
        progress: completedChunkProgress,
        questionsGeneratedCount: allGeneratedQuestions.length,
        processedPages: (chunk.end - overallStart + 1),
        statusMessage: `Chunk ${idx + 1}/${chunks.length} complete (${allGeneratedQuestions.length} MCQs generated so far)...`
      });
    }
    
    if (allGeneratedQuestions.length === 0) {
      throw new Error('No valid questions could be generated from the document.');
    }
    
    // Save all generated questions
    const finalData = await readData();
    const finalSource = finalData.sources.find(s => s.id === sourceId);
    if (!finalSource) return;
    
    const newQuestions = allGeneratedQuestions.map(q => ({
      ...q,
      correct_option: (q.correct_option || 'A').toUpperCase(),
      id: `Q-${Math.floor(2000 + Math.random() * 7000)}`,
      sourceId: finalSource.id,
      sourceTitle: finalSource.title || finalSource.filename,
      sourceFilename: finalSource.filename,
      status: 'review',
      createdAt: new Date().toISOString()
    }));
    
    finalData.questions.unshift(...newQuestions);
    
    const durationSec = Math.round((new Date().getTime() - new Date(pipelineStartedAt).getTime()) / 1000);
    const m = Math.floor(durationSec / 60);
    const s = Math.floor(durationSec % 60);
    const durStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    
    // Update source
    finalSource.status = 'ready';
    finalSource.progress = 100;
    finalSource.pages = totalDocPages;
    finalSource.latestGeneratedQuestionIds = newQuestions.map(q => q.id);
    finalSource.updatedAt = new Date().toISOString();
    finalSource.completedAt = new Date().toISOString();
    finalSource.totalProcessingDurationSec = durationSec;
    finalSource.questionsGeneratedCount = (finalSource.questionsGeneratedCount || 0) + newQuestions.length;
    finalSource.statusMessage = `Completed in ${durStr} · ${newQuestions.length} MCQs generated (${finalSource.questionsGeneratedCount} total)`;
    delete finalSource.error;
    
    // Log activity
    finalData.activity.unshift(
      {
        kind: 'approved',
        text: `Source processed`,
        detail: finalSource.filename,
        actor: 'AI',
        at: finalSource.updatedAt
      },
      {
        kind: 'new',
        text: `${newQuestions.length} questions generated`,
        detail: `${finalSource.title} (${overallStart}-${overallEnd})`,
        actor: 'AI',
        at: finalSource.updatedAt
      }
    );
    
    await writeData(finalData);
    
  } catch (error) {
    console.error('Error processing source in pipeline:', error);
    const finalData = await readData();
    const finalSource = finalData.sources.find(s => s.id === sourceId);
    if (finalSource) {
      finalSource.status = 'failed';
      finalSource.progress = 0;
      finalSource.error = error.message;
      finalSource.updatedAt = new Date().toISOString();
      finalData.activity.unshift({
        kind: 'rejected',
        text: `Processing failed`,
        detail: `${finalSource.filename}: ${error.message.slice(0, 100)}`,
        actor: 'AI',
        at: finalSource.updatedAt
      });
      await writeData(finalData);
    }
  }
}

async function syncToCloudStorage(data) {
  const gistId = process.env.GIST_ID;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!gistId || !ghToken) return;

  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Roux-N-Y-App',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          'roux-ny-data.json': {
            content: JSON.stringify(data, null, 2)
          }
        }
      })
    });
    if (res.ok) {
      console.log('[Roux N Y Cloud Sync] Data synced to free GitHub Gist cloud storage.');
    }
  } catch (err) {
    console.warn('[Roux N Y Cloud Sync] Sync warning:', err.message);
  }
}

async function hydrateFromCloudStorage() {
  const gistId = process.env.GIST_ID;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!gistId) return null;

  try {
    const headers = { 'User-Agent': 'Roux-N-Y-App' };
    if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;
    
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
    if (res.ok) {
      const gistData = await res.json();
      const fileObj = gistData.files && gistData.files['roux-ny-data.json'];
      if (fileObj && fileObj.content) {
        const parsed = JSON.parse(fileObj.content);
        if (parsed && Array.isArray(parsed.questions)) {
          console.log(`[Roux N Y Cloud Sync] Restored ${parsed.questions.length} MCQs & ${parsed.sources ? parsed.sources.length : 0} sources from GitHub Gist.`);
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[Roux N Y Cloud Sync] Hydration warning:', err.message);
  }
  return null;
}

let writeQueue = Promise.resolve();

async function writeData(data) {
  writeQueue = writeQueue.then(async () => {
    try {
      await mkdir(storageRoot, { recursive: true });
      const temp = `${dataFile}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
      await rename(temp, dataFile);
    } catch (err) {
      console.warn('[Roux N Y Storage] Atomic rename warning, falling back to direct write:', err.message);
      try {
        await writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
      } catch (directErr) {
        console.error('[Roux N Y Storage] Direct write error:', directErr.message);
      }
    }
    syncToCloudStorage(data).catch(() => {});
  }).catch(err => {
    console.error('[Roux N Y Storage] Write queue exception:', err.message);
  });
  return writeQueue;
}

async function ensureStorage() {
  await Promise.all(Object.values(config.directories).map(dir => mkdir(join(storageRoot, dir), { recursive: true })));
  try {
    const stats = await stat(dataFile);
    if (stats.size <= 50) {
      const cloudData = await hydrateFromCloudStorage();
      if (cloudData) await writeData(cloudData);
    }
  } catch {
    const cloudData = await hydrateFromCloudStorage();
    if (cloudData) {
      await writeData(cloudData);
    } else {
      await writeData(seed);
    }
  }
}

async function readData() {
  await ensureStorage();
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  if (Array.isArray(data.questions)) {
    data.questions.forEach(q => {
      if (!q.sourceTitle) {
        q.sourceTitle = q.book || 'Surgical Textbook';
      }
    });
  }
  return data;
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function safeFilename(value = 'source.pdf') {
  const filename = value.replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 180);
  return filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
}

async function body(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxUploadBytes) throw new Error('Upload exceeds the 2 GB limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function api(req, res, url) {
  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/dashboard') {
    const data = await readData();
    return send(res, 200, {
      ...data,
      processing: data.sources.find(source => source.status === 'processing')
    });
  }

  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/status') {
    return send(res, 200, {
      hasApiKey: !!process.env.GEMINI_API_KEY
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sources') {
    const filename = safeFilename(req.headers['x-filename'] || 'source.pdf');
    const pageRange = req.headers['x-page-range'] || '';
    const bytes = await body(req);
    if (!bytes.length || bytes.subarray(0, 4).toString() !== '%PDF') {
      return send(res, 400, { error: 'Please select a valid PDF file.' });
    }
    const id = randomUUID();
    const data = await readData();
    const destination = join(storageRoot, config.directories.uploads, `${id}-${filename}`);
    await writeFile(destination, bytes, { flag: 'wx' });
    
    const source = {
      id,
      filename,
      title: filename.replace(/\.pdf$/i, ''),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'queued',
      progress: 0,
      pages: null,
      pageRange: pageRange,
      createdAt: new Date().toISOString()
    };
    
    data.sources.unshift(source);
    data.activity.unshift({
      kind: 'new',
      text: 'New source uploaded',
      detail: filename,
      actor: 'AI',
      at: source.createdAt
    });
    await writeData(data);
    return send(res, 201, { source });
  }

  const startMatch = url.pathname.match(/^\/api\/sources\/([\w-]+)\/start$/);
  if (req.method === 'POST' && startMatch) {
    const data = await readData();
    const source = data.sources.find(item => item.id === startMatch[1]);
    if (!source) return send(res, 404, { error: 'Source not found.' });
    
    source.status = 'processing';
    source.progress = 5;
    source.updatedAt = new Date().toISOString();
    
    data.activity.unshift({
      kind: 'new',
      text: 'Source processing started',
      detail: source.filename,
      actor: 'AI',
      at: source.updatedAt
    });
    
    await writeData(data);
    
    // Trigger actual pipeline asynchronously
    runProcessingPipeline(source.id);
    
    return send(res, 200, { source });
  }

  const regenerateMatch = url.pathname.match(/^\/api\/sources\/([\w-]+)\/regenerate$/);
  if (req.method === 'POST' && regenerateMatch) {
    const sourceId = regenerateMatch[1];
    let customPageRange = '';
    try {
      const bData = await body(req);
      if (bData.length > 0) {
        const parsedBody = JSON.parse(bData.toString('utf8'));
        customPageRange = parsedBody.pageRange || '';
      }
    } catch (_) {}
    
    const data = await readData();
    const source = data.sources.find(item => item.id === sourceId);
    if (!source) return send(res, 404, { error: 'Source not found.' });
    
    source.status = 'processing';
    source.progress = 5;
    if (customPageRange) source.pageRange = customPageRange;
    source.updatedAt = new Date().toISOString();
    
    data.activity.unshift({
      kind: 'new',
      text: 'Regenerating MCQs from source',
      detail: `${source.filename} (${source.pageRange || 'Full PDF'})`,
      actor: 'AI',
      at: source.updatedAt
    });
    
    await writeData(data);
    
    // Trigger actual pipeline asynchronously
    runProcessingPipeline(source.id);
    
    return send(res, 200, { source });
  }

  const deleteSourceMatch = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
  if (req.method === 'DELETE' && deleteSourceMatch) {
    const sourceId = deleteSourceMatch[1];
    const deleteQuestions = url.searchParams.get('deleteQuestions') === 'true';
    const data = await readData();
    const sourceIndex = data.sources.findIndex(s => s.id === sourceId);
    if (sourceIndex === -1) {
      return send(res, 404, { error: 'Source not found.' });
    }
    const source = data.sources[sourceIndex];
    
    // Delete file from disk if exists
    try {
      const uploadsDir = join(storageRoot, config.directories.uploads);
      const filePath = join(uploadsDir, `${source.id}-${source.filename}`);
      await unlink(filePath).catch(() => {});
    } catch (err) {
      console.warn('Could not delete upload file:', err.message);
    }
    
    data.sources.splice(sourceIndex, 1);
    
    let deletedQCount = 0;
    if (deleteQuestions) {
      const initialQCount = data.questions.length;
      data.questions = data.questions.filter(q => q.sourceId !== sourceId && q.sourceTitle !== source.title);
      deletedQCount = initialQCount - data.questions.length;
    } else {
      // Keep MCQs in database but tag source as deleted
      data.questions.forEach(q => {
        if (q.sourceId === sourceId || q.sourceTitle === source.title) {
          q.sourceStatus = 'deleted';
        }
      });
    }
    
    data.activity.unshift({
      kind: 'rejected',
      text: `Source deleted${deleteQuestions ? ` (${deletedQCount} MCQs removed)` : ' (MCQs kept)'}`,
      detail: source.filename,
      actor: 'AB',
      at: new Date().toISOString()
    });
    
    await writeData(data);
    return send(res, 200, { success: true, deletedQuestions: deletedQCount });
  }

  if (req.method === 'POST' && url.pathname === '/api/questions/bulk-approve') {
    const { ids } = JSON.parse((await body(req)).toString('utf8'));
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(res, 400, { error: 'Invalid question IDs array.' });
    }
    const data = await readData();
    let updatedCount = 0;
    data.questions.forEach(q => {
      if (ids.includes(q.id)) {
        q.status = 'approved';
        q.updatedAt = new Date().toISOString();
        updatedCount++;
      }
    });
    data.activity.unshift({
      kind: 'approved',
      text: `${updatedCount} questions approved`,
      detail: `Bulk approval by Editor`,
      actor: 'DR',
      at: new Date().toISOString()
    });
    await writeData(data);
    return send(res, 200, { success: true, count: updatedCount });
  }

  if (req.method === 'POST' && url.pathname === '/api/questions/bulk-delete') {
    const { ids } = JSON.parse((await body(req)).toString('utf8'));
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(res, 400, { error: 'Invalid question IDs array.' });
    }
    const data = await readData();
    const initialCount = data.questions.length;
    data.questions = data.questions.filter(q => !ids.includes(q.id));
    const deletedCount = initialCount - data.questions.length;
    data.activity.unshift({
      kind: 'rejected',
      text: `${deletedCount} questions deleted`,
      detail: `Bulk delete action`,
      actor: 'DR',
      at: new Date().toISOString()
    });
    await writeData(data);
    return send(res, 200, { success: true, count: deletedCount });
  }

  const questionMatch = url.pathname.match(/^\/api\/questions\/([\w-]+)$/);
  if (req.method === 'DELETE' && questionMatch) {
    const data = await readData();
    const qId = questionMatch[1];
    const initialCount = data.questions.length;
    data.questions = data.questions.filter(item => item.id !== qId);
    if (data.questions.length < initialCount) {
      data.activity.unshift({
        kind: 'rejected',
        text: `${qId} deleted`,
        detail: `Single question deleted`,
        actor: 'AB',
        at: new Date().toISOString()
      });
      await writeData(data);
    }
    return send(res, 200, { success: true });
  }

  if (req.method === 'PATCH' && questionMatch) {
    const changes = JSON.parse((await body(req)).toString('utf8'));
    const data = await readData();
    const question = data.questions.find(item => item.id === questionMatch[1]);
    if (!question) return send(res, 404, { error: 'Question not found.' });

    if (changes.status && !['review', 'approved', 'rejected'].includes(changes.status)) {
      return send(res, 400, { error: 'Invalid editorial status.' });
    }

    // Apply status change and activity log
    if (changes.status && changes.status !== question.status) {
      question.status = changes.status;
      data.activity.unshift({
        kind: changes.status,
        text: `${question.id} ${changes.status}`,
        detail: question.subtopic || question.topic || '',
        actor: 'AB',
        at: new Date().toISOString()
      });
    }

    // Apply all editable fields
    const fields = [
      'question', 'type', 'difficulty', 'book', 'edition', 'chapter', 'topic', 'subtopic',
      'page_number', 'figure_number', 'table_number',
      'option_a', 'option_b', 'option_c', 'option_d', 'correct_option',
      'explanation', 'why_a_wrong', 'why_b_wrong', 'why_c_wrong', 'why_d_wrong',
      'clinical_pearl', 'exam_trap', 'memory_point', 'reference', 'marks'
    ];
    
    fields.forEach(field => {
      if (changes[field] !== undefined) {
        question[field] = changes[field];
      }
    });

    question.updatedAt = new Date().toISOString();
    await writeData(data);
    return send(res, 200, { question });
  }

  // Exports
  if (req.method === 'GET' && url.pathname === '/api/exports/csv') {
    const data = await readData();
    const headers = [
      'Question_ID', 'Book', 'Edition', 'Chapter', 'Topic', 'Subtopic', 
      'Page_Number', 'Figure_Number', 'Table_Number', 'Difficulty', 'Type', 
      'Question', 'Option_A', 'Option_B', 'Option_C', 'Option_D', 'Correct_Option', 
      'Explanation', 'Why_A_Wrong', 'Why_B_Wrong', 'Why_C_Wrong', 'Why_D_Wrong', 
      'Clinical_Pearl', 'Exam_Trap', 'Memory_Point', 'Reference', 'Marks'
    ];
    let csv = headers.join(',') + '\n';
    data.questions.forEach(q => {
      const row = [
        q.id,
        q.book || '',
        q.edition || '',
        q.chapter || '',
        q.topic || '',
        q.subtopic || '',
        q.page_number || '',
        q.figure_number || '',
        q.table_number || '',
        q.difficulty || '',
        q.type || '',
        q.question || '',
        q.option_a || '',
        q.option_b || '',
        q.option_c || '',
        q.option_d || '',
        q.correct_option || '',
        q.explanation || '',
        q.why_a_wrong || '',
        q.why_b_wrong || '',
        q.why_c_wrong || '',
        q.why_d_wrong || '',
        q.clinical_pearl || '',
        q.exam_trap || '',
        q.memory_point || '',
        q.reference || '',
        q.marks || '1'
      ].map(val => `"${val.toString().replace(/"/g, '""').replace(/\n/g, ' ')}"`).join(',');
      csv += row + '\n';
    });
    res.writeHead(200, { 
      'Content-Type': 'text/csv; charset=utf-8', 
      'Content-Disposition': 'attachment; filename="roux-ny-questions.csv"' 
    });
    return res.end(csv);
  }
  
  if (req.method === 'GET' && url.pathname === '/api/exports/json') {
    const data = await readData();
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8', 
      'Content-Disposition': 'attachment; filename="roux-ny-questions.json"' 
    });
    return res.end(JSON.stringify(data.questions, null, 2));
  }
  
  if (req.method === 'GET' && url.pathname === '/api/exports/sql') {
    const data = await readData();
    let sql = `-- Roux N Y MCQs SQL Export\n\n`;
    sql += `CREATE TABLE IF NOT EXISTS mcqs (\n` +
      `  id VARCHAR(50) PRIMARY KEY,\n` +
      `  book VARCHAR(100),\n` +
      `  edition VARCHAR(50),\n` +
      `  chapter VARCHAR(100),\n` +
      `  topic VARCHAR(100),\n` +
      `  subtopic VARCHAR(100),\n` +
      `  page_number VARCHAR(50),\n` +
      `  figure_number VARCHAR(50),\n` +
      `  table_number VARCHAR(50),\n` +
      `  difficulty VARCHAR(50),\n` +
      `  type VARCHAR(100),\n` +
      `  question TEXT,\n` +
      `  option_a TEXT,\n` +
      `  option_b TEXT,\n` +
      `  option_c TEXT,\n` +
      `  option_d TEXT,\n` +
      `  correct_option VARCHAR(5),\n` +
      `  explanation TEXT,\n` +
      `  why_a_wrong TEXT,\n` +
      `  why_b_wrong TEXT,\n` +
      `  why_c_wrong TEXT,\n` +
      `  why_d_wrong TEXT,\n` +
      `  clinical_pearl TEXT,\n` +
      `  exam_trap TEXT,\n` +
      `  memory_point TEXT,\n` +
      `  reference TEXT,\n` +
      `  marks INTEGER\n` +
      `);\n\n`;
    
    data.questions.forEach(q => {
      const escapeSql = (str) => str ? str.replace(/'/g, "''") : '';
      sql += `INSERT INTO mcqs (id, book, edition, chapter, topic, subtopic, page_number, figure_number, table_number, difficulty, type, question, option_a, option_b, option_c, option_d, correct_option, explanation, why_a_wrong, why_b_wrong, why_c_wrong, why_d_wrong, clinical_pearl, exam_trap, memory_point, reference, marks) VALUES (\n` +
        `  '${q.id}',\n` +
        `  '${escapeSql(q.book)}',\n` +
        `  '${escapeSql(q.edition)}',\n` +
        `  '${escapeSql(q.chapter)}',\n` +
        `  '${escapeSql(q.topic)}',\n` +
        `  '${escapeSql(q.subtopic)}',\n` +
        `  '${escapeSql(q.page_number)}',\n` +
        `  '${escapeSql(q.figure_number)}',\n` +
        `  '${escapeSql(q.table_number)}',\n` +
        `  '${escapeSql(q.difficulty)}',\n` +
        `  '${escapeSql(q.type)}',\n` +
        `  '${escapeSql(q.question)}',\n` +
        `  '${escapeSql(q.option_a)}',\n` +
        `  '${escapeSql(q.option_b)}',\n` +
        `  '${escapeSql(q.option_c)}',\n` +
        `  '${escapeSql(q.option_d)}',\n` +
        `  '${q.correct_option}',\n` +
        `  '${escapeSql(q.explanation)}',\n` +
        `  '${escapeSql(q.why_a_wrong)}',\n` +
        `  '${escapeSql(q.why_b_wrong)}',\n` +
        `  '${escapeSql(q.why_c_wrong)}',\n` +
        `  '${escapeSql(q.why_d_wrong)}',\n` +
        `  '${escapeSql(q.clinical_pearl)}',\n` +
        `  '${escapeSql(q.exam_trap)}',\n` +
        `  '${escapeSql(q.memory_point)}',\n` +
        `  '${escapeSql(q.reference)}',\n` +
        `  1\n` +
        `);\n`;
    });
    res.writeHead(200, { 
      'Content-Type': 'application/sql; charset=utf-8', 
      'Content-Disposition': 'attachment; filename="roux-ny-questions.sql"' 
    });
    return res.end(sql);
  }

  // Backup & Restore Database
  if (req.method === 'GET' && url.pathname === '/api/exports/backup') {
    const data = await readData();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename=roux-ny-db-backup-${Date.now()}.json`
    });
    return res.end(JSON.stringify(data, null, 2));
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/restore') {
    try {
      const raw = (await body(req)).toString('utf8');
      const restored = JSON.parse(raw);
      if (!restored || typeof restored !== 'object' || !Array.isArray(restored.questions) || !Array.isArray(restored.sources)) {
        return send(res, 400, { error: 'Invalid backup format. Must contain sources and questions.' });
      }
      await writeData(restored);
      return send(res, 200, { success: true, questionsCount: restored.questions.length, sourcesCount: restored.sources.length });
    } catch (err) {
      return send(res, 500, { error: 'Failed to restore database: ' + err.message });
    }
  }

  send(res, 404, { error: 'Route not found.' });
}

// Background processing loop (checks for queued sources and triggers processing)
setInterval(async () => {
  try {
    const data = await readData();
    const isProcessing = data.sources.some(s => s.status === 'processing');
    if (!isProcessing) {
      const nextQueued = [...data.sources].reverse().find(s => s.status === 'queued');
      if (nextQueued) {
        // Start processing asynchronously
        const updatedSources = data.sources.map(s => {
          if (s.id === nextQueued.id) {
            return {
              ...s,
              status: 'processing',
              progress: 5,
              updatedAt: new Date().toISOString()
            };
          }
          return s;
        });
        data.sources = updatedSources;
        data.activity.unshift({
          kind: 'new',
          text: 'Source processing started',
          detail: nextQueued.filename,
          actor: 'AI',
          at: new Date().toISOString()
        });
        await writeData(data);
        
        // Trigger actual pipeline asynchronously
        runProcessingPipeline(nextQueued.id);
      }
    }
  } catch (err) {
    console.error('Error in background source checker:', err);
  }
}, 3000);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const requested = resolve(projectRoot, `.${normalize(pathname)}`);
    if (!requested.startsWith(projectRoot)) return send(res, 403, { error: 'Forbidden' });
    const info = await stat(requested);
    if (!info.isFile()) throw new Error('Not found');
    res.writeHead(200, {
      'content-type': mime[extname(requested)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    createReadStream(requested).pipe(res);
  } catch (error) {
    send(res, error.message === 'Not found' ? 404 : 500, { error: error.message || 'Unexpected server error' });
  }
});

await ensureStorage();
server.listen(port, () => console.log(`Roux N Y is running at http://localhost:${port}`));
