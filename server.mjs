/** Roux N Y local application server. No third-party dependencies required. */
import { createServer } from 'node:http';
import { readFile, mkdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

async function extractTextFromPdfBuffer(pdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) return '';
  try {
    const pdfLib = require('pdf-parse');
    if (typeof pdfLib === 'function') {
      const parsed = await pdfLib(pdfBuffer);
      return parsed && parsed.text ? parsed.text.trim() : '';
    }
    if (pdfLib && pdfLib.PDFParse) {
      const parser = new pdfLib.PDFParse(new Uint8Array(pdfBuffer));
      const res = await parser.getText();
      if (typeof res === 'string') return res.trim();
      if (res && res.text) return res.text.trim();
      if (res && Array.isArray(res.pages)) {
        return res.pages.map(p => p.text || '').join('\n').trim();
      }
    }
  } catch (e) {
    console.warn('[Roux N Y] PDF text extraction notice:', e.message);
  }
  return '';
}

const apiProviderStatus = {
  gemini: {
    name: 'Gemini Direct (Google AI)',
    status: 'active',
    error: null,
    quotaResetAt: null,
    lastUsedAt: null
  },
  openrouter: {
    name: 'OpenRouter',
    status: (process.env.OPENROUTER_API_KEY || '').trim() ? 'active' : 'unconfigured',
    error: (process.env.OPENROUTER_API_KEY || '').trim() ? null : '401 Key Unconfigured in Render',
    quotaResetAt: null,
    lastUsedAt: null
  },
  groq: {
    name: 'Groq Ultra-Fast (Llama 3.3 70B)',
    status: (process.env.GROQ_API_KEY || '').trim() ? 'active' : 'unconfigured',
    error: (process.env.GROQ_API_KEY || '').trim() ? null : 'Key Unconfigured',
    quotaResetAt: null,
    lastUsedAt: null
  }
};

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

