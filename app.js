/*
 * Listening journal — app logic.
 * Loads data.csv, renders with vis.js, and in Edit mode lets you add/edit/delete
 * nodes and edges. Saves by committing data.csv back to the repo through
 * /api/save (Vercel) or, as a fallback, by downloading the CSV.
 *
 * Globals exposed on window (consumed by lib/bindings/utils.js):
 *   nodes, edges, network, nodeColors, highlightActive, filterActive
 */

// ----- Constants -------------------------------------------------------------

const COLOR = {
    album:        '#6495ED',
    albumLoved:   '#4263B4',
    albumToList:  'AliceBlue',
    artist:       'SandyBrown',
    artistLoved:  'DarkOrange',
};
const LS_KEY = 'listening_journal.v1';
const LS_PASSWORD = 'listening_journal.password';
const CSV_HEADER = 'item_id,item_name,type,notes,love,to_listen,connections,connection_labels,connection_directions';

// ----- Globals expected by utils.js (must be window-scoped) ------------------

var nodes, edges, network;
var nodeColors = {};
var highlightActive = false;
var filterActive = false;

// ----- Local state -----------------------------------------------------------

let editMode = false;
let saveAvailable = false;
let dirty = false;
let model = { nodes: [], edges: [] };
let view = 'graph';
let listStale = true;

// ----- CSV parser (RFC 4180-ish) --------------------------------------------

function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { field += c; }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field); field = '';
                if (row.length > 1 || row[0] !== '') rows.push(row);
                row = [];
            } else { field += c; }
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// ----- Model ↔ CSV -----------------------------------------------------------

function csvToModel(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
    const rows = parseCSV(text);
    if (!rows.length) return { nodes: [], edges: [] };
    const header = rows[0];
    const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
    const required = ['item_id','item_name','type','notes','love','to_listen','connections','connection_labels','connection_directions'];
    for (const k of required) if (!(k in idx)) throw new Error('CSV missing column: ' + k);

    const nodesOut = [];
    const edgesOut = [];
    let edgeSeq = 0;

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(c => c === '')) continue;
        const id = parseInt(row[idx.item_id], 10);
        nodesOut.push({
            id,
            name: row[idx.item_name],
            type: row[idx.type] === 'artist' ? 'artist' : 'album',
            notes: row[idx.notes] || '',
            love: row[idx.love] === '1',
            to_listen: row[idx.to_listen] === '1',
        });
        const conns = (row[idx.connections] || '').split('|').filter(s => s !== '');
        const labels = (row[idx.connection_labels] || '').split('|');
        const dirs = (row[idx.connection_directions] || '').split('|');
        for (let i = 0; i < conns.length; i++) {
            const target = parseInt(conns[i], 10);
            if (!target) continue;
            const label = labels[i] || '';
            const rawDir = (dirs[i] || 'none').trim();
            const direction = ['forward', 'backward', 'none', 'both'].includes(rawDir) ? rawDir : 'none';
            edgesOut.push({ id: 'e' + (++edgeSeq), owner: id, target, direction, label });
        }
    }
    return { nodes: nodesOut, edges: edgesOut };
}

function modelToCSV(m) {
    const byOwner = new Map();
    for (const e of m.edges) {
        if (!byOwner.has(e.owner)) byOwner.set(e.owner, []);
        byOwner.get(e.owner).push(e);
    }
    const sorted = [...m.nodes].sort((a, b) => a.id - b.id);
    const lines = [CSV_HEADER];
    for (const n of sorted) {
        const owned = byOwner.get(n.id) || [];
        const conns = [], labs = [], dirs = [];
        for (const e of owned) {
            conns.push(e.target);
            labs.push(e.label || '');
            dirs.push(e.direction);
        }
        lines.push([
            n.id,
            csvEscape(n.name),
            n.type,
            csvEscape(n.notes || ''),
            n.love ? '1' : '',
            n.to_listen ? '1' : '',
            conns.join('|'),
            labs.map(csvEscape).join('|'),
            dirs.join('|'),
        ].join(','));
    }
    return lines.join('\n') + '\n';
}

// ----- vis.js view helpers ---------------------------------------------------

