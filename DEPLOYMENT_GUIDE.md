# Roux N Y - Database Persistence & Deployment Guide

## 1. Why Data Disappears on Free Cloud Hosting (Render)
By default, free cloud instances (like Render Free Tier) use **ephemeral container disks**. When the server:
- Spins down after inactivity
- Auto-redeploys a new Git commit
- Restarts after a crash

...the local container directory (`/opt/render/project/src/storage`) is recreated from scratch, causing locally generated MCQs to reset to initial state.

---

## 2. Permanent Fixes Implemented in Code

### A. Auto-Detection of Render Persistent Disks (`/var/data` / `/data`)
The application server (`server.mjs`) automatically checks for persistent cloud mounts:
- If `/var/data` exists, data is stored in `/var/data/roux-ny-data.json`.
- If `/data` exists, data is stored in `/data/roux-ny-data.json`.
- If `STORAGE_ROOT` environment variable is defined in Render, it writes to that folder.

### B. Built-In 1-Click Database Backup & Restore (UI)
In the app under **Exports & Database Protection**:
1. **💾 Download Full DB Backup (.json):** Downloads a complete JSON snapshot of all generated MCQs, sources, and editorial logs.
2. **📥 Restore DB from Backup File:** One-click upload to restore all MCQs and sources anytime!

---

## 3. Recommended Render Setup for 100% Zero-Loss Persistence

To make your database 100% permanent on Render without ever downloading manual backups:

1. Open your **Render Dashboard** -> Select `roux-n-y` service.
2. Click **Disks** in the left sidebar -> Click **Add Disk**.
3. Set Mount Path: `/var/data`
4. Set Size: `1 GB` (or default).
5. Click **Save**.

Once attached, all textbook uploads and generated MCQs will be preserved **permanently** across all restarts, updates, and redeployments!
