import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

async function testFetchWithRetry() {
  const envContent = await readFile(join(projectRoot, '.env'), 'utf8').catch(() => '');
  const apiKey = envContent.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!apiKey) return;

  const candidateModels = [
    'gemini-3-flash-preview',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest'
  ];

  for (const m of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Trying ${m} (Attempt ${attempt}/3)...`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Respond with JSON array [{"status": "ok"}]' }] }] })
        });
        if (res.ok) {
          console.log(`SUCCESS with model ${m} on attempt ${attempt}!`);
          success = true;
          break;
        } else if (res.status === 429) {
          console.warn(`429 Rate limited on ${m}, waiting 3s before retry...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.warn(`${m} returned status ${res.status}: ${(await res.text()).slice(0, 100)}`);
          break; // move to next model if 404 or other 4xx
        }
      } catch (err) {
        console.warn(`${m} attempt ${attempt} failed: ${err.message}. Retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (success) break;
  }
}
testFetchWithRetry();