function nodeColor(n) {
    if (n.type === 'artist') return n.love ? COLOR.artistLoved : COLOR.artist;
    if (n.to_listen) return COLOR.albumToList;
    return n.love ? COLOR.albumLoved : COLOR.album;
}

function toVisNode(n) {
    return {
        id: n.id,
        label: n.name,
        color: nodeColor(n),
        shape: 'dot',
        size: 12,
        font: { size: 14, face: 'Helvetica, Arial, sans-serif' },
    };
}

function toVisEdge(e) {
    let from, to, arrows;
    if (e.direction === 'backward') { from = e.target; to = e.owner; arrows = 'to'; }
    else if (e.direction === 'forward') { from = e.owner; to = e.target; arrows = 'to'; }
    else { from = e.owner; to = e.target; arrows = (e.direction === 'both') ? 'to, from' : ''; }
    return {
        id: e.id,
        from, to, arrows,
        title: e.label || '',
        color: { color: '#888', highlight: '#333' },
        smooth: { type: 'dynamic' },
    };
}

// Full (re)build — used on initial load and full reloads only.
function buildDatasetsFromScratch() {
    const visNodes = model.nodes.map(toVisNode);
    const visEdges = model.edges.map(toVisEdge);
    nodes = new vis.DataSet(visNodes);
    edges = new vis.DataSet(visEdges);
    window.nodes = nodes; window.edges = edges;
    nodeColors = {};
    for (const x of visNodes) nodeColors[x.id] = x.color;
    window.nodeColors = nodeColors;
}

// Incremental helpers — used for edits so vis.js preserves positions/physics.
function pushNode(n) {
    const v = toVisNode(n);
    if (nodes.get(n.id)) nodes.update(v); else nodes.add(v);
    nodeColors[n.id] = v.color;
}
function dropNode(id) {
    const connected = edges.get({ filter: e => e.from === id || e.to === id }).map(e => e.id);
    if (connected.length) edges.remove(connected);
    nodes.remove(id);
    delete nodeColors[id];
}

function pushEdge(e) {
    const v = toVisEdge(e);
    if (edges.get(e.id)) edges.update(v); else edges.add(v);
}
function dropEdge(id) { edges.remove(id); }

// ----- Persistence -----------------------------------------------------------

function markDirty() {
    dirty = true;
    localStorage.setItem(LS_KEY, JSON.stringify({ model, ts: Date.now() }));
    updateBanner();
    listStale = true;
    if (view === 'list') { renderList(); listStale = false; }
}

function clearLocal() {
    localStorage.removeItem(LS_KEY);
    dirty = false;
    updateBanner();
}

function loadLocal() {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

// ----- ID allocation ---------------------------------------------------------

function nextNodeId() {
    let max = 0;
    for (const n of model.nodes) if (n.id > max) max = n.id;
    return max + 1;
}
let edgeSeq = 0;
function nextEdgeId() {
    edgeSeq++;
    return 'e_' + Date.now().toString(36) + '_' + edgeSeq;
}

// ----- Modal -----------------------------------------------------------------

const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalSaveBtn = document.getElementById('modalSave');
const modalCancelBtn = document.getElementById('modalCancel');
const modalDeleteBtn = document.getElementById('modalDelete');

function openModal(title, bodyHTML, opts) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalDeleteBtn.classList.toggle('hidden', !opts.showDelete);
    modal.style.display = 'flex';
    const first = modalBody.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 50);

    const close = () => {
        modal.style.display = 'none';
        modalSaveBtn.onclick = null;
        modalCancelBtn.onclick = null;
        modalDeleteBtn.onclick = null;
    };
    modalSaveBtn.onclick = () => { if (opts.onSave() !== false) close(); };
    modalCancelBtn.onclick = () => { close(); if (opts.onCancel) opts.onCancel(); };
    modalDeleteBtn.onclick = () => { if (opts.onDelete && opts.onDelete() !== false) close(); };
}

function escHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function nodeFormHTML(n) {
    return `
        <label>Name<input type="text" id="f_name" value="${escHTML(n.name || '')}"></label>
        <label>Type
            <select id="f_type">
                <option value="album" ${n.type === 'album' ? 'selected' : ''}>Album</option>
                <option value="artist" ${n.type === 'artist' ? 'selected' : ''}>Artist</option>
            </select>
        </label>
        <label>Notes<textarea id="f_notes">${escHTML(n.notes || '')}</textarea></label>
        <div class="row">
            <label><input type="checkbox" id="f_love" ${n.love ? 'checked' : ''}> Favourite</label>
            <label><input type="checkbox" id="f_tolisten" ${n.to_listen ? 'checked' : ''}> To listen</label>
        </div>
    `;
}

