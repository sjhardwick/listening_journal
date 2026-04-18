/*
 * POST /api/save
 * Body: { password: string, csv: string }
 *
 * Validates the password against EDIT_PASSWORD, then commits the CSV to GitHub
 * via the contents API using GITHUB_TOKEN.  Vercel auto-redeploys on the push.
 *
 * Env vars (set in Vercel):
 *   EDIT_PASSWORD  — shared secret
 *   GITHUB_TOKEN   — fine-grained PAT with Contents: write, this repo only
 *   GITHUB_REPO    — "owner/repo", e.g. "sjhardwick/listening_journal"
 *   GITHUB_BRANCH  — optional, defaults to "main"
 *   GITHUB_FILE    — optional, defaults to "data.csv"
 */

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).send('Method not allowed');
    }

    const { password, csv } = req.body || {};
    if (typeof password !== 'string' || typeof csv !== 'string') {
        return res.status(400).send('Missing password or csv');
    }
    if (!process.env.EDIT_PASSWORD || password !== process.env.EDIT_PASSWORD) {
        return res.status(401).send('Unauthorised');
    }
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
        return res.status(500).send('Server not configured');
    }

    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const path = process.env.GITHUB_FILE || 'data.csv';
    const apiBase = `https://api.github.com/repos/${repo}/contents/${path}`;

    const headers = {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'listening-journal-save',
    };

    try {
        // 1. Fetch the current file's SHA (required for updates).
        const getResp = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
        if (!getResp.ok && getResp.status !== 404) {
            const text = await getResp.text();
            return res.status(502).send(`GitHub GET failed: ${getResp.status} ${text}`);
        }
        const existing = getResp.ok ? await getResp.json() : null;

        // 2. PUT the new content.
        const contentB64 = Buffer.from(csv, 'utf-8').toString('base64');
        const body = {
            message: 'edit from app',
            content: contentB64,
            branch,
            ...(existing?.sha ? { sha: existing.sha } : {}),
        };
        const putResp = await fetch(apiBase, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!putResp.ok) {
            const text = await putResp.text();
            return res.status(502).send(`GitHub PUT failed: ${putResp.status} ${text}`);
        }
        const result = await putResp.json();
        return res.status(200).json({ commit: result.commit?.sha });
    } catch (err) {
        return res.status(500).send(`Error: ${err.message}`);
    }
}
