# Roux N Y

Editorial workspace for source-grounded surgical MCQ production.

## Run locally

Use a current Node.js runtime (v20 or newer), then run:

`powershell
node server.mjs
` 

Open `http://localhost:4173`. The app is dependency-free at this stage, so no package install is required.

## Local storage

Source PDFs and generated assets are stored outside this repository at `D:\Roux N Y\storage`:

- `uploads` — textbook PDF sources
- `assets` — extracted figures, tables, and crops
- `exports` — CSV, Excel, JSON, SQL, and PDF outputs
- `reports` — coverage and validation reports

The application source and configuration are kept under Git; local medical content and generated materials are not committed.