function readNodeForm() {
    return {
        name: document.getElementById('f_name').value.trim(),
        type: document.getElementById('f_type').value,
        notes: document.getElementById('f_notes').value,
        love: document.getElementById('f_love').checked,
        to_listen: document.getElementById('f_tolisten').checked,
    };
}

function edgeFormHTML(e, nameById) {
    const ownerName = nameById.get(e.owner) || '?';
    const targetName = nameById.get(e.target) || '?';
    const current = e.direction;
    return `
        <p style="margin:4px 0 10px;color:#555;font-size:13px">
            Between <b>${escHTML(ownerName)}</b> and <b>${escHTML(targetName)}</b>
        </p>
        <label>Label<input type="text" id="f_label" value="${escHTML(e.label || '')}" placeholder="e.g. made, played guitar on"></label>
        <label>Direction
            <select id="f_dir">
                <option value="forward"  ${current === 'forward'  ? 'selected' : ''}>${escHTML(ownerName)} → ${escHTML(targetName)}</option>
                <option value="backward" ${current === 'backward' ? 'selected' : ''}>${escHTML(targetName)} → ${escHTML(ownerName)}</option>
                <option value="both"     ${current === 'both'     ? 'selected' : ''}>Both directions</option>
                <option value="none"     ${current === 'none'     ? 'selected' : ''}>No direction</option>
            </select>
        </label>
    `;
}

// ----- Edit handlers ---------------------------------------------------------

function openNodeEditor(existing, position) {
    const seed = existing || { name: '', type: 'album', notes: '', love: false, to_listen: false };
    openModal(existing ? 'Edit node' : 'Add node', nodeFormHTML(seed), {
        showDelete: !!existing,
        onSave() {
            const vals = readNodeForm();
            if (!vals.name) return false;
            if (existing) {
                Object.assign(existing, vals);
                pushNode(existing);
            } else {
                const id = nextNodeId();
                const n = { id, ...vals };
                model.nodes.push(n);
                pushNode(n);
                if (position) nodes.update([{ id: n.id, x: position.x, y: position.y }]);
            }
            markDirty();
        },
        onDelete() {
            if (!existing) return;
            if (!confirm('Delete this node and its connections?')) return false;
            model.edges = model.edges.filter(e => e.owner !== existing.id && e.target !== existing.id);
            model.nodes = model.nodes.filter(n => n.id !== existing.id);
            dropNode(existing.id);
            markDirty();
        },
    });
}

function openEdgeEditor(edge) {
    const nameById = new Map(model.nodes.map(n => [n.id, n.name]));
    const isNew = !!edge._new;
    openModal(isNew ? 'Add connection' : 'Edit connection', edgeFormHTML(edge, nameById), {
        showDelete: !isNew,
        onSave() {
            edge.label = document.getElementById('f_label').value.trim();
            edge.direction = document.getElementById('f_dir').value;
            delete edge._new;
            if (!model.edges.includes(edge)) model.edges.push(edge);
            pushEdge(edge);
            markDirty();
        },
        onDelete() {
            if (!confirm('Delete this connection?')) return false;
            model.edges = model.edges.filter(x => x !== edge);
            dropEdge(edge.id);
            markDirty();
        },
        onCancel() { /* new edge was never committed */ },
    });
}

// ----- vis.js setup ----------------------------------------------------------

