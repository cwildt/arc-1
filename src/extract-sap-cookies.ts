import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { config as loadDotEnv } from 'dotenv';

type BrowserChoice = 'chrome' | 'firefox' | 'edge';

interface ScriptArgs {
  browser: BrowserChoice;
  output?: string;
  profileDir?: string;
  auto: boolean;
  yes: boolean;
  help: boolean;
}

export interface ServerArgs {
  url?: string;
  cookieFile?: string;
}

export interface ExtractionPlanInput {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
}

export interface ExtractionPlan {
  url: string;
  origin: string;
  browser: BrowserChoice;
  browserBinary: string;
  outputPath: string;
  profileDir?: string;
  auto: boolean;
  yes: boolean;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
}

const DEV_ONLY_BANNER =
  '⚠️  DEV-ONLY UTILITY. The resulting cookie file MUST NOT be used with SAP_PP_ENABLED=true — it would cause every per-user request to authenticate as you. Continue? [y/N] ';
const PP_REFUSAL_MESSAGE =
  'Refusing to run while SAP_PP_ENABLED=true. Cookie extraction is a shared-auth developer utility and must never run alongside principal propagation.';

function getFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i]?.startsWith(prefix)) {
      return args[i].slice(prefix.length);
    }
  }
  return undefined;
}

