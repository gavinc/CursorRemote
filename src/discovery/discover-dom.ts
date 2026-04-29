import http from 'node:http';
import https from 'node:https';
import { CdpClient } from '../server/cdp-client.js';

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const CDP_HOST_HEADER = process.env.CDP_HOST_HEADER?.trim() ?? '';
const CDP_WS_URL_BASE = process.env.CDP_WS_URL_BASE?.trim().replace(/\/$/, '') ?? '';
const CDP_TLS_INSECURE = process.env.CDP_TLS_INSECURE === 'true';

type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

async function fetchCdpJson<T>(url: string): Promise<T> {
  if (!CDP_HOST_HEADER && !CDP_TLS_INSECURE) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`CDP HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return await new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        servername: isHttps ? parsed.hostname : undefined,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: CDP_HOST_HEADER ? { Host: CDP_HOST_HEADER } : undefined,
        rejectUnauthorized: isHttps ? !CDP_TLS_INSECURE : undefined,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`CDP HTTP ${res.statusCode ?? '?'} ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('CDP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function rewriteWebSocketUrls(targets: CdpTarget[]): CdpTarget[] {
  if (!CDP_WS_URL_BASE) return targets;
  return targets.map((target) => {
    if (!target.webSocketDebuggerUrl) return target;
    const path = new URL(target.webSocketDebuggerUrl).pathname;
    return { ...target, webSocketDebuggerUrl: `${CDP_WS_URL_BASE}${path}` };
  });
}

const agentSidebarProbe = `
(() => {
  const legacyCells = document.querySelectorAll('.agent-sidebar-cell');
  const glassBtns = document.querySelectorAll(
    '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
  );
  function cleanTabTitle(raw) {
    let t = (raw || '').trim().replace(/\\s+/g, ' ');
    t = t.replace(/(@[\\w./]+)+\\s*$/, '');
    return t.trim().substring(0, 120);
  }
  const titles = [];
  for (const btn of Array.from(glassBtns)) {
    const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
    const rawAgent = (labelEl?.textContent || '').trim();
    if (!rawAgent) continue;
    const group = btn.closest('.ui-sidebar-group');
    const gt = group?.querySelector('.ui-sidebar-group-label-title');
    const rawGroup = (gt?.textContent || '').trim();
    let line = cleanTabTitle(rawAgent);
    if (rawGroup) {
      const g = cleanTabTitle(rawGroup);
      if (g) line = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 100);
    }
    if (btn.getAttribute('data-active') === 'true') line = '[active] ' + line;
    titles.push(line);
  }
  return {
    documentTitle: document.title,
    legacyAgentSidebarCellCount: legacyCells.length,
    glassAgentMenuButtonCount: glassBtns.length,
    titlesSample: titles.slice(0, 25),
  };
})()
`;

interface DOMSummaryNode {
  tag: string;
  id?: string;
  classes: string[];
  ariaLabel?: string;
  role?: string;
  text?: string;
  childCount: number;
  children?: DOMSummaryNode[];
}

async function main(): Promise<void> {
  console.log('=== Cursor DOM Discovery Tool ===\n');
  console.log(`CDP_URL: ${CDP_URL}`);
  if (CDP_HOST_HEADER) console.log(`CDP_HOST_HEADER: ${CDP_HOST_HEADER}`);
  if (CDP_WS_URL_BASE) console.log(`CDP_WS_URL_BASE: ${CDP_WS_URL_BASE}`);
  if (CDP_TLS_INSECURE) console.log('CDP_TLS_INSECURE: true');
  console.log('');

  // 1. List all targets
  console.log('--- CDP Targets ---\n');
  let targets: CdpTarget[];

  try {
    targets = rewriteWebSocketUrls(await fetchCdpJson<CdpTarget[]>(`${CDP_URL}/json`));
  } catch (err) {
    console.error(`Failed to connect to ${CDP_URL}/json`);
    console.error(err instanceof Error ? err.message : err);
    console.error('For Tailscale HTTPS CDP, set CDP_HOST_HEADER (and CDP_WS_URL_BASE, CDP_TLS_INSECURE if needed). See .env.example.');
    process.exit(1);
  }

  for (const t of targets) {
    console.log(`  [${t.type}] "${t.title}"`);
    console.log(`    URL: ${t.url}`);
    console.log(`    WS:  ${t.webSocketDebuggerUrl ?? 'N/A'}\n`);
  }

  const workbenchPages = targets.filter(
    t => t.type === 'page' && t.url.includes('workbench') && t.webSocketDebuggerUrl
  );

  console.log('--- Agent sidebar probe (issue #13 / chatTabs) ---\n');
  console.log('Legacy: .agent-sidebar-cell. New Cursor Agents UI: .glass-sidebar-agent-menu-btn.\n');

  for (const page of workbenchPages) {
    const cli = new CdpClient();
    try {
      await cli.connect(page.webSocketDebuggerUrl!, { tlsInsecure: CDP_TLS_INSECURE });
      const probe = await cli.evaluate(agentSidebarProbe) as {
        documentTitle: string;
        legacyAgentSidebarCellCount: number;
        glassAgentMenuButtonCount: number;
        titlesSample: string[];
      };
      console.log(`  Window: "${page.title}"`);
      console.log(`    document.title: ${probe.documentTitle}`);
      console.log(`    .agent-sidebar-cell count: ${probe.legacyAgentSidebarCellCount}`);
      console.log(`    glass-sidebar agent row count: ${probe.glassAgentMenuButtonCount}`);
      if (probe.titlesSample.length > 0) {
        console.log(`    title sample (${probe.titlesSample.length}):`);
        for (const line of probe.titlesSample) {
          console.log(`      - ${line}`);
        }
      }
      console.log('');
    } catch (e) {
      console.warn(`  Window: "${page.title}" — probe failed: ${e instanceof Error ? e.message : e}\n`);
    } finally {
      cli.disconnect();
    }
  }

  // 2. Full DOM exploration: first workbench page (fallback: first page)
  const target =
    workbenchPages[0] ??
    targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) ??
    targets[0];

  if (!target?.webSocketDebuggerUrl) {
    console.error('No suitable target found');
    process.exit(1);
  }

  console.log(`--- Full DOM exploration: "${target.title}" ---\n`);

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl, { tlsInsecure: CDP_TLS_INSECURE });

  // 3. Explore the DOM
  console.log('--- DOM Exploration ---\n');

  const domInfo = await client.evaluate(`
    (() => {
      function summarize(el, depth, maxDepth) {
        const node = {
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList),
          childCount: el.children.length,
        };
        if (el.id) node.id = el.id;
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) node.ariaLabel = ariaLabel;
        const role = el.getAttribute('role');
        if (role) node.role = role;
        if (el.children.length === 0 && el.textContent) {
          const text = el.textContent.trim();
          if (text.length > 0 && text.length < 100) node.text = text;
        }
        if (depth < maxDepth) {
          node.children = Array.from(el.children).map(c => summarize(c, depth + 1, maxDepth));
        }
        return node;
      }

      return {
        title: document.title,
        bodyClasses: Array.from(document.body.classList),
        topLevel: Array.from(document.body.children).map(c => summarize(c, 0, 2)),
      };
    })()
  `) as { title: string; bodyClasses: string[]; topLevel: DOMSummaryNode[] };

  console.log(`Page title: ${domInfo.title}`);
  console.log(`Body classes: ${domInfo.bodyClasses.join(', ') || '(none)'}\n`);

  console.log('Top-level elements:\n');
  for (const node of domInfo.topLevel) {
    printNode(node, 0);
  }

  // 4. Search for chat-related elements
  console.log('\n--- Chat Element Search ---\n');

  const chatSearch = await client.evaluate(`
    (() => {
      const patterns = [
        'composer', 'chat', 'agent', 'message', 'conversation',
        'sidebar', 'panel', 'inline-chat', 'copilot',
      ];
      const results = [];

      for (const pattern of patterns) {
        const elements = document.querySelectorAll("[class*='" + pattern + "']");
        for (const el of Array.from(elements).slice(0, 3)) {
          results.push({
            pattern,
            selector: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            classes: Array.from(el.classList).join(' '),
            text: (el.textContent || '').trim().substring(0, 80),
          });
        }
      }

      const buttons = document.querySelectorAll('button');
      const interestingButtons = [];
      const buttonKeywords = ['accept', 'approve', 'reject', 'deny', 'cancel', 'run', 'send'];
      for (const btn of Array.from(buttons)) {
        const label = (btn.textContent?.trim() ?? '') + ' ' + (btn.getAttribute('aria-label') ?? '');
        for (const kw of buttonKeywords) {
          if (label.toLowerCase().includes(kw)) {
            interestingButtons.push({
              pattern: 'button:' + kw,
              selector: buildSelector(btn),
              tag: 'button',
              classes: Array.from(btn.classList).join(' '),
              text: btn.textContent?.trim().substring(0, 50) ?? '',
            });
            break;
          }
        }
      }

      const inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      const inputResults = [];
      for (const input of Array.from(inputs).slice(0, 5)) {
        inputResults.push({
          pattern: 'input',
          selector: buildSelector(input),
          tag: input.tagName.toLowerCase(),
          classes: Array.from(input.classList).join(' '),
          text: (input.getAttribute('placeholder') ?? input.getAttribute('aria-label') ?? '').substring(0, 50),
        });
      }

      function buildSelector(el) {
        const parts = [];
        let current = el;
        let depth = 0;
        while (current && current !== document.body && depth < 5) {
          let s = current.tagName.toLowerCase();
          if (current.id) { parts.unshift('#' + current.id); break; }
          const cls = Array.from(current.classList).slice(0, 2).join('.');
          if (cls) s += '.' + cls;
          parts.unshift(s);
          current = current.parentElement;
          depth++;
        }
        return parts.join(' > ');
      }

      return { classPatterns: results, buttons: interestingButtons, inputs: inputResults };
    })()
  `) as {
    classPatterns: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
    buttons: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
    inputs: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
  };

  if (chatSearch.classPatterns.length > 0) {
    console.log('Elements matching chat/agent class patterns:\n');
    for (const r of chatSearch.classPatterns) {
      console.log(`  [${r.pattern}] <${r.tag}>`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}`);
      if (r.text) console.log(`    text: "${r.text.substring(0, 60)}..."`);
      console.log();
    }
  } else {
    console.log('  No elements found matching chat/agent class patterns.\n');
  }

  if (chatSearch.buttons.length > 0) {
    console.log('Interesting buttons (approve/reject/send):\n');
    for (const r of chatSearch.buttons) {
      console.log(`  [${r.pattern}] "${r.text}"`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}\n`);
    }
  } else {
    console.log('  No approval/action buttons found.\n');
  }

  if (chatSearch.inputs.length > 0) {
    console.log('Text inputs found:\n');
    for (const r of chatSearch.inputs) {
      console.log(`  <${r.tag}> placeholder="${r.text}"`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}\n`);
    }
  } else {
    console.log('  No text inputs found.\n');
  }

  console.log('--- Discovery Complete ---');
  console.log('\nUse the selectors above to update selectors.json');

  client.disconnect();
}

function printNode(node: DOMSummaryNode, depth: number): void {
  const indent = '  '.repeat(depth);
  const parts = [`<${node.tag}`];
  if (node.id) parts.push(` id="${node.id}"`);
  if (node.role) parts.push(` role="${node.role}"`);
  if (node.ariaLabel) parts.push(` aria-label="${node.ariaLabel}"`);
  parts.push('>');

  const classStr = node.classes.length > 0
    ? ` [${node.classes.slice(0, 3).join(', ')}${node.classes.length > 3 ? '...' : ''}]`
    : '';

  const textStr = node.text ? ` "${node.text.substring(0, 40)}"` : '';
  const childStr = node.childCount > 0 ? ` (${node.childCount} children)` : '';

  console.log(`${indent}${parts.join('')}${classStr}${textStr}${childStr}`);

  if (node.children) {
    for (const child of node.children) {
      printNode(child, depth + 1);
    }
  }
}

main().catch((err) => {
  console.error('Discovery failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