function drawNetwork() {
    const container = document.getElementById('mynetwork');
    buildDatasetsFromScratch();
    const options = {
        layout: { improvedLayout: true },
        interaction: {
            zoomView: true,
            dragView: true,
            hover: true,
            tooltipDelay: 300,
            multiselect: false,
            selectConnectedEdges: false,
        },
        physics: { stabilization: { enabled: true } },
        manipulation: {
            enabled: false,
            addNode(data, cb) {
                openNodeEditor(null, { x: data.x, y: data.y });
                cb(null);
            },
            addEdge(data, cb) {
                if (data.from === data.to) { cb(null); return; }
                const e = {
                    id: nextEdgeId(),
                    owner: data.from,
                    target: data.to,
                    direction: 'forward',
                    label: '',
                    _new: true,
                };
                openEdgeEditor(e);
                cb(null);
            },
            editNode(data, cb) {
                const n = model.nodes.find(x => x.id === data.id);
                if (n) openNodeEditor(n);
                cb(null);
            },
            editEdge: {
                editWithoutDrag(data, cb) {
                    const e = model.edges.find(x => x.id === data.id);
                    if (e) openEdgeEditor(e);
                    cb(null);
                },
            },
            deleteNode(data, cb) {
                for (const id of data.nodes) {
                    model.edges = model.edges.filter(e => e.owner !== id && e.target !== id);
                    model.nodes = model.nodes.filter(n => n.id !== id);
                    dropNode(id);
                }
                markDirty();
                cb(null);
            },
            deleteEdge(data, cb) {
                for (const id of data.edges) {
                    model.edges = model.edges.filter(e => e.id !== id);
                    dropEdge(id);
                }
                markDirty();
                cb(null);
            },
        },
    };
    network = new vis.Network(container, { nodes, edges }, options);
    window.network = network;
    network.once('stabilizationIterationsDone', focusLatest);

    const box = document.getElementById('infoBox');
    const content = document.getElementById('infoBoxContent');

    network.on('click', params => {
        if (params.nodes.length) {
            const n = model.nodes.find(x => x.id === params.nodes[0]);
            if (n) {
                content.innerHTML =
                    `<b>${escHTML(n.name)}</b><br><span style="color:#666">${escHTML(n.type)}</span>` +
                    (n.notes ? `<div style="margin-top:6px">${escHTML(n.notes)}</div>` : '');
                box.style.display = 'block';
            }
        } else if (params.edges.length) {
            const e = model.edges.find(x => x.id === params.edges[0]);
            if (e) {
                content.innerHTML = e.label ? escHTML(e.label) : '<i>(no label)</i>';
                box.style.display = 'block';
            }
        } else {
            box.style.display = 'none';
        }
        if (!editMode) neighbourhoodHighlight(params);
    });

    network.on('doubleClick', params => {
        if (!editMode) return;
        if (params.nodes.length) {
            const n = model.nodes.find(x => x.id === params.nodes[0]);
            if (n) openNodeEditor(n);
        } else if (params.edges.length) {
            const e = model.edges.find(x => x.id === params.edges[0]);
            if (e) openEdgeEditor(e);
        }
    });

    document.getElementById('infoBoxClose').onclick = () => { box.style.display = 'none'; };
}

function focusLatest() {
    if (!network || !model.nodes.length) return;
    const latest = model.nodes.reduce((a, b) => (b.id > a.id ? b : a));
    network.focus(latest.id, {
        scale: 1.2,
        animation: { duration: 500, easingFunction: 'easeInOutQuad' },
    });
}

function setEditMode(on) {
    editMode = on;
    const btn = document.getElementById('btnMode');
    btn.textContent = on ? 'Done' : 'Edit';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    document.getElementById('btnSave').classList.toggle('hidden', !on || !saveAvailable);
    document.getElementById('btnExport').classList.toggle('hidden', !on);
    document.getElementById('btnImportLabel').classList.toggle('hidden', !on);
    if (network) {
        network.setOptions({ manipulation: { enabled: on } });
        if (!on) network.unselectAll();
    }
}

// ----- View toggle (Graph ↔ List) -------------------------------------------

function setView(next) {
    view = next;
    const isList = next === 'list';
    document.getElementById('btnViewGraph').setAttribute('aria-pressed', isList ? 'false' : 'true');
    document.getElementById('btnViewList').setAttribute('aria-pressed', isList ? 'true' : 'false');
    document.getElementById('mynetwork').style.display = isList ? 'none' : '';
    document.getElementById('listview').style.display = isList ? 'block' : 'none';
    document.querySelector('.legend').style.display = isList ? 'none' : '';
    document.getElementById('btnMode').style.display = isList ? 'none' : '';
    if (isList) {
        setEditMode(false);
        document.getElementById('infoBox').style.display = 'none';
        if (listStale) { renderList(); listStale = false; }
    }
}