function parseScriptArgs(args: string[]): ScriptArgs {
  const browserRaw = getFlag(args, 'browser') ?? 'chrome';
  const browser = browserRaw === 'chrome' || browserRaw === 'firefox' || browserRaw === 'edge' ? browserRaw : null;
  if (!browser) {
    throw new Error(`Unsupported --browser value '${browserRaw}'. Use one of: chrome, firefox, edge.`);
  }

  return {
    browser,
    output: getFlag(args, 'output'),
    profileDir: getFlag(args, 'profile-dir'),
    auto: args.includes('--auto'),
    yes: args.includes('--yes'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

// Keep this helper local to mirror the server config precedence for --url.
export function parseServerArgs(args: string[], env: NodeJS.ProcessEnv = process.env): ServerArgs {
  return {
    url: getFlag(args, 'url') ?? env.SAP_URL,
    cookieFile: env.SAP_COOKIE_FILE,
  };
}

function commandExists(command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore' })
      : spawnSync('command', ['-v', command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveBrowserBinary(browser: BrowserChoice, platform: NodeJS.Platform): string {
  const win32Paths = (relativePath: string, exe: string): string[] => {
    const PF = process.env.PROGRAMFILES;
    const PF86 = process.env['PROGRAMFILES(X86)'];
    const LAD = process.env.LOCALAPPDATA;
    return [
      LAD ? `${LAD}\\${relativePath}` : undefined,
      PF ? `${PF}\\${relativePath}` : undefined,
      PF86 ? `${PF86}\\${relativePath}` : undefined,
      exe,
    ].filter((c): c is string => Boolean(c));
  };

  const candidates: Record<BrowserChoice, string[]> = {
    chrome:
      platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            'google-chrome',
            'google-chrome-stable',
            'chromium',
            'chromium-browser',
          ]
        : platform === 'win32'
          ? win32Paths('Google\\Chrome\\Application\\chrome.exe', 'chrome.exe')
          : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    firefox:
      platform === 'darwin'
        ? ['/Applications/Firefox.app/Contents/MacOS/firefox', 'firefox']
        : platform === 'win32'
          ? win32Paths('Mozilla Firefox\\firefox.exe', 'firefox.exe')
          : ['firefox', 'firefox-esr'],
    edge:
      platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'microsoft-edge', 'microsoft-edge-stable']
        : platform === 'win32'
          ? win32Paths('Microsoft\\Edge\\Application\\msedge.exe', 'msedge.exe')
          : ['microsoft-edge', 'microsoft-edge-stable'],
  };

  for (const candidate of candidates[browser]) {
    if (isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    if (platform === 'linux') {
      if (commandExists(candidate)) return candidate;
      continue;
    }
    if (platform === 'win32') {
      if (spawnSync('where', [candidate], { stdio: 'ignore' }).status === 0) return candidate;
      continue;
    }
    if (commandExists(candidate)) return candidate;
  }

  throw new Error(
    `No runnable ${browser} binary found. Install the browser or pass an available binary via --browser (chrome|firefox|edge).`,
  );
}

function printUsage(): void {
  process.stderr.write(`Usage: arc1-cli extract-cookies --url <SAP_URL> [options]
       (or: npx tsx src/extract-sap-cookies.ts --url <SAP_URL> [options])

Options:
  --url <url>               Target SAP URL (required). Precedence: CLI > env > .env
  --browser <name>          Browser to launch: chrome | firefox | edge (default: chrome)
  --output <path>           Output cookie file path. Precedence: CLI > SAP_COOKIE_FILE env > ./cookies.txt
  --auto                    Do not wait for Enter: capture as soon as the cookies are accepted by SAP
                            (checked with a cookie-only request to /sap/bc/adt/discovery)
  --profile-dir <path>      Persistent browser profile (keeps the IdP session, so later logins are faster)
  --yes                     Skip the DEV-ONLY confirmation prompt
  --help, -h                Show this help
`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForDebuggerWebSocketUrl(port: number, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
      }
    } catch {
      // Browser not ready yet.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for browser debugging endpoint on http://127.0.0.1:${port}/json/version`);
}

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function maybePromptConfirmation(skipPrompt: boolean): Promise<void> {
  if (skipPrompt) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(DEV_ONLY_BANNER)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Aborted by user.');
    }
  } finally {
    rl.close();
  }
}

function startBrowser(browserBinary: string, browser: BrowserChoice, url: string, port: number, profileDir: string) {
  const args =
    browser === 'firefox'
      ? ['--remote-debugging-port', String(port), '-profile', profileDir, url]
      : [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          url,
        ];
  return spawn(browserBinary, args, { stdio: 'ignore' });
}

export function cookieMatchesHost(cookieDomain: string, hostname: string): boolean {
  const normalized = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

async function fetchCookiesViaCdp(wsUrl: string, origin: string): Promise<CdpCookie[]> {
  const hostname = new URL(origin).hostname;
  return new Promise<CdpCookie[]>((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    const settleOnce = (resolver: () => void): void => {
      if (settled) return;
      settled = true;
      resolver();
    };

    const rejectAllPending = (error: Error): void => {
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    };

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((resolveSend, rejectSend) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        ws.send(JSON.stringify({ id, method, params }));
      });

    ws.onerror = () => {
      settleOnce(() => rejectPromise(new Error('Failed to connect to browser debugging websocket.')));
      rejectAllPending(new Error('CDP websocket error'));
    };

    ws.onmessage = (event) => {
      const raw =
        typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf-8');
      const msg = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!msg.id) return;
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id);
      if (msg.error) {
        request.reject(new Error(msg.error.message ?? 'Unknown CDP error'));
      } else {
        request.resolve(msg.result);
      }
    };

    ws.onclose = () => {
      if (!settled) {
        settleOnce(() => rejectPromise(new Error('Browser debugging websocket closed unexpectedly.')));
      }
      rejectAllPending(new Error('CDP websocket closed'));
    };

    ws.onopen = async () => {
      try {
        const result = (await send('Storage.getCookies')) as { cookies?: CdpCookie[] };
        ws.close();
        const filtered = (result.cookies ?? []).filter((c) => cookieMatchesHost(c.domain, hostname));
        settleOnce(() => resolvePromise(filtered));
      } catch (error) {
        ws.close();
        const message = error instanceof Error ? error.message : String(error);
        settleOnce(() => rejectPromise(new Error(message)));
      }
    };
  });
}

export function buildCookieHeader(cookies: CdpCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// Checks the cookies the way ARC-1 will use them: outside the browser, without client certificates or Windows SSO.
async function sapAcceptsCookies(origin: string, cookies: CdpCookie[]): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/sap/bc/adt/discovery`, {
      headers: { Cookie: buildCookieHeader(cookies), Accept: 'application/atomsvc+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 200 && (response.headers.get('content-type') ?? '').includes('xml');
  } catch {
    return false;
  }
}

async function waitForAcceptedCookies(wsUrl: string, origin: string, timeoutMs = 300_000): Promise<CdpCookie[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const cookies = await fetchCookiesViaCdp(wsUrl, origin);
      if (cookies.length > 0 && (await sapAcceptsCookies(origin, cookies))) return cookies;
    } catch {
      // Browser still starting or navigating; retry.
    }
    await delay(2000);
  }
  throw new Error(
    `SAP did not accept the browser cookies for ${origin} within ${timeoutMs / 1000}s. ` +
      'The login may use client-certificate or other per-request authentication that cookies cannot carry.',
  );
}

export function formatNetscapeCookieLine(cookie: CdpCookie): string {
  const domain = cookie.domain || '';
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const path = cookie.path || '/';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires = cookie.expires && cookie.expires > 0 ? String(Math.floor(cookie.expires)) : '0';
  return `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expires}\t${cookie.name}\t${cookie.value}`;
}

export function toNetscapeCookieFile(cookies: CdpCookie[]): string {
  const header = ['# Netscape HTTP Cookie File', '# Generated by ARC-1 extract-sap-cookies.ts'];
  const lines = cookies.map(formatNetscapeCookieLine);
  return `${[...header, ...lines].join('\n')}\n`;
}

export function planExtraction(input: ExtractionPlanInput): ExtractionPlan {
  if (input.env.SAP_PP_ENABLED === 'true') {
    throw new Error(PP_REFUSAL_MESSAGE);
  }

  const scriptArgs = parseScriptArgs(input.args);
  const serverArgs = parseServerArgs(input.args, input.env);
  if (!serverArgs.url) {
    throw new Error(
      'Missing SAP URL. Set --url <...> (preferred) or SAP_URL (CLI > env > .env). See --help for usage.',
    );
  }

  const parsedUrl = new URL(serverArgs.url);
  const browserBinary = resolveBrowserBinary(scriptArgs.browser, input.platform);

  return {
    url: serverArgs.url,
    origin: parsedUrl.origin,
    browser: scriptArgs.browser,
    browserBinary,
    outputPath: resolve(input.cwd, scriptArgs.output ?? serverArgs.cookieFile ?? './cookies.txt'),
    profileDir: scriptArgs.profileDir ? resolve(input.cwd, scriptArgs.profileDir) : undefined,
    auto: scriptArgs.auto,
    yes: scriptArgs.yes,
  };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadDotEnv();
  const scriptArgs = parseScriptArgs(argv);
  if (scriptArgs.help) {
    printUsage();
    return;
  }

  const plan = planExtraction({
    args: argv,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
  });

  await maybePromptConfirmation(plan.yes);

  const port = 9222;
  const profileDir = plan.profileDir ?? mkdtempSync(join(tmpdir(), 'arc1-cookie-extract-'));
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  const browserProcess = startBrowser(plan.browserBinary, plan.browser, plan.url, port, profileDir);

  try {
    const wsUrl = await waitForDebuggerWebSocketUrl(port);
    let cookies: CdpCookie[];
    if (plan.auto) {
      process.stderr.write(
        `Browser started (${plan.browser}). Waiting for a login SAP accepts at ${plan.origin} ...\n`,
      );
      cookies = await waitForAcceptedCookies(wsUrl, plan.origin);
    } else {
      process.stderr.write(
        `Browser started (${plan.browser}). Complete login for ${plan.origin}, then press Enter to capture cookies.\n`,
      );
      await waitForEnter('');
      cookies = await fetchCookiesViaCdp(wsUrl, plan.origin);
    }
    if (cookies.length === 0) {
      throw new Error(`No cookies were returned for ${plan.origin}. Ensure you are logged in and try again.`);
    }

    const cookieFileContent = toNetscapeCookieFile(cookies);
    mkdirSync(dirname(plan.outputPath), { recursive: true });
    writeFileSync(plan.outputPath, cookieFileContent, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(plan.outputPath, 0o600);

    process.stderr.write(
      `Cookies written to ${plan.outputPath} with mode 0600. Use with: SAP_COOKIE_FILE=${plan.outputPath} SAP_URL=${plan.url} arc-1. Rotate regularly — cookies expire.\n`,
    );
  } finally {
    browserProcess.kill('SIGTERM');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // No top-level await: the single-executable bundle is CommonJS, which cannot contain one.
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(message === PP_REFUSAL_MESSAGE ? 2 : 1);
  });
}