const systemLogs = [];
function logSys(level, msg) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] [${level.toUpperCase()}] ${msg}`;
  systemLogs.unshift(entry);
  if (systemLogs.length > 120) systemLogs.pop();
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

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

async function fetchWithHardTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`API request timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function callMultiProviderApiWithInstantFallback(prompt, base64Pdf, extractedText, statusCallback) {
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
    'openai/gpt-4o-mini',
    'anthropic/claude-3.5-haiku'
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

  const fullPromptForTextModel = extractedText && extractedText.length > 50
    ? `${prompt}\n\n--- EXACT EXTRACTED TEXTBOOK CHAPTER PAGES FOR GROUNDING ---\n${extractedText.slice(0, 16000)}\n--- END TEXTBOOK CONTENT ---`
    : prompt;

  // Run up to 2 passes across all configured keys & models
  for (let pass = 1; pass <= 2; pass++) {
    // 1. Direct Gemini API Keys (Only if not rate limited or if reset timer passed)
    const now = Date.now();
    if (!apiProviderStatus.gemini.quotaResetAt || now >= apiProviderStatus.gemini.quotaResetAt) {
      for (let keyIdx = 0; keyIdx < geminiKeys.length; keyIdx++) {
        const apiKey = geminiKeys[keyIdx];
        for (const model of geminiModels) {
          try {
            const keyTag = geminiKeys.length > 1 ? ` (Key ${keyIdx + 1})` : '';
            if (statusCallback) statusCallback(`Calling Gemini Direct (${model}${keyTag})...`, model);
            logSys('info', `Calling Gemini Direct (${model}${keyTag})...`);
            
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetchWithHardTimeout(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
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
            }, 15000);

            if (res.ok) {
              const data = await res.json();
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                apiProviderStatus.gemini.status = 'active';
                apiProviderStatus.gemini.error = null;
                apiProviderStatus.gemini.quotaResetAt = null;
                logSys('info', `Successfully generated response with Gemini ${model}`);
                return text;
              }
            } else {
              const errText = await res.text();
              lastError = `Gemini ${model} (${res.status}): ${errText.slice(0, 100)}`;
              logSys('warn', lastError);
              
              if (res.status === 402 || res.status === 403 || res.status === 429 || errText.toLowerCase().includes('quota') || errText.toLowerCase().includes('billing') || errText.toLowerCase().includes('payment') || errText.toLowerCase().includes('exceeded')) {
                apiProviderStatus.gemini.status = 'rate_limited';
                apiProviderStatus.gemini.error = `429 Quota Exceeded (${model})`;
                apiProviderStatus.gemini.quotaResetAt = Date.now() + 60000; // 60s countdown
                logSys('warn', `Payment/Quota/Billing error on Gemini (${res.status}). Instantly switching provider...`);
                if (statusCallback) statusCallback(`Quota/Billing limit on Gemini (429). Switching to Groq...`, model);
                break; // Jump to next provider immediately
              }
              continue;
            }
          } catch (err) {
            lastError = `Gemini fetch error on ${model}: ${err.message}`;
            logSys('warn', lastError);
            continue;
          }
        }
      }
    }

    // 2. OpenRouter API
    for (const apiKey of openrouterKeys) {
      for (const model of openrouterModels) {
        try {
          if (statusCallback) statusCallback(`Calling OpenRouter (${model.split('/')[1] || model})...`, model);
          logSys('info', `Calling OpenRouter (${model})...`);
          
          const res = await fetchWithHardTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://roux-n-y.onrender.com',
              'X-Title': 'Roux N Y',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: fullPromptForTextModel
                }
              ]
            })
          }, 15000);

          if (res.ok) {
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (text) {
              apiProviderStatus.openrouter.status = 'active';
              apiProviderStatus.openrouter.error = null;
              logSys('info', `Successfully generated response via OpenRouter (${model})`);
              return text;
            }
          } else {
            const errText = await res.text();
            lastError = `OpenRouter ${model} (${res.status}): ${errText.slice(0, 100)}`;
            logSys('warn', lastError);
            if (res.status === 401) {
              apiProviderStatus.openrouter.status = 'unconfigured';
              apiProviderStatus.openrouter.error = '401 Invalid Key';
            }
            if (res.status === 402 || res.status === 403 || res.status === 429 || errText.toLowerCase().includes('credit') || errText.toLowerCase().includes('balance') || errText.toLowerCase().includes('quota')) {
              logSys('warn', `Payment/Quota error on OpenRouter (${res.status}). Instantly switching provider...`);
              if (statusCallback) statusCallback(`Quota/Billing limit on OpenRouter. Switching to Groq...`, model);
              break; // Jump to Groq immediately
            }
            continue;
          }
        } catch (err) {
          lastError = `OpenRouter error on ${model}: ${err.message}`;
          logSys('warn', lastError);
          continue;
        }
      }
    }

    // 3. Groq API
    for (const apiKey of groqKeys) {
      for (const model of groqModels) {
        try {
          if (statusCallback) statusCallback(`Calling Groq Ultra-Fast AI (${model})...`, model);
          logSys('info', `Calling Groq API (${model})...`);
          
          const res = await fetchWithHardTimeout('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: fullPromptForTextModel
                }
              ],
              response_format: { type: 'json_object' }
            })
          }, 15000);

          if (res.ok) {
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (text) {
              apiProviderStatus.groq.status = 'active';
              apiProviderStatus.groq.error = null;
              logSys('info', `Successfully generated response via Groq (${model})`);
              return text;
            }
          } else {
            const errText = await res.text();
            lastError = `Groq ${model} (${res.status}): ${errText.slice(0, 100)}`;
            logSys('warn', lastError);
            if (res.status === 402 || res.status === 403 || res.status === 429 || errText.toLowerCase().includes('rate') || errText.toLowerCase().includes('quota')) {
              logSys('warn', `Quota/Rate limit on Groq (${res.status}). Instantly trying next candidate...`);
              if (statusCallback) statusCallback(`Quota limit on Groq (${model}). Trying next...`, model);
              break;
            }
            continue;
          }
        } catch (err) {
          lastError = `Groq error on ${model}: ${err.message}`;
          logSys('warn', lastError);
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
      const sliceBuffer = Buffer.from(sliceResult.bytes);
      const base64Pdf = sliceBuffer.toString('base64');
      
      const extractedText = await extractTextFromPdfBuffer(sliceBuffer);

      const chunkPageCount = (chunk.end - chunk.start + 1);
      const targetMcqCount = Math.max(4, chunkPageCount * 4);
      
      const prompt = `You are an elite surgical education question setter for NEET-SS / INI-SS examinations.
Your objective is to generate exactly ${targetMcqCount} publication-ready multiple choice questions (MCQs) (approximately 4 to 5 distinct, high-yield questions per page) strictly grounded in the surgical textbook content provided.

CRITICAL QUALITY RULES:
1. ABSOLUTELY NO GENERIC PLACEHOLDERS: Do NOT use generic terms like "Condition X", "Table 1", "Grounded in surgical text", "Option A unavailable", "Treatment Y". You MUST use actual disease names, surgical procedures, anatomical terms, and clinical facts explicitly found in the text.
2. ABSOLUTE GROUNDING: Every question, option, explanation, and clinical pearl MUST be directly derived from the textbook content.
3. OPTIONS: Provide 4 distinct, meaningful options (option_a, option_b, option_c, option_d) containing actual surgical procedures, diagnostic criteria, or anatomical choices.
4. EXPLANATION & CLINICAL PEARL:
   - "explanation": Provide a comprehensive 2-3 sentence pathophysiology and clinical rationale explaining why the correct choice is right and others are wrong.
   - "clinical_pearl": Provide a high-yield, exam-focused takeaway summarizing key surgical guidelines or diagnostic rules from the text.
   - "reference": Cite exact book, chapter, and page/figure numbers (e.g. "Bailey & Love, 28th Edition, Chapter 6, p. ${chunk.start}").
5. Conform strictly to JSON schema format.`;

      let candidateText;
      for (let chunkAttempt = 1; chunkAttempt <= 3; chunkAttempt++) {
        try {
          candidateText = await callMultiProviderApiWithInstantFallback(
            prompt,
            base64Pdf,
            extractedText,
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
    
    const newQuestions = allGeneratedQuestions.map(rawQ => {
      const q = normalizeQuestion(rawQ);
      return {
        ...q,
        id: `Q-${Math.floor(2000 + Math.random() * 7000)}`,
        sourceId: finalSource.id,
        sourceTitle: finalSource.title || finalSource.filename,
        sourceFilename: finalSource.filename,
        status: 'review',
        createdAt: new Date().toISOString()
      };
    });
    
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

async function readData() {
  await ensureStorage();
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  if (Array.isArray(data.sources)) {
    data.sources.forEach(s => {
      if (!s.title) {
        s.title = s.filename ? s.filename.replace(/\.pdf$/i, '') : 'Surgical Textbook';
      }
    });
  }
  if (Array.isArray(data.questions)) {
    data.questions = data.questions.map(q => {
      const nq = normalizeQuestion(q);
      if (!nq.sourceTitle) {
        nq.sourceTitle = nq.book || 'Surgical Textbook';
      }
      return nq;
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

  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/provider-status') {
    const now = Date.now();
    if (apiProviderStatus.gemini.quotaResetAt && now >= apiProviderStatus.gemini.quotaResetAt) {
      apiProviderStatus.gemini.status = 'active';
      apiProviderStatus.gemini.error = null;
      apiProviderStatus.gemini.quotaResetAt = null;
    }
    return send(res, 200, {
      providers: apiProviderStatus,
      activeProvider: apiProviderStatus.gemini.status === 'active' ? 'Gemini 2.0 Direct' : 'Groq Llama 3.3 (Fallback)'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset-provider-quota') {
    apiProviderStatus.gemini.status = 'active';
    apiProviderStatus.gemini.error = null;
    apiProviderStatus.gemini.quotaResetAt = null;
    logSys('info', 'Manual reset triggered for Gemini API Quota flag.');
    return send(res, 200, { success: true, message: 'Gemini Quota reset.' });
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function filterQuestionsByQuery(questions, searchParams) {
  let list = [...questions];
  const idsStr = searchParams.get('ids');
  if (idsStr) {
    const idSet = new Set(idsStr.split(',').map(s => s.trim()).filter(Boolean));
    list = list.filter(q => idSet.has(q.id));
  }
  const sourceId = searchParams.get('sourceId');
  if (sourceId && sourceId !== 'all') {
    list = list.filter(q => q.sourceId === sourceId || q.sourceTitle === sourceId || q.book === sourceId);
  }
  const chapter = searchParams.get('chapter');
  if (chapter && chapter !== 'all') {
    const cLower = chapter.toLowerCase();
    list = list.filter(q => (q.chapter && q.chapter.toLowerCase().includes(cLower)) || (q.topic && q.topic.toLowerCase().includes(cLower)));
  }
  const status = searchParams.get('status');
  if (status && status !== 'all') {
    list = list.filter(q => q.status === status);
  }
  return list;
}

  // Exports
  if (req.method === 'GET' && (url.pathname === '/api/exports/docx' || url.pathname === '/api/exports/doc')) {
    const data = await readData();
    const questions = filterQuestionsByQuery(data.questions || [], url.searchParams);
    
    let html = `<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns:m="http://schemas.microsoft.com/office/2004/12/omml"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<meta name="Originator" content="Microsoft Word 15">
<title>Roux N Y MCQs Word Export</title>
<!--[if gte mso 9]><xml>
 <o:DocumentProperties>
  <o:Author>Dr. Ashutosh Babhulkar</o:Author>
  <o:Title>Roux N Y MCQs</o:Title>
 </o:DocumentProperties>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForCustomXSL/>
 </w:WordDocument>
</xml><![endif]-->
<style>
@page WordSection1 {
  size: 595.3pt 841.9pt;
  margin: 0.8in 0.8in 0.8in 0.8in;
  mso-header-margin: 35.4pt;
  mso-footer-margin: 35.4pt;
  mso-paper-source: 0;
}
div.WordSection1 {
  page: WordSection1;
}
body {
  font-family: Arial, sans-serif;
  font-size: 10pt;
  color: #000000;
  line-height: 1.35;
}
br.page-break {
  page-break-before: always;
  mso-break-type: page-break;
}
table.mcq-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 20px;
  mso-table-lspace: 0pt;
  mso-table-rspace: 0pt;
}
table.mcq-table td {
  border: 1.0pt solid windowtext;
  padding: 6pt 8pt;
  vertical-align: top;
  font-size: 9.5pt;
}
.lbl {
  width: 14%;
  font-weight: normal;
}
.sol-heading {
  font-weight: bold;
  margin-top: 8pt;
  margin-bottom: 3pt;
  font-size: 9.5pt;
}
</style>
</head>
<body>
<div class="WordSection1">`;

    questions.forEach((q, index) => {
      const correctOpt = (q.correct_option || 'A').toUpperCase().trim();
      const optAText = q.option_a || '';
      const optBText = q.option_b || '';
      const optCText = q.option_c || '';
      const optDText = q.option_d || '';
      
      let answerText = '';
      if (correctOpt === 'A') answerText = `A. ${optAText}`;
      else if (correctOpt === 'B') answerText = `B. ${optBText}`;
      else if (correctOpt === 'C') answerText = `C. ${optCText}`;
      else if (correctOpt === 'D') answerText = `D. ${optDText}`;
      else answerText = `${correctOpt}. ${optAText}`;

      const whyWrongArr = [];
      if (correctOpt !== 'A' && q.why_a_wrong) whyWrongArr.push(`A. ${q.why_a_wrong}`);
      if (correctOpt !== 'B' && q.why_b_wrong) whyWrongArr.push(`B. ${q.why_b_wrong}`);
      if (correctOpt !== 'C' && q.why_c_wrong) whyWrongArr.push(`C. ${q.why_c_wrong}`);
      if (correctOpt !== 'D' && q.why_d_wrong) whyWrongArr.push(`D. ${q.why_d_wrong}`);

      const sourcePdfName = q.sourceTitle || q.book || 'Bailey and Love\'s Short Practice of Surgery 28th Edition(1).pdf';

      if (index > 0) {
        html += `<br class="page-break" style="page-break-before: always; mso-break-type: page-break;" />`;
      }

      html += `<table class="mcq-table">
  <tr>
    <td class="lbl">Question</td>
    <td colspan="2">${escapeHtml(q.question || '')}</td>
  </tr>
  <tr>
    <td class="lbl">Type</td>
    <td colspan="2">multiple_choice</td>
  </tr>
  <tr>
    <td class="lbl">Option</td>
    <td>A. ${escapeHtml(optAText)}</td>
    <td style="width: 15%;">${correctOpt === 'A' ? 'correct' : 'incorrect'}</td>
  </tr>
  <tr>
    <td class="lbl">Option</td>
    <td>B. ${escapeHtml(optBText)}</td>
    <td style="width: 15%;">${correctOpt === 'B' ? 'correct' : 'incorrect'}</td>
  </tr>
  <tr>
    <td class="lbl">Option</td>
    <td>C. ${escapeHtml(optCText)}</td>
    <td style="width: 15%;">${correctOpt === 'C' ? 'correct' : 'incorrect'}</td>
  </tr>
  <tr>
    <td class="lbl">Option</td>
    <td>D. ${escapeHtml(optDText)}</td>
    <td style="width: 15%;">${correctOpt === 'D' ? 'correct' : 'incorrect'}</td>
  </tr>
  <tr>
    <td class="lbl">Solution</td>
    <td colspan="2">
      <div>Answer: ${escapeHtml(answerText)}</div>
      
      <div class="sol-heading">Explanation</div>
      <div>${escapeHtml(q.explanation || '')}</div>
      
      ${whyWrongArr.length > 0 ? `<div class="sol-heading">Why the Other Options are Incorrect</div>${whyWrongArr.map(w => `<div>${escapeHtml(w)}</div>`).join('')}` : ''}
      
      ${q.clinical_pearl ? `<div class="sol-heading">NEET SS High-Yield Pearl</div><div>${escapeHtml(q.clinical_pearl)}</div>` : ''}
      
      <div class="sol-heading">References</div>
      <div>${escapeHtml(q.reference || (q.book ? `${q.book}, ${q.edition || ''}, ${q.chapter || ''}` : 'Bailey & Love’s Short Practice of Surgery, 28th Edition'))}</div>
      <div>${escapeHtml(sourcePdfName)}</div>
    </td>
  </tr>
  <tr>
    <td class="lbl">Marks</td>
    <td>1</td>
    <td>0</td>
  </tr>
</table>`;
    });

    html += `</div></body></html>`;

    res.writeHead(200, {
      'Content-Type': 'application/msword; charset=utf-8',
      'Content-Disposition': 'attachment; filename="roux-ny-mcqs-tabulated.doc"'
    });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/exports/csv') {
    const data = await readData();
    const questions = filterQuestionsByQuery(data.questions || [], url.searchParams);
    const headers = [
      'Question_ID', 'Book', 'Edition', 'Chapter', 'Topic', 'Subtopic', 
      'Page_Number', 'Figure_Number', 'Table_Number', 'Difficulty', 'Type', 
      'Question', 'Option_A', 'Option_B', 'Option_C', 'Option_D', 'Correct_Option', 
      'Explanation', 'Why_A_Wrong', 'Why_B_Wrong', 'Why_C_Wrong', 'Why_D_Wrong', 
      'Clinical_Pearl', 'Exam_Trap', 'Memory_Point', 'Reference', 'Marks'
    ];
    let csv = headers.join(',') + '\n';
    questions.forEach(q => {
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
    const questions = filterQuestionsByQuery(data.questions || [], url.searchParams);
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8', 
      'Content-Disposition': 'attachment; filename="roux-ny-questions.json"' 
    });
    return res.end(JSON.stringify(questions, null, 2));
  }
  
  if (req.method === 'GET' && url.pathname === '/api/exports/sql') {
    const data = await readData();
    const questions = filterQuestionsByQuery(data.questions || [], url.searchParams);
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
    
    questions.forEach(q => {
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

  if (req.method === 'GET' && url.pathname === '/api/admin/logs') {
    return send(res, 200, { logs: systemLogs });
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
