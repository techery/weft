/**
 * The web UI: one self-contained page — inline CSS, vanilla JS, no build step and no
 * external asset — served at `/`. It is the rich local surface the design asks for (runs
 * list, live tree, report, answering pending requests), and it stays one hand-written
 * file so a daemon dropped into any checkout serves a working UI with nothing to install.
 *
 * Everything it knows it learns from the same JSON API a script would use, so the page
 * carries no model of a run beyond what {@link createApp} returns.
 */

/** The whole UI. Deliberately backtick-free so it survives being a template literal here. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>weft</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --panel: #ffffff;
  --ink: #1c1c1b;
  --muted: #6d6d67;
  --line: #e3e3df;
  --accent: #3a5bd9;
  --ok: #2f7d50;
  --wait: #a86a00;
  --bad: #b3261e;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131315;
    --panel: #1a1a1d;
    --ink: #e7e7e4;
    --muted: #9a9a93;
    --line: #2b2b2f;
    --accent: #8ea6ff;
    --ok: #5fbf87;
    --wait: #d7a545;
    --bad: #e88b81;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
header .sub { color: var(--muted); font-size: 12px; }
#notice {
  margin: 0;
  padding: 8px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  color: var(--bad);
  font-size: 12px;
}
main {
  display: grid;
  grid-template-columns: 290px minmax(0, 1fr);
  align-items: start;
  gap: 0;
  min-height: calc(100vh - 51px);
}
@media (max-width: 760px) { main { grid-template-columns: minmax(0, 1fr); } }
#sidebar {
  border-right: 1px solid var(--line);
  padding: 12px;
  position: sticky;
  top: 0;
  max-height: 100vh;
  overflow-y: auto;
}
#sidebar h2, section h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  font-weight: 600;
  margin: 0 0 8px;
}
#run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.run-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.run-button:hover { background: var(--panel); border-color: var(--line); }
.run-selected .run-button { background: var(--panel); border-color: var(--accent); }
.run-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.run-workflow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-id { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.run-status { font-size: 11px; color: var(--muted); }
.mark { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.mark-ok { background: var(--ok); }
.mark-bad { background: var(--bad); }
.mark-wait { background: var(--wait); }
.mark-live { background: var(--accent); }
#detail { padding: 18px 20px 60px; min-width: 0; }
#detail section { margin-bottom: 22px; }
.empty { color: var(--muted); }
.head-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.head-line h3 { margin: 0; font-size: 17px; font-weight: 600; }
.head-id { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.facts { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0 12px; color: var(--muted); font-size: 12px; }
.facts b { color: var(--ink); font-weight: 600; }
.actions { display: flex; gap: 8px; }
button.action {
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: inherit;
  cursor: pointer;
}
button.action:hover { border-color: var(--accent); color: var(--accent); }
button.primary { border-color: var(--accent); color: var(--accent); }
.card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 14px;
  margin-bottom: 10px;
}
.card-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.card-kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.card-question { font-weight: 600; }
.card-detail { color: var(--muted); margin: 4px 0 10px; white-space: pre-wrap; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.field-inline { flex-direction: row; align-items: center; gap: 8px; }
.field-label { font-size: 12px; color: var(--muted); }
.field input[type=text], .field input[type=number], .field select, .field textarea {
  font: inherit;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  width: 100%;
  max-width: 520px;
}
.field textarea { font-family: var(--mono); font-size: 12px; }
.field input[type=checkbox] { width: auto; }
details { margin-top: 6px; }
summary { cursor: pointer; color: var(--muted); font-size: 12px; }
ul.tree { list-style: none; margin: 0; padding: 0 0 0 2px; }
ul.tree ul.tree { padding-left: 16px; border-left: 1px solid var(--line); margin-left: 4px; }
.node { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.node-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-kind, .node-usage { font-size: 11px; color: var(--muted); }
.phase { margin-bottom: 12px; }
.phase-name { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
pre {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
pre.tail { max-height: 320px; overflow-y: auto; white-space: pre; word-break: normal; }
</style>
</head>
<body>
<header>
  <h1>weft</h1>
  <span class="sub">local runs, live journal, pending requests</span>
</header>
<p id="notice" hidden></p>
<main>
  <aside id="sidebar">
    <h2>Runs</h2>
    <ul id="run-list"></ul>
  </aside>
  <section id="detail">
    <div id="detail-head"></div>
    <div id="detail-pending"></div>
    <div id="detail-tree"></div>
    <div id="detail-report"></div>
    <div id="detail-tail"></div>
  </section>
</main>
<script>
(function () {
  'use strict';

  var POLL_MS = 2000;
  var REFRESH_DEBOUNCE_MS = 400;
  var TAIL_MAX = 200;

  var runsEl = document.getElementById('run-list');
  var noticeEl = document.getElementById('notice');
  var headEl = document.getElementById('detail-head');
  var pendingEl = document.getElementById('detail-pending');
  var treeEl = document.getElementById('detail-tree');
  var reportEl = document.getElementById('detail-report');
  var tailEl = document.getElementById('detail-tail');

  var selected = null;
  var source = null;
  var tail = [];
  var pendingKey = null;
  var refreshTimer = null;

  // -- plumbing -------------------------------------------------------------

  function api(path, init) {
    return fetch(path, init).then(function (res) {
      var type = res.headers.get('content-type') || '';
      var body = type.indexOf('application/json') >= 0 ? res.json() : res.text();
      return body.then(function (value) {
        if (res.ok) return value;
        var message = value && value.error ? value.error : 'HTTP ' + res.status;
        throw new Error(message);
      });
    });
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function runPath(runId, suffix) {
    return '/api/runs/' + encodeURIComponent(runId) + (suffix || '');
  }

  function notice(message) {
    noticeEl.textContent = message || '';
    noticeEl.hidden = !message;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function mark(kind) {
    return el('span', 'mark mark-' + kind);
  }

  function markOf(status) {
    if (status === 'complete' || status === 'ok') return 'ok';
    if (status === 'failed' || status === 'cancelled') return 'bad';
    if (status === 'waiting_for_human' || status === 'waiting_for_signal') return 'wait';
    return 'live';
  }

  function money(value) {
    return '$' + (Math.round((value || 0) * 100) / 100).toFixed(2);
  }

  // -- runs list ------------------------------------------------------------

  function refreshRuns() {
    return api('/api/runs').then(function (runs) {
      runsEl.textContent = '';
      if (!runs.length) {
        runsEl.appendChild(el('li', 'empty', 'no runs yet'));
        return;
      }
      runs.forEach(function (run) {
        var item = el('li', run.runId === selected ? 'run-selected' : '');
        var button = el('button', 'run-button');
        button.type = 'button';
        button.appendChild(mark(markOf(run.status)));
        var text = el('span', 'run-text');
        text.appendChild(el('span', 'run-workflow', run.workflow || 'workflow'));
        text.appendChild(el('span', 'run-id', run.runId));
        button.appendChild(text);
        button.appendChild(el('span', 'run-status', run.status));
        button.addEventListener('click', function () { select(run.runId); });
        item.appendChild(button);
        runsEl.appendChild(item);
      });
      notice('');
    }).catch(function (err) { notice(err.message); });
  }

  function select(runId) {
    if (selected !== runId) {
      selected = runId;
      tail = [];
      pendingKey = null;
      openStream(runId);
    }
    if (location.hash.slice(1) !== runId) location.hash = runId;
    renderTail();
    loadDetail();
    refreshRuns();
  }

  // -- live journal ---------------------------------------------------------

  function openStream(runId) {
    if (source) { source.close(); source = null; }
    if (!runId) return;
    var live = new EventSource(runPath(runId, '/events'));
    source = live;
    live.onmessage = function (ev) {
      if (source !== live) return;
      var record;
      try { record = JSON.parse(ev.data); } catch (err) { return; }
      tail.push(record);
      if (tail.length > TAIL_MAX) tail.shift();
      renderTail();
      scheduleRefresh();
    };
    live.addEventListener('child', function () {
      // A sub-workflow journaled something (often the question the parent is
      // blocked on): re-fetch state and pending, but keep the tail single-journal.
      if (source !== live) return;
      scheduleRefresh();
    });
    live.onerror = function () {
      // The browser reconnects on its own; a closed run simply stops producing records.
    };
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      loadDetail();
    }, REFRESH_DEBOUNCE_MS);
  }

  function renderTail() {
    tailEl.textContent = '';
    if (!selected) return;
    var section = el('section');
    section.appendChild(el('h2', null, 'Journal'));
    if (!tail.length) {
      section.appendChild(el('p', 'empty', 'waiting for events'));
      tailEl.appendChild(section);
      return;
    }
    var lines = tail.map(function (record) {
      var head = String(record.i) + '  ' + record.ev.type;
      var rest = describe(record.ev);
      return rest ? head + '  ' + rest : head;
    });
    var pre = el('pre', 'tail', lines.join('\\n'));
    section.appendChild(pre);
    tailEl.appendChild(section);
    pre.scrollTop = pre.scrollHeight;
  }

  function describe(ev) {
    var copy = {};
    var skip = { type: 1, hash: 1, schema: 1 };
    Object.keys(ev).forEach(function (key) {
      if (!skip[key]) copy[key] = ev[key];
    });
    var text = JSON.stringify(copy);
    if (text === '{}') return '';
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
  }

  // -- detail ---------------------------------------------------------------

  function loadDetail() {
    var runId = selected;
    if (!runId) {
      headEl.textContent = '';
      headEl.appendChild(el('p', 'empty', 'Select a run.'));
      pendingEl.textContent = '';
      treeEl.textContent = '';
      reportEl.textContent = '';
      return Promise.resolve();
    }
    return Promise.all([
      api(runPath(runId)),
      api(runPath(runId, '/tree')),
      api(runPath(runId, '/pending')),
      api(runPath(runId, '/report'))
    ]).then(function (parts) {
      if (selected !== runId) return;
      renderHead(runId, parts[0]);
      renderPending(runId, parts[2]);
      renderTree(parts[1]);
      renderReport(parts[3]);
      notice('');
    }).catch(function (err) { notice(err.message); });
  }

  function renderHead(runId, state) {
    headEl.textContent = '';
    var section = el('section');
    var line = el('div', 'head-line');
    line.appendChild(mark(markOf(state.status)));
    line.appendChild(el('h3', null, state.workflow || 'workflow'));
    line.appendChild(el('span', 'head-id', runId));
    section.appendChild(line);

    var facts = el('div', 'facts');
    facts.appendChild(fact('status', state.status));
    facts.appendChild(fact('cost', (state.budget.tokens || 0).toLocaleString() + ' tokens / ' + money(state.budget.usd)));
    facts.appendChild(fact('steps', String(state.steps.length)));
    if (state.error) facts.appendChild(fact('error', state.error.code + ': ' + state.error.message));
    section.appendChild(facts);

    var actions = el('div', 'actions');
    actions.appendChild(action('Resume', function () { return post(runPath(runId, '/resume')); }));
    actions.appendChild(action('Cancel', function () { return post(runPath(runId, '/cancel')); }));
    section.appendChild(actions);
    headEl.appendChild(section);
  }

  function fact(label, value) {
    var node = el('span');
    node.appendChild(el('span', null, label + ' '));
    node.appendChild(el('b', null, value));
    return node;
  }

  function action(label, fn) {
    var button = el('button', 'action', label);
    button.type = 'button';
    button.addEventListener('click', function () {
      button.disabled = true;
      fn().then(function () { loadDetail(); refreshRuns(); })
        .catch(function (err) { notice(err.message); })
        .then(function () { button.disabled = false; });
    });
    return button;
  }

  function renderTree(phases) {
    treeEl.textContent = '';
    var section = el('section');
    section.appendChild(el('h2', null, 'Tree'));
    if (!phases.length) {
      section.appendChild(el('p', 'empty', 'no steps yet'));
      treeEl.appendChild(section);
      return;
    }
    phases.forEach(function (phase) {
      var block = el('div', 'phase');
      block.appendChild(el('div', 'phase-name', phase.name));
      block.appendChild(nodeList(phase.nodes));
      section.appendChild(block);
    });
    treeEl.appendChild(section);
  }

  function nodeList(nodes) {
    var list = el('ul', 'tree');
    nodes.forEach(function (node) {
      var item = el('li');
      var row = el('div', 'node');
      row.appendChild(mark(markOf(node.status)));
      row.appendChild(el('span', 'node-label', node.label));
      row.appendChild(el('span', 'node-kind', node.kind));
      if (node.usage) {
        var tokens = (node.usage.input || 0) + (node.usage.output || 0);
        row.appendChild(el('span', 'node-usage', tokens.toLocaleString() + ' tok'));
      }
      item.appendChild(row);
      if (node.children && node.children.length) item.appendChild(nodeList(node.children));
      list.appendChild(item);
    });
    return list;
  }

  function renderReport(markdown) {
    reportEl.textContent = '';
    var section = el('section');
    section.appendChild(el('h2', null, 'Report'));
    section.appendChild(el('pre', null, markdown));
    reportEl.appendChild(section);
  }

  // -- pending requests -----------------------------------------------------

  function renderPending(runId, pending) {
    var key = runId + ':' + pending.map(function (request) { return request.id; }).join(',');
    // Re-rendering on every journal event would wipe a half-typed answer, so the forms
    // are rebuilt only when the set of open requests actually changes.
    if (key === pendingKey) return;
    pendingKey = key;
    pendingEl.textContent = '';
    if (!pending.length) return;
    var section = el('section');
    section.appendChild(el('h2', null, 'Waiting on you'));
    pending.forEach(function (request) {
      section.appendChild(requestCard(runId, request));
    });
    pendingEl.appendChild(section);
  }

  function requestCard(runId, request) {
    var card = el('div', 'card');
    var head = el('div', 'card-head');
    head.appendChild(el('span', 'card-kind', request.kind));
    head.appendChild(el('span', 'card-question', request.question));
    if (request.risk) head.appendChild(el('span', 'card-kind', 'risk: ' + request.risk));
    card.appendChild(head);
    if (request.detail) card.appendChild(el('div', 'card-detail', request.detail));

    var form = document.createElement('form');
    var read = fieldsFor(form, request.schema);
    var actions = el('div', 'actions');
    var submit = el('button', 'action primary', 'Answer');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.appendChild(actions);

    var schemaBox = el('details');
    schemaBox.appendChild(el('summary', null, 'schema'));
    schemaBox.appendChild(el('pre', null, JSON.stringify(request.schema, null, 2)));
    form.appendChild(schemaBox);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var value;
      try {
        value = read();
      } catch (err) {
        notice('answer: ' + err.message);
        return;
      }
      submit.disabled = true;
      post(runPath(runId, '/answer'), { requestId: request.id, answer: value })
        .then(function () {
          pendingKey = null;
          notice('');
          loadDetail();
          refreshRuns();
        })
        .catch(function (err) { notice(err.message); })
        .then(function () { submit.disabled = false; });
    });
    card.appendChild(form);
    return card;
  }

  /**
   * An object schema becomes one field per property; anything else becomes a single
   * field for the whole answer. Returns the reader that collects the value.
   */
  function fieldsFor(form, schema) {
    schema = schema || {};
    var props = schema.properties;
    if (props && Object.keys(props).length) {
      var required = schema.required || [];
      var readers = [];
      Object.keys(props).forEach(function (name) {
        var isRequired = required.indexOf(name) >= 0;
        var field = control(props[name], isRequired ? name : name + ' (optional)');
        form.appendChild(field.node);
        readers.push({ name: name, read: field.read, required: isRequired });
      });
      return function () {
        var out = {};
        readers.forEach(function (entry) {
          var value = entry.read();
          if (value === undefined) return;
          // An untouched optional text field is absent, not the empty string.
          if (!entry.required && value === '') return;
          out[entry.name] = value;
        });
        return out;
      };
    }
    var single = control(schema, 'answer');
    form.appendChild(single.node);
    return single.read;
  }

  /** enum to select, boolean to checkbox, string/number to an input, anything deeper to JSON. */
  function control(schema, label) {
    schema = schema || {};
    var type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    var wrap = el('label', 'field');
    var input;
    var read;

    if (Array.isArray(schema.enum)) {
      input = document.createElement('select');
      schema.enum.forEach(function (value) {
        var option = document.createElement('option');
        option.value = JSON.stringify(value);
        option.textContent = String(value);
        input.appendChild(option);
      });
      read = function () { return JSON.parse(input.value); };
    } else if (type === 'boolean') {
      wrap.className = 'field field-inline';
      input = document.createElement('input');
      input.type = 'checkbox';
      read = function () { return input.checked; };
    } else if (type === 'string') {
      input = document.createElement('input');
      input.type = 'text';
      if (schema.description) input.placeholder = schema.description;
      read = function () { return input.value; };
    } else if (type === 'number' || type === 'integer') {
      input = document.createElement('input');
      input.type = 'number';
      if (type === 'integer') input.step = '1';
      read = function () {
        if (input.value === '') return undefined;
        var parsed = Number(input.value);
        if (!isFinite(parsed)) throw new Error(label + ' is not a number');
        return parsed;
      };
    } else {
      input = document.createElement('textarea');
      input.rows = 4;
      input.placeholder = 'JSON matching the schema below';
      read = function () {
        if (input.value.trim() === '') return undefined;
        return JSON.parse(input.value);
      };
    }

    if (type === 'boolean') {
      wrap.appendChild(input);
      wrap.appendChild(el('span', 'field-label', label));
    } else {
      wrap.appendChild(el('span', 'field-label', label));
      wrap.appendChild(input);
    }
    return { node: wrap, read: read };
  }

  // -- boot -----------------------------------------------------------------

  window.addEventListener('hashchange', function () {
    var runId = location.hash.slice(1);
    if (runId && runId !== selected) select(runId);
  });

  loadDetail();
  refreshRuns().then(function () {
    var runId = location.hash.slice(1);
    if (runId) select(runId);
  });
  setInterval(refreshRuns, POLL_MS);
})();
</script>
</body>
</html>
`;
