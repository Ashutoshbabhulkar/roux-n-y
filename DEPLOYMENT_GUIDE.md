# Roux N Y - 100% Free Database Persistence & Cloud Sync Guide

Since Render's free tier does not support paid persistent disk attachments, we have implemented **two 100% free solutions** that require **0 dollars per month**!

---

## Solution 1: Built-In 1-Click Backup & Restore (UI - Instant & Zero Setup)

In the app under **Exports & Database Protection**:
1. **💾 Download Full DB Backup (.json):** Download a single `.json` file containing all your sources, generated MCQs, and editorial history.
2. **📥 Restore DB from Backup File:** Whenever Render restarts or redeploys, click this button to upload your backup file. All MCQs and sources are immediately restored to the live application!

---

## Solution 2: Automatic Background Cloud Sync via Free GitHub Gist (0 Cost & Fully Automatic)

You can connect a free GitHub Gist to auto-sync your database. Whenever an MCQ is generated or edited, it automatically updates your private GitHub Gist in the background. When Render restarts, the server auto-downloads the latest MCQs from your Gist!

### Setup Instructions (Takes 2 minutes):

1. **Create a Free Secret Gist:**
   - Go to [gist.github.com](https://gist.github.com).
   - Filename: `roux-ny-data.json`
   - Content: `{ "sources": [], "questions": [], "activity": [] }`
   - Click **Create Secret Gist** (or Public Gist).
   - Copy the Gist ID from the browser URL (e.g. `https://gist.github.com/username/` -> `a1b2c3d4e5f67890`).

2. **Generate a Free GitHub Token:**
   - Go to [GitHub Developer Settings -> Personal Access Tokens (Tokens classic)](https://github.com/settings/tokens).
   - Click **Generate new token (classic)**.
   - Select scope: `gist` (Create and update gists).
   - Copy the generated token string (`ghp_...`).

3. **Add to Render Environment Variables:**
   - Open your **Render Dashboard** -> Select `roux-n-y`.
   - Click **Environment** in the left sidebar.
   - Add Environment Variables:
     - `GIST_ID` = `YOUR_GIST_ID_HERE`
     - `GITHUB_TOKEN` = `YOUR_GITHUB_TOKEN_HERE`
   - Click **Save Changes**.

---

### Results:
- **0 cost permanently.**
- All MCQs & sources auto-save to cloud storage.
- Restores automatically on every Render restart!