function renderList() {
    const container = document.getElementById('listview');
    const items = [];
    for (const n of model.nodes) {
        if (n.type !== 'album') continue;
        const m = (n.notes || '').match(/^(\d{4}-\d{2}-\d{2})/);
        if (!m) continue;
        items.push({ node: n, date: m[1] });
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    if (!items.length) {
        container.innerHTML = '<div class="empty">No dated album notes yet.</div>';
        return;
    }
    const html = items.map(({ node, date }) => {
        const notes = (node.notes || '').replace(/^\d{4}-\d{2}-\d{2}\.?\s*/, '');
        const heart = node.love ? '<span class="heart" aria-label="Favourite">♥</span>' : '';
        return (
            '<article>' +
              '<div class="item-head">' +
                '<div class="item-name">' + heart + escHTML(node.name) + '</div>' +
                '<div class="item-date">' + escHTML(date) + '</div>' +
              '</div>' +
              (notes ? '<div class="item-notes">' + escHTML(notes) + '</div>' : '') +
            '</article>'
        );
    }).join('');
    container.innerHTML = html;
    container.scrollTop = 0;
}

// ----- Save / export / import ------------------------------------------------

async function probeSaveEndpoint() {
    try {
        const r = await fetch('/api/health', { method: 'GET' });
        return r.ok;
    } catch { return false; }
}

async function saveToServer() {
    let pw = localStorage.getItem(LS_PASSWORD);
    if (!pw) {
        pw = prompt('Edit password:');
        if (!pw) return;
    }
    const csv = modelToCSV(model);
    try {
        const r = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw, csv }),
        });
        if (r.status === 401) {
            localStorage.removeItem(LS_PASSWORD);
            alert('Wrong password.');
            return;
        }
        if (!r.ok) {
            alert('Save failed: ' + (await r.text()));
            return;
        }
        localStorage.setItem(LS_PASSWORD, pw);
        clearLocal();
        alert('Saved. Vercel will redeploy in ~30s.');
    } catch (err) {
        alert('Save failed: ' + err.message);
    }
}

function downloadCSV() {
    const csv = modelToCSV(model);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'data.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function importCSVFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            model = csvToModel(reader.result);
            clearLocal();
            buildDatasetsFromScratch();
            network.setData({ nodes, edges });
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// ----- Banner (unsaved-edits indicator) --------------------------------------

function updateBanner() {
    const b = document.getElementById('banner');
    if (dirty) {
        b.innerHTML = 'Unsaved edits. ' +
            '<button id="bnSave">Save</button>' +
            '<button id="bnDiscard">Discard</button>';
        b.style.display = 'block';
        document.getElementById('bnSave').onclick = () => saveAvailable ? saveToServer() : downloadCSV();
        document.getElementById('bnDiscard').onclick = async () => {
            if (!confirm('Discard unsaved edits and reload from the server?')) return;
            clearLocal();
            await boot();
        };
    } else {
        b.style.display = 'none';
    }
}

// ----- Boot ------------------------------------------------------------------

async function boot() {
    saveAvailable = await probeSaveEndpoint();
    const local = loadLocal();
    if (local && local.model) {
        model = local.model;
        dirty = true;
    } else {
        const resp = await fetch('data.csv', { cache: 'no-store' });
        const text = await resp.text();
        model = csvToModel(text);
        dirty = false;
    }
    if (!network) drawNetwork();
    else {
        buildDatasetsFromScratch();
        network.setData({ nodes, edges });
        network.once('stabilizationIterationsDone', focusLatest);
    }
    setEditMode(false);
    updateBanner();
    listStale = true;
    if (view === 'list') { renderList(); listStale = false; }
}

document.getElementById('btnMode').onclick = () => setEditMode(!editMode);
document.getElementById('btnViewGraph').onclick = () => setView('graph');
document.getElementById('btnViewList').onclick = () => setView('list');
document.getElementById('btnSave').onclick = saveToServer;
document.getElementById('btnExport').onclick = downloadCSV;
document.getElementById('importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importCSVFile(f);
    e.target.value = '';
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
        modalCancelBtn.click();
    }
});

boot();
