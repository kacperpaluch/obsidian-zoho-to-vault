const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, htmlToMarkdown, normalizePath, moment, Platform } = require('obsidian');

const DEFAULTS = {
  region: 'eu',
  accountId: '',
  folderName: 'Inbox',
  senders: '',
  vaultFolder: 'Emails',
  postRoutes: '',
  pollMinutes: 15,
  seen: []
};

const PAGE = 50;
// ponytail: sufit na przebieg = tyle, ile pamiętamy w `seen`. Więcej i tak byśmy zapomnieli
// i pobrali drugi raz. Pierwszy przebieg na pełnym Inboxie dobiera resztę przy kolejnym.
const MAX_PAGES = 10;
const SEEN_KEEP = PAGE * MAX_PAGES;

// --- sekrety: poza vaultem, wiec nie jada przez iCloud ---------------------
const SECRETS = ['clientId', 'clientSecret', 'refreshToken'];
const STORE = 'obsidian-zoho-to-vault';
const useKeychain = () => Platform.isDesktopApp && process.platform === 'darwin';
const storeName = () => (useKeychain() ? 'pęku kluczy macOS' : 'pamięci lokalnej urządzenia');

function security(args) {
  return new Promise((resolve) => {
    require('child_process').execFile('/usr/bin/security', args, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

async function secretGet(key) {
  if (useKeychain()) return (await security(['find-generic-password', '-s', STORE, '-a', key, '-w'])) || '';
  return window.localStorage.getItem(`${STORE}:${key}`) || '';
}

async function secretSet(key, value) {
  if (useKeychain()) {
    // ponytail: sekret leci w argv, wiec przez chwile widac go w `ps`; stdin wymaga trybu interaktywnego `security`
    if (value) await security(['add-generic-password', '-U', '-s', STORE, '-a', key, '-w', value]);
    else await security(['delete-generic-password', '-s', STORE, '-a', key]);
    return;
  }
  if (value) window.localStorage.setItem(`${STORE}:${key}`, value);
  else window.localStorage.removeItem(`${STORE}:${key}`);
}

// r.json to getter robiący JSON.parse — na stronie błędu Zoho (HTML, captcha, zły region)
// rzuca SyntaxError zamiast oddać undefined, więc komunikat gubił prawdziwą przyczynę
const asJson = (r) => {
  try {
    return r.json;
  } catch (e) {
    return null;
  }
};

// --- HTML -> markdown ------------------------------------------------------
function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = String(s || '');
  return el.value;
}

// YAML w cudzysłowie interpretuje escape'y: temat „Faktura C:\dane\" wywalał parser
// i cała ramka properties (z messageId, po którym rozpoznajemy duplikaty) przestawała istnieć
const yamlQuote = (s) => `"${String(s).replace(/\\/g, '/').replace(/"/g, "'").replace(/\s+/g, ' ')}"`;

const safeName = (s, r = '-') => String(s).replace(/[\\/:*?"<>|#^[\]]/g, r).replace(/\s+/g, ' ').trim();

// obrazek inline w mailu to ![](cid:xxx) — bez podmiany zostaje martwy link do niczego
function inlineAttachments(md, byCid) {
  if (!byCid.size) return md;
  return md.replace(/!\[[^\]]*\]\(\s*cid:([^)\s]+)\s*\)/gi, (all, cid) => {
    const name = byCid.get(decodeURIComponent(cid).replace(/^<|>$/g, ''));
    return name ? `![[${name}]]` : all;
  });
}

function addresses(raw) {
  const found = decodeEntities(raw).match(/[^\s<>,;"']+@[^\s<>,;"']+/g);
  return found ? [...new Set(found.map((a) => a.toLowerCase()))] : [];
}

// (?![.\d]) bo inaczej „opacity: 0.9" łapie się jako niewidoczne i kasuje widoczną treść
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/i;

// preheader newslettera — „Nie widzisz obrazków? Otwórz w przeglądarce" plus ciąg &nbsp; —
// jest w HTML-u schowany stylem, a w notatce lądował jako pierwsza linijka treści
function removeHidden(root) {
  for (const el of Array.from(root.querySelectorAll('[aria-hidden="true"], [style]'))) {
    if (el.getAttribute('aria-hidden') === 'true' || HIDDEN_STYLE.test(el.getAttribute('style') || '')) el.remove();
  }
}

// tabela z danymi: przyznaje się nagłówkami i nie ma nikogo w środku. Reszta to układ strony.
// role="presentation" mówi to wprost, brak <th> zdradza układ, a zagnieżdżona tabela w środku
// to już na pewno szkielet newslettera, nie faktura.
function isDataTable(t) {
  return t.getAttribute('role') !== 'presentation' && !!t.querySelector('th') && !t.querySelector('table');
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

// tylko własne wiersze i komórki — te z tabeli zagnieżdżonej zostawiamy jej samej,
// bo dostanie swoją kolejkę w pętli i sama zdecyduje, czy jest układem
function unwrapTable(t) {
  for (const el of Array.from(t.querySelectorAll('tbody, thead, tfoot, tr, td, th'))) {
    if (el.closest('table') !== t) continue;
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      // komórka na <div>, żeby sąsiednie bloki treści nie skleiły się w jeden akapit
      const div = el.ownerDocument.createElement('div');
      while (el.firstChild) div.appendChild(el.firstChild);
      el.replaceWith(div);
    } else unwrap(el);
  }
  unwrap(t);
}

function tidyTables(root) {
  for (const t of Array.from(root.querySelectorAll('table'))) {
    // tabela bez ani jednego wiersza rozpakowywała się w pusty szkielet |||
    if (!t.querySelector('tr')) t.remove();
    else if (!isDataTable(t)) unwrapTable(t);
  }
}

// Newsletter Substacka: kanoniczny adres posta. W mailu bywa i wersja open.substack.com/pub/X/p/slug,
// i zwykła X.substack.com/p/slug z ogonem utm — z obu robimy ten sam adres, co daje Web Clipper.
const POST_URL = /https?:\/\/(?:open\.substack\.com\/pub\/([a-z0-9-]+)|([a-z0-9-]+)\.substack\.com)\/p\/([a-z0-9%_-]+)/i;
function postUrl(html) {
  const m = POST_URL.exec(String(html || ''));
  return m ? `https://${m[1] || m[2]}.substack.com/p/${m[3]}` : '';
}

const DRIVE_FILE = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^)"\s]*id=)([\w-]{20,})/g;
const DRIVE_FOLDER = /https:\/\/drive\.google\.com\/drive\/folders\/([\w-]{20,})/g;

// Trasa newslettera na linię: „folder w Zoho > folder/w/vaulcie/{YYYY}"
function parseRoutes(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.split(/\s*[>→]\s*/))
    .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
    .map((p) => ({ name: p[0].trim(), vault: p[1].trim(), senders: '', post: true }));
}

// „View in browser" to substack.com/redirect/2/<base64>, a w środku JSON z prawdziwym adresem posta
// i tokenem subskrybenta (ważny ~30 dni). Ten token otwiera też płatny post bez logowania.
function tokenUrl(html) {
  const m = /substack\.com\/redirect\/2\/([A-Za-z0-9_-]+)/.exec(String(html || ''));
  if (!m) return '';
  try {
    const b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const url = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4))).e;
    return /^https:\/\/[a-z0-9-]+\.substack\.com\/p\//i.test(url) ? url : '';
  } catch (e) {
    return '';
  }
}

// Chrom maila Substacka: nagłówek (View in browser, logo, tytuł, autor, „READ IN APP") i stopka
// (Like/Comment/Restack, adres, Unsubscribe, piksel). Rozpoznajemy go po utm-ach w linkach, nie po
// klasach — szablon maila ma inne klasy niż strona, a utm-y Substack trzyma od lat.
// ponytail: cięcie na liniach markdownu, nie na drzewie DOM. Gdy któryś marker zniknie, zostaje
// nadmiar, nie ubytek — i widać to gołym okiem w notatce.
// Stopkę mailingów spoza Substacka (Mailchimp) łapiemy po „Copyright ©" i linku wypisu.
const HEAD = ['utm_campaign=email-read-in-app', 'utm_source=post-email-title'];
const TAIL = ['submitLike=true', 'action/disable_email', 'Copyright ©', 'list-manage.com/unsubscribe'];
const IMG_LINE = /^\s*!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])\s*$/;
const EMOJI_PREFIX = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;
function trimChrome(md) {
  const lines = String(md).split('\n');
  let head = -1;
  let tail = lines.length;
  lines.forEach((l, i) => {
    if (HEAD.some((m) => l.includes(m))) head = i;
    if (i < tail && TAIL.some((m) => l.includes(m))) tail = i;
  });
  const out = lines.slice(head + 1, tail);
  // stopka mailingu to zwykle jeszcze pasek ikonek — same obrazki na końcu lecą razem z nią.
  // Treść ze strony (postFromWeb) tędy nie idzie, więc post kończący się zdjęciem nic nie traci.
  while (out.length && (!out[out.length - 1].trim() || IMG_LINE.test(out[out.length - 1]))) out.pop();
  return out
    .join('\n')
    .replace(/\n[ \t]+\n/g, '\n') // Substack pakuje akapit w <li>, przez co listy robią się „luźne" — zbijamy z powrotem
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMd(html) {
  try {
    // DOMParser, nie innerHTML: dokument jest inertny. Przez innerHTML Chromium startuje pobieranie
    // obrazków (piksel śledzący meldowałby się PRZED usunięciem niżej, razem z IP), a <img onerror>
    // z cudzego maila odpalałby się w rendererze Obsidiana, czyli z dostępem do Node'a.
    const root = new DOMParser().parseFromString(String(html || ''), 'text/html').body;
    root.querySelectorAll('style, script, meta, link, title').forEach((el) => el.remove());
    removeHidden(root);
    root.querySelectorAll('img').forEach((el) => {
      const w = Number(el.getAttribute('width'));
      const h = Number(el.getAttribute('height'));
      if ((w && w <= 2) || (h && h <= 2)) el.remove(); // piksele sledzace
    });
    // klikalna grafika daje [![](src)](url), a po podmianie na wikilink [![[x.png]]](url) — Obsidian tego nie renderuje.
    // Link i tak prowadzi do przekierowania sledzacego, wiec zostaje sam obrazek.
    root.querySelectorAll('a').forEach((a) => {
      if (!a.textContent.trim()) a.replaceWith(...a.childNodes);
      // kotwica z tekstem i ikonka: obrazek przed link, zeby oba dalo sie wyrenderowac
      else a.querySelectorAll('img').forEach((img) => a.parentNode.insertBefore(img, a));
    });
    tidyTables(root);
    return htmlToMarkdown(root.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) {
    // turndown potrafi paść na popsutym HTML (np. <tr> bez komórek) — wtedy goły tekst zamiast utraty maila
    console.warn('[zoho] htmlToMarkdown padł, zapisuję bez formatowania:', e.message);
    const body = new DOMParser().parseFromString(String(html || ''), 'text/html').body;
    return (body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }
}

module.exports = class ZohoToVault extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    this.secrets = {};

    let migrated = false;
    for (const k of SECRETS) {
      if (data[k]) {
        await secretSet(k, data[k]);
        migrated = true;
      }
      delete this.settings[k];
      this.secrets[k] = await secretGet(k);
    }
    if (migrated) {
      await this.saveData(this.settings);
      new Notice(`Zoho: dane logowania przeniesione z data.json do ${storeName()}.`, 8000);
    }

    // stare pojedyncze pola newslettera → lista tras
    if (this.settings.postFolder) {
      this.settings.postRoutes = `${this.settings.postFolder} > ${this.settings.postVaultFolder || 'Newslettery/{YYYY}'}`;
      delete this.settings.postFolder;
      delete this.settings.postVaultFolder;
      await this.saveData(this.settings);
    }

    this.addSettingTab(new ZohoSettingTab(this.app, this));
    this.addRibbonIcon('mail', 'Pobierz maile z Zoho', () => this.sync(true));
    this.addCommand({ id: 'sync', name: 'Pobierz maile z Zoho', callback: () => this.sync(true) });
    this.addCommand({ id: 'sync-posts', name: 'Zoho: pobierz 2 ostatnie newslettery (test)', callback: () => this.syncLatestPosts(2) });
    this.addCommand({ id: 'debug', name: 'Zoho: diagnostyka (wynik w konsoli)', callback: () => this.debug() });
    this.addCommand({ id: 'selftest', name: 'Zoho: test konwersji HTML', callback: () => selfTest() });
    this.schedule();
    this.app.workspace.onLayoutReady(() => this.sync(false));
  }

  schedule() {
    if (this.timer) window.clearInterval(this.timer);
    const min = Number(this.settings.pollMinutes) || 0;
    if (min > 0) this.timer = this.registerInterval(window.setInterval(() => this.sync(false), min * 60000));
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    const { clientId, clientSecret, refreshToken } = this.secrets;
    if (!clientId || !clientSecret || !refreshToken) throw new Error('Uzupełnij client ID, secret i refresh token w ustawieniach.');
    const r = await requestUrl({
      url: `https://accounts.zoho.${this.settings.region}/oauth/v2/token`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      throw: false,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      }).toString()
    });
    const j = asJson(r);
    const token = j && j.access_token;
    if (!token) throw new Error('Nie udało się odświeżyć tokenu: ' + r.text.slice(0, 200));
    this.token = { value: token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
    return token;
  }

  async api(path, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const r = await requestUrl({
      url: `https://mail.zoho.${this.settings.region}/api${path}${qs}`,
      headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}` },
      throw: false
    });
    const j = asJson(r);
    if (r.status !== 200 || !j) throw new Error(`${path} → HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    return j.data;
  }

  // api() parsuje JSON, a załącznik przychodzi jako octet-stream
  async raw(path) {
    const r = await requestUrl({
      url: `https://mail.zoho.${this.settings.region}/api${path}`,
      headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}` },
      throw: false
    });
    if (r.status !== 200) throw new Error(`${path} → HTTP ${r.status}`);
    return r.arrayBuffer;
  }

  // ponytail: załączniki lądują w podfolderze notatek pod nazwą z messageId, a nie tam, gdzie
  // wskazuje ustawienie vaulta — nazwa musi być deterministyczna, inaczej „Pobierz wszystko
  // od nowa" dokłada kopię przy każdym przebiegu. getAvailablePathForAttachment, jeśli kiedyś
  // będzie ważniejsze, gdzie leżą, niż to, żeby się nie mnożyły.
  async saveAttachments(folderId, m) {
    const base = `/accounts/${this.settings.accountId}/folders/${folderId}/messages/${m.messageId}`;
    const info = (await this.api(`${base}/attachmentinfo`, { includeInline: true })) || {};
    const all = [...(info.attachments || []), ...(info.inline || [])];
    if (!all.length) return { links: [], byCid: new Map() };

    const dir = normalizePath(`${normalizePath(this.settings.vaultFolder)}/zalaczniki`);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => {});

    const links = [];
    const byCid = new Map();
    for (const a of all) {
      const name = `${m.messageId} ${safeName(a.attachmentName || a.attachmentId)}`;
      const path = normalizePath(`${dir}/${name}`);
      if (!(await adapter.exists(path))) {
        await this.app.vault.createBinary(path, await this.raw(`${base}/attachments/${a.attachmentId}`));
      }
      if (a.cid) byCid.set(String(a.cid).replace(/^<|>$/g, ''), name);
      else links.push(`![[${name}]]`);
    }
    return { links, byCid };
  }

  async resolveFolder(name) {
    const s = this.settings;
    name = name || s.folderName;
    if (!s.accountId) s.accountId = (await this.api('/accounts'))[0].accountId;
    const folders = await this.api(`/accounts/${s.accountId}/folders`);
    const want = name.trim().toLowerCase().replace(/^\//, '');
    const folder = folders.find((f) => [f.folderName, f.path].some((v) => (v || '').toLowerCase().replace(/^\//, '') === want));
    if (!folder) throw new Error(`Brak folderu "${name}". Dostępne: ${folders.map((f) => f.folderName).join(', ')}`);
    return folder;
  }

  // trasy: zwykła poczta + dowolna liczba folderów z newsletterami, każdy do swojego miejsca w vaulcie
  routes() {
    const s = this.settings;
    const list = [{ name: s.folderName, vault: s.vaultFolder, senders: s.senders, post: false }];
    return list.concat(parseRoutes(s.postRoutes));
  }

  async sync(manual, overwrite) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const s = this.settings;
      const seen = new Set(s.seen);
      let saved = 0;
      let failed = 0;

      for (const route of this.routes()) {
        // zła nazwa folderu w jednej trasie nie może zablokować pozostałych
        let folder;
        try {
          folder = await this.resolveFolder(route.name);
        } catch (e) {
          failed++;
          new Notice('Zoho → Vault: ' + e.message, 10000);
          continue;
        }
        const senders = route.senders.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);

        // strona po stronie od najnowszych, aż trafimy na znaną wiadomość albo koniec folderu —
        // bez tego nadmiar ponad jedną stronę wypadał poza okno i nie wracał już nigdy
        const fresh = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const batch = await this.api(`/accounts/${s.accountId}/messages/view`, {
            folderId: folder.folderId, start: page * PAGE + 1, limit: PAGE, sortBy: 'date', sortorder: false
          });
          if (!batch || !batch.length) break;
          const before = fresh.length;
          for (const m of batch) {
            if (seen.has(m.messageId)) continue;
            seen.add(m.messageId); // strony mogą się przesunąć, gdy w trakcie przyjdzie nowa poczta
            fresh.push(m);
          }
          if (fresh.length - before < batch.length || batch.length < PAGE) break;
        }

        for (const m of fresh.reverse()) {
          // widok folderu zwraca całe wątki — kopie z Wysłanych mają własne folderId
          const from = (m.fromAddress || '').toLowerCase();
          if (String(m.folderId) !== String(folder.folderId) || (senders.length && !senders.some((x) => from.includes(x)))) {
            // pominięte też zapamiętujemy, inaczej filtr nadawców kazałby przewijać MAX_PAGES za każdym
            // razem. Po zmianie filtru użyj „Pobierz wszystko od nowa".
            s.seen.push(m.messageId);
            continue;
          }
          try {
            if (route.post) await this.savePost(folder.folderId, m, overwrite, route);
            else await this.saveNote(folder.folderId, m, overwrite);
            s.seen.push(m.messageId);
            saved++;
          } catch (e) {
            // jedna felerna wiadomość nie może ubić całego przebiegu; przy następnym pobraniu spróbujemy znowu
            failed++;
            console.error('[zoho] pominięto', m.messageId, m.subject, e);
          }
        }
      }
      if (manual || failed) {
        new Notice([
          saved ? `Zapisano ${saved} wiadomości.` : 'Brak nowych wiadomości.',
          failed ? `Pominięto ${failed} z błędem — szczegóły w konsoli.` : ''
        ].join(' ').trim(), failed ? 10000 : 4000);
      }
    } catch (e) {
      new Notice('Zoho → Vault: ' + e.message, 10000);
      console.error(e);
    } finally {
      // ponytail: ostatnie SEEN_KEEP ID jako deduplikacja; przejdź na receivedTime jeśli folder kiedyś urośnie
      this.settings.seen = this.settings.seen.slice(-SEEN_KEEP);
      await this.saveData(this.settings);
      this.syncing = false;
    }
  }

  // test: ostatnie N newsletterów z pominięciem listy „widzianych", z nadpisaniem notatki
  async syncLatestPosts(limit) {
    const routes = this.routes().filter((r) => r.post);
    if (!routes.length) return new Notice('Najpierw dodaj trasę newslettera w ustawieniach.', 6000);
    try {
      let n = 0;
      for (const route of routes) {
        const folder = await this.resolveFolder(route.name);
        const msgs = await this.api(`/accounts/${this.settings.accountId}/messages/view`, {
          folderId: folder.folderId, limit, sortBy: 'date', sortorder: false
        });
        for (const m of msgs) await this.savePost(folder.folderId, m, true, route);
        n += msgs.length;
      }
      new Notice(n ? `Pobrano ${n} newsletterów (nadpisane).` : 'Foldery newsletterów są puste.', 8000);
    } catch (e) {
      new Notice('Błąd: ' + e.message, 10000);
      console.error(e);
    }
  }

  async debug() {
    try {
      const s = this.settings;
      const folder = await this.resolveFolder();
      const folders = await this.api(`/accounts/${s.accountId}/folders`);
      const msgs = await this.api(`/accounts/${s.accountId}/messages/view`, {
        folderId: folder.folderId, limit: 10, sortBy: 'date', sortorder: false
      });
      console.log('[zoho] sekrety w:', storeName(), '| wybrany folder:', folder.folderName, folder.folderId);
      console.log('[zoho] foldery:', folders.map((f) => `${f.folderName}=${f.folderId}`).join(' '));
      console.table(msgs.map((m) => ({
        data: moment(Number(m.receivedTime || m.receivedtime || m.sentDateInGMT)).format('YYYY-MM-DD HH:mm'),
        folderId: m.folderId,
        from: m.fromAddress,
        subject: (m.subject || '').slice(0, 40),
        widziany: s.seen.includes(m.messageId)
      })));
      new Notice('Diagnostyka w konsoli (Cmd+Opt+I → Console).', 8000);
    } catch (e) {
      new Notice('Błąd: ' + e.message, 10000);
      console.error(e);
    }
  }

  // Załączniki newslettera (np. „Newsletter 258.pdf") lądują tam, gdzie Obsidian trzyma załączniki,
  // pod oryginalną nazwą — przy ponownym pobraniu trafiamy w ten sam plik zamiast robić kopię.
  // Obrazki wklejone w treść (cid:) dostają prefiks z ID wiadomości, bo „image001.png" ma każdy mail.
  async savePostAttachments(folderId, m, notePath) {
    const base = `/accounts/${this.settings.accountId}/folders/${folderId}/messages/${m.messageId}`;
    const info = (await this.api(`${base}/attachmentinfo`, { includeInline: true })) || {};
    const links = [];
    const byCid = new Map();
    for (const a of [...(info.attachments || []), ...(info.inline || [])]) {
      const cid = a.cid ? String(a.cid).replace(/^<|>$/g, '') : '';
      const name = (cid ? `${m.messageId} ` : '') + safeName(a.attachmentName || a.attachmentId, '_');
      const full = await this.app.fileManager.getAvailablePathForAttachment(name, notePath);
      const dir = normalizePath(normalizePath(full).replace(/\/[^/]+$/, ''));
      if (dir && dir !== '/' && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      const path = normalizePath(`${dir}/${name}`);
      if (!(await this.app.vault.adapter.exists(path))) {
        await this.app.vault.createBinary(path, await this.raw(`${base}/attachments/${a.attachmentId}`));
      }
      if (cid) byCid.set(cid, name);
      else links.push(`[[${name}]]`);
    }
    return { links, byCid };
  }

  // Pliki z Google Drive'a (PDF z lekcją, nagranie) ściągamy do vaulta i podmieniamy link na [[wikilink]].
  // Plik udostępniony „dla każdego z linkiem" pobiera się bez logowania, razem z oryginalną nazwą
  // w Content-Disposition. Ograniczony odda stronę HTML — wtedy zostawiamy zwykły link i tyle.
  async driveFile(id, notePath) {
    const r = await requestUrl({ url: `https://drive.google.com/uc?export=download&id=${id}`, throw: false });
    const head = (k) => String(r.headers[k] || r.headers[k.replace(/(^|-)([a-z])/g, (x, c, l) => c + l.toUpperCase())] || '');
    if (r.status !== 200 || /text\/html/i.test(head('content-type'))) return '';
    const found = /filename\*?=(?:UTF-8'')?"?([^";]+)/.exec(head('content-disposition'));
    let name = safeName(decodeURIComponent(found ? found[1] : `${id}.bin`), '_');
    const full = await this.app.fileManager.getAvailablePathForAttachment(name, notePath);
    const dir = normalizePath(normalizePath(full).replace(/\/[^/]+$/, ''));
    const adapter = this.app.vault.adapter;
    if (dir && dir !== '/' && !(await adapter.exists(dir))) await adapter.mkdir(dir);
    // ta sama nazwa w dwóch newsletterach („recording.mp3") to dwa różne pliki — rozróżniamy po rozmiarze
    if (await adapter.exists(`${dir}/${name}`)) {
      const stat = await adapter.stat(`${dir}/${name}`);
      if (!stat || stat.size !== r.arrayBuffer.byteLength) name = name.replace(/(\.[^.]+)?$/, ` ${id.slice(0, 6)}$1`);
    }
    const path = normalizePath(`${dir}/${name}`);
    if (!(await adapter.exists(path))) await this.app.vault.createBinary(path, r.arrayBuffer);
    return name;
  }

  // ponytail: listę plików w publicznym folderze skrobiemy z HTML-a (`data-id`), bo Drive bez klucza API
  // nie ma się jak zapytać. Zmieni się markup → lista wyjdzie pusta i zostaje zwykły link, nic nie ginie.
  // Limit 3 plików, żeby link do archiwum całego newslettera nie ściągnął pół gigabajta.
  async driveFolder(id) {
    const r = await requestUrl({ url: `https://drive.google.com/drive/folders/${id}`, throw: false });
    if (r.status !== 200) return [];
    const ids = [...new Set([...r.text.matchAll(/data-id="([\w-]{20,})"/g)].map((m) => m[1]))];
    return ids.length > 3 ? [] : ids;
  }

  // link (albo goły adres) z tym ID → wikilinki do pobranych plików. Adres Drive'a bywa w treści linku,
  // a w href siedzi przekierowanie mailingu, więc łapiemy ID po obu stronach.
  async localizeDrive(md, notePath) {
    const jobs = new Map(); // ten sam link dwa razy w mailu = jedno pobranie
    for (const m of md.matchAll(DRIVE_FOLDER)) jobs.set(m[1], { id: m[1], folder: true });
    for (const m of md.matchAll(DRIVE_FILE)) if (!jobs.has(m[1])) jobs.set(m[1], { id: m[1], folder: false });
    for (const job of jobs.values()) {
      try {
        const files = job.folder ? await this.driveFolder(job.id) : [job.id];
        const names = [];
        for (const f of files) {
          const name = await this.driveFile(f, notePath);
          if (name) names.push(`[[${name}]]`);
        }
        if (!names.length) continue;
        const rx = new RegExp(`!?\\[[^\\]]*${job.id}[^\\]]*\\]\\([^)]*\\)|!?\\[[^\\]]*\\]\\([^)]*${job.id}[^)]*\\)|https://drive\\.google\\.com/[^\\s)]*${job.id}[^\\s)]*`, 'g');
        const src = job.folder ? `https://drive.google.com/drive/folders/${job.id}` : `https://drive.google.com/file/d/${job.id}/view`;
        md = md.replace(rx, `${names.join(' ')} ([Drive](${src}))`);
      } catch (e) {
        console.warn('[zoho] nie pobrałem z Drive', job.id, e.message);
      }
    }
    return md;
  }

  // Treść ze strony posta zamiast z maila: hrefy są tam prawdziwe (w mailu każdy link idzie przez
  // substack.com/redirect z tokenem klikowym), jest podpis pod obrazkiem i nie trzeba zgadywać, gdzie
  // kończy się chrom. Gdy token wygaśnie albo Substack zmieni szablon — wracamy do treści maila.
  async postFromWeb(html) {
    const url = tokenUrl(html);
    if (!url) return '';
    const r = await requestUrl({ url, throw: false });
    if (r.status !== 200) return '';
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const body = doc.querySelector('.available-content .body.markup') || doc.querySelector('.body.markup');
    if (!body || doc.querySelector('.paywall')) return ''; // token wygasł, mamy tylko zajawkę
    body.querySelectorAll('.subscription-widget-wrap, .subscription-widget-wrap-editor, .button-wrapper, .digest-post-embed, .comments-section, svg').forEach((el) => el.remove());
    const cover = doc.querySelector('meta[property="og:image"]');
    const md = htmlToMd(body.innerHTML);
    return cover ? `![](${cover.getAttribute('content')})\n\n${md}` : md;
  }

  // Newsletter → notatka jak z Web Clippera: tytuł w nazwie pliku, frontmatter title/source/published,
  // rocznik w ścieżce. Obrazki zostają zdalnymi adresami — Local Images Plus ściąga je po utworzeniu
  // notatki. Pełną treść ma tylko mail: post na stronie jest za paywallem.
  async savePost(folderId, m, overwrite, route) {
    const { content } = await this.api(`/accounts/${this.settings.accountId}/folders/${folderId}/messages/${m.messageId}/content`);
    const when = moment(Number(m.receivedTime || m.receivedtime || m.sentDateInGMT || Date.now()));
    const subject = decodeEntities(m.subject || '').trim().replace(EMOJI_PREFIX, '') || '(bez tematu)';
    const dir = normalizePath(String(route.vault).replace(/\{(Y+|M+|D+)\}/g, (_, f) => when.format(f)));
    const adapter = this.app.vault.adapter;
    if (dir && dir !== '/' && !(await adapter.exists(dir))) await adapter.mkdir(dir);
    // podkreślnik zamiast myślnika, bo tak nazwał pliki Web Clipper — inaczej stare posty dublują się nową nazwą
    const name = safeName(subject, '_').slice(0, 140).replace(/^[.\s]+|[.\s]+$/g, '');
    let path = normalizePath(`${dir}/${name}.md`);
    if ((await adapter.exists(path)) && !overwrite) return;

    const { links, byCid } = await this.savePostAttachments(folderId, m, path);
    let body = (await this.postFromWeb(content).catch(() => '')) || inlineAttachments(trimChrome(htmlToMd(content)), byCid);
    body = await this.localizeDrive(body, path).catch(() => body);

    // numer wydania z nagłówka treści („**#258**") na początek nazwy — tak są ponumerowane
    // notatki z tych newsletterów, które numer mają. Nie ma numeru, nie ma prefiksu.
    const issue = /^\s*\*\*#?(\d{1,4})\*\*\s*$/m.exec(body.split('\n').slice(0, 20).join('\n'));
    if (issue) path = normalizePath(`${dir}/${issue[1]} - ${name}.md`);
    if ((await adapter.exists(path)) && !overwrite) return;

    const url = postUrl(content);
    const yaml = ['---', `title: ${yamlQuote(subject)}`];
    if (url) yaml.push(`source: "${url}"`);
    yaml.push(`published: ${when.format('YYYY-MM-DD')}`, 'Anki: false', '---', '');
    const note = yaml.join('\n') + '\n' + (links.length ? links.join('\n') + '\n\n' : '') + body + '\n';
    if (await adapter.exists(path)) await adapter.write(path, note);
    else await this.app.vault.create(path, note);
  }

  async saveNote(folderId, m, overwrite) {
    const { content } = await this.api(`/accounts/${this.settings.accountId}/folders/${folderId}/messages/${m.messageId}/content`);
    const when = moment(Number(m.receivedTime || m.receivedtime || m.sentDateInGMT || Date.now()));
    const subject = decodeEntities(m.subject || '').trim();
    const title = safeName(`${when.format('YYYY-MM-DD HH-mm')} ${subject || '(bez tematu)'}`)
      .slice(0, 120)
      .replace(/^[.\s]+|[.\s]+$/g, '');
    const dir = normalizePath(this.settings.vaultFolder);
    const adapter = this.app.vault.adapter;
    if (dir && dir !== '/' && !(await adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => {});
    let path = normalizePath(`${dir}/${title}.md`);
    let existing = null;
    // pytamy dysk, nie cache Obsidiana — ten bywa nieaktualny po zmianach spoza aplikacji
    if (await adapter.exists(path)) {
      const onDisk = await adapter.read(path);
      if (onDisk.includes(`messageId: "${m.messageId}"`)) existing = path;
      else {
        // nazwę zajęła inna wiadomość — nasza dostaje sufiks z ID, więc jeśli TEN plik już jest,
        // to jest nasz. Bez tego vault.create() rzucał „File already exists" przy każdym przebiegu.
        path = normalizePath(`${dir}/${title} ${m.messageId}.md`);
        if (await adapter.exists(path)) existing = path;
      }
    }
    if (existing && !overwrite) return; // mamy juz te wiadomosc

    const yaml = ['---'];
    const list = (key, arr) => {
      if (!arr.length) return;
      yaml.push(`${key}:`);
      arr.forEach((v) => yaml.push(`  - ${v}`));
    };
    list('from', addresses(m.fromAddress));
    list('to', addresses(m.toAddress));
    list('cc', addresses(m.ccAddress));
    yaml.push(`subject: ${yamlQuote(subject)}`);
    yaml.push(`date: ${when.format('YYYY-MM-DDTHH:mm:ss')}`);
    yaml.push(`messageId: "${m.messageId}"`);
    yaml.push('---', '');

    const { links, byCid } = await this.saveAttachments(folderId, m);
    const body = inlineAttachments(htmlToMd(content), byCid);
    const note = [yaml.join('\n'), body, links.length ? '\n## Załączniki\n\n' + links.join('\n') : ''].join('\n').trimEnd() + '\n';
    if (existing) await adapter.write(existing, note);
    else await this.app.vault.create(path, note);
  }
};

// jedyny sprawdzian: uruchamialny w Obsidianie, bo logika potrzebuje prawdziwego DOM
function selfTest() {
  const cases = [];
  const check = (name, ok) => cases.push(`${ok ? 'OK  ' : 'FAIL'} ${name}`);

  check('adresy: encje + nawiasy', addresses('&quot;Paluch Kacper&quot;&lt;kacper@paluch.cc&gt;').join() === 'kacper@paluch.cc');
  check('adresy: kilka', addresses('a@x.pl, "B" <b@y.pl>').join() === 'a@x.pl,b@y.pl');
  check('adresy: puste', addresses('').length === 0);

  const layout = htmlToMd('<table><tr><td><table><tr><td>Cześć</td></tr></table></td></tr></table><p>tekst</p>');
  check('tabela układu rozpakowana', !layout.includes('|') && layout.includes('Cześć'));

  const data = htmlToMd('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  check('tabela z danymi zostaje tabelą', data.includes('|') && data.includes('1') && data.includes('B'));

  const presentation = htmlToMd('<table role="presentation"><tr><th>A</th></tr><tr><td>1</td></tr></table>');
  check('role=presentation mimo th rozpakowana', !presentation.includes('|') && presentation.includes('1'));

  const outer = htmlToMd('<table><tr><th>A</th></tr><tr><td><table><tr><td>w środku</td></tr></table></td></tr></table>');
  check('tabela z tabelą w środku to układ', !outer.includes('|') && outer.includes('w środku'));

  const empty = htmlToMd('<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table><p>hej</p>');
  check('pusta tabela nie zostawia szkieletu', !empty.includes('|') && empty.includes('hej'));

  check('tabela bez wierszy usunięta', htmlToMd('<table><tbody></tbody></table><p>hej</p>').trim() === 'hej');

  check('ukryty preheader wycięty', !htmlToMd('<div style="display:none">preheader</div><p>hej</p>').includes('preheader'));
  check('opacity:0 wycięte', !htmlToMd('<div style="opacity: 0">niewidoczne</div><p>hej</p>').includes('niewidoczne'));
  check('aria-hidden wycięty', !htmlToMd('<span aria-hidden="true">ikona</span><p>hej</p>').includes('ikona'));
  check('zwykły style zostaje', htmlToMd('<div style="color:red">widoczne</div>').includes('widoczne'));
  check('opacity 0.9 to nie ukryte', htmlToMd('<div style="opacity:0.9">prawie widoczne</div>').includes('prawie widoczne'));

  const cids = new Map([['logo@x', '123 logo.png']]);
  check('cid podmieniony na wikilink', inlineAttachments('![](cid:logo@x)', cids) === '![[123 logo.png]]');
  check('nieznany cid zostaje', inlineAttachments('![](cid:inny)', cids) === '![](cid:inny)');
  check('bez załączników treść nietknięta', inlineAttachments('![](cid:logo@x)', new Map()) === '![](cid:logo@x)');

  const linked = htmlToMd('<a href="http://track/x"><img src="http://x/a.png"></a>');
  check('grafika wyjęta z linku', linked.startsWith('![') && !linked.startsWith('[!'));
  check('link z tekstem zachowany', htmlToMd('<a href="http://x/">klik</a>').includes('[klik]'));

  const nested = htmlToMd('<table><tr><td><table><tr><td>środek</td></tr></table></td></tr></table>');
  check('zagnieżdżona tabela rozpakowana', !nested.includes('|') && nested.includes('środek'));
  check('ikonka wyjęta przed link', htmlToMd('<a href="http://x/"><img src="http://x/i.png">Faktura</a>').startsWith('!['));

  check('piksel śledzący usunięty', !htmlToMd('<img src="http://x/p.gif" width="1" height="1"><p>hej</p>').includes('p.gif'));
  check('style wycięte', !htmlToMd('<style>a{color:red}</style><p>hej</p>').includes('color'));
  check('popsuty HTML nie wywala', typeof htmlToMd('<table><tr></table><p>hej</p>') === 'string');

  check('adres posta z open.substack.com', postUrl('<a href="https://open.substack.com/pub/mowbiznesowo/p/jak-wyciskac?utm_source=x">') === 'https://mowbiznesowo.substack.com/p/jak-wyciskac');
  check('adres posta bez utm', postUrl('http://mowbiznesowo.substack.com/p/slug-2') === 'https://mowbiznesowo.substack.com/p/slug-2');
  check('brak adresu posta', postUrl('<p>hej</p>') === '');
  const mail = [
    '[View in browser](https://substack.com/redirect/2/abc)',
    '# [Tytuł](https://substack.com/app-link/post?utm_source=post-email-title&r=1)',
    'Sep 7',
    '[READ IN APP](https://open.substack.com/pub/x/p/y?utm_campaign=email-read-in-app)',
    '',
    'treść posta',
    '',
    '![](x.png)[Like](https://substack.com/app-link/post?submitLike=true)',
    '© 2026 ktoś',
    '[Unsubscribe](https://substack.com/redirect/2/action/disable_email)'
  ].join('\n');
  check('chrom maila wycięty', trimChrome(mail) === 'treść posta');
  check('sam tytuł tnie, gdy brak READ IN APP', trimChrome('# [T](https://x/?utm_source=post-email-title)\n\ntreść') === 'treść');
  check('link do pliku na Drive', [...'[a](https://drive.google.com/file/d/1nZP7k_LRwLAbnE_bNhiXyGQK3f0NZ9e9/view?usp=sharing)'.matchAll(DRIVE_FILE)][0][1] === '1nZP7k_LRwLAbnE_bNhiXyGQK3f0NZ9e9');
  check('krótkie id to nie Drive', [...'https://drive.google.com/file/d/abc/view'.matchAll(DRIVE_FILE)].length === 0);
  check('folder to nie plik', [...'https://drive.google.com/drive/folders/1qStkXMuBq7FVIvVZla9nRU4VcdBSOAcP'.matchAll(DRIVE_FILE)].length === 0);
  check('folder rozpoznany', [...'https://drive.google.com/drive/folders/1qStkXMuBq7FVIvVZla9nRU4VcdBSOAcP?usp=sharing'.matchAll(DRIVE_FOLDER)][0][1] === '1qStkXMuBq7FVIvVZla9nRU4VcdBSOAcP');
  check('trasa z linii', JSON.stringify(parseRoutes('A > B/{YYYY}')) === JSON.stringify([{ name: 'A', vault: 'B/{YYYY}', senders: '', post: true }]));
  check('dwie trasy, puste linie pominięte', parseRoutes('A > B\n\nC → D').length === 2);
  check('linia bez strzałki pominięta', parseRoutes('samo A').length === 0);

  const payload = btoa(JSON.stringify({ e: 'https://mowbiznesowo.substack.com/p/slug?token=abc' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('adres z tokenem z „View in browser"', tokenUrl(`<a href="https://substack.com/redirect/2/${payload}">`) === 'https://mowbiznesowo.substack.com/p/slug?token=abc');
  check('cudzy adres w redirekcie odrzucony', tokenUrl(`<a href="https://substack.com/redirect/2/${btoa('{"e":"https://zlo.example/x"}')}">`) === '');
  check('popsuty base64 nie wywala', tokenUrl('<a href="https://substack.com/redirect/2/!!!">') === '');
  check('stopka mailchimpa ucięta', trimChrome('treść\n\n_Copyright © 2026 ktoś_\n[wypisz](https://x.list-manage.com/unsubscribe?u=1)') === 'treść');
  check('ikonki stopki z końca ucięte', trimChrome('treść\n\n![](http://x/i.png)\n\n![[y.png]]') === 'treść');
  check('obrazek w środku zostaje', trimChrome('![](http://x/a.png)\n\ntreść').includes('a.png'));
  check('emoji z początku tematu', '🥑 Keto vs reszta'.replace(EMOJI_PREFIX, '') === 'Keto vs reszta');
  check('emoji w środku tematu zostaje', 'Keto 🥑 i reszta'.replace(EMOJI_PREFIX, '') === 'Keto 🥑 i reszta');
  check('lista zbita z powrotem', trimChrome('- a\n    \n- b') === '- a\n- b');
  check('bez markerów treść nietknięta', trimChrome('zwykły\n\nnewsletter') === 'zwykły\n\nnewsletter');

  check('temat z backslashem nie psuje YAML', yamlQuote('Faktura C:\\dane\\') === '"Faktura C:/dane/"');
  check('temat z nową linią w jednej linii', yamlQuote('a\nb') === '"a b"');
  check('cudzysłów w temacie', yamlQuote('re: "pilne"') === `"re: 'pilne'"`);

  console.log('[zoho] test konwersji:\n' + cases.join('\n'));
  new Notice(cases.every((c) => c.startsWith('OK')) ? `Testy przeszły (${cases.length}).` : 'Część testów NIE przeszła — konsola.', 8000);
}

class ZohoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  field(name, desc, key, opts = {}) {
    const secret = SECRETS.includes(key);
    new Setting(this.containerEl).setName(name).setDesc(desc).addText((t) => {
      t.setValue(String(secret ? this.plugin.secrets[key] : this.plugin.settings[key])).onChange(async (v) => {
        if (secret) {
          this.plugin.secrets[key] = v;
          this.plugin.token = null;
          await secretSet(key, v);
          return;
        }
        this.plugin.settings[key] = v;
        await this.plugin.saveData(this.plugin.settings);
        if (opts.reschedule) this.plugin.schedule();
      });
      if (secret) t.inputEl.type = 'password';
      if (opts.placeholder) t.setPlaceholder(opts.placeholder);
    });
  }

  async zohoFolders() {
    try {
      const s = this.plugin.settings;
      if (!s.accountId) s.accountId = (await this.plugin.api('/accounts'))[0].accountId;
      const folders = await this.plugin.api(`/accounts/${s.accountId}/folders`);
      return folders.map((f) => String(f.path || f.folderName).replace(/^\//, '')).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  async saveRoutes(rows) {
    this.plugin.settings.postRoutes = rows.filter((r) => r.name || r.vault).map((r) => `${r.name} > ${r.vault}`).join('\n');
    await this.plugin.saveData(this.plugin.settings);
  }

  renderRoutes(el) {
    el.empty();
    // stan trzymamy tu, nie w tekście ustawień — świeżo dodany, jeszcze pusty wiersz nie ma się jak zapisać
    if (!this.rows) this.rows = parseRoutes(this.plugin.settings.postRoutes).map((r) => ({ name: r.name, vault: r.vault }));
    const rows = this.rows;
    const vaultFolders = this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f.children && f.path !== '/')
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, 'pl'));

    rows.forEach((row, i) => {
      const setting = new Setting(el);
      setting.infoEl.remove(); // bez lewej kolumny kontrolki dostają całą szerokość
      setting.controlEl.style.width = '100%';
      if (this.folders && this.folders.length) {
        // wpisany ręcznie folder trafia w ten z Zoho mimo innej wielkości liter (tak samo szuka resolveFolder),
        // więc prostujemy pisownię zamiast straszyć „brakiem w Zoho"
        const same = this.folders.find((f) => f.toLowerCase() === row.name.toLowerCase());
        if (same && same !== row.name) row.name = same;
        setting.addDropdown((d) => {
          if (!row.name) d.addOption('', '— wybierz folder —');
          if (row.name && !this.folders.includes(row.name)) d.addOption(row.name, `${row.name} (brak w Zoho)`);
          this.folders.forEach((f) => d.addOption(f, f));
          d.setValue(row.name).onChange(async (v) => {
            row.name = v;
            await this.saveRoutes(rows);
          });
          d.selectEl.style.flex = '1';
          d.selectEl.style.minWidth = '0';
        });
      } else {
        setting.addText((t) =>
          t
            .setPlaceholder('folder w Zoho')
            .setValue(row.name)
            .onChange(async (v) => {
              row.name = v.trim();
              await this.saveRoutes(rows);
            })
        );
      }
      // ścieżka = wybrany folder + opcjonalny podfolder z rokiem, więc obie strony klika się z listy
      const stripYear = (v) => v.replace(/\/\{YYYY\}$/, '');
      const base = stripYear(row.vault);
      const byYear = row.vault !== base;
      // stan czytamy z row przy każdej zmianie — inaczej przełącznik cofnąłby świeżo wybrany folder
      const setVault = async (b, y) => {
        row.vault = b + (y ? '/{YYYY}' : '');
        await this.saveRoutes(rows);
      };
      setting.addDropdown((d) => {
        if (!base) d.addOption('', '— wybierz folder —');
        if (base && !vaultFolders.includes(base)) d.addOption(base, `${base} (brak w vaulcie)`);
        vaultFolders.forEach((f) => d.addOption(f, f));
        d.setValue(base).onChange((v) => setVault(v, row.vault !== stripYear(row.vault)));
        d.selectEl.style.flex = '1';
        d.selectEl.style.minWidth = '0';
      });
      setting.controlEl.createSpan({ text: 'podfolder z rokiem' }).style.opacity = '0.7';
      setting.addToggle((t) => t.setValue(byYear).onChange((v) => setVault(stripYear(row.vault), v)));
      setting.addExtraButton((b) =>
        b
          .setIcon('trash')
          .setTooltip('Usuń trasę')
          .onClick(async () => {
            rows.splice(i, 1);
            await this.saveRoutes(rows);
            this.renderRoutes(el);
          })
      );
    });

    new Setting(el).addButton((b) =>
      b.setButtonText('Dodaj trasę').onClick(async () => {
        rows.push({ name: this.folders && this.folders.length ? this.folders[0] : '', vault: '' });
        await this.saveRoutes(rows);
        this.renderRoutes(el);
      })
    );
  }

  display() {
    const { containerEl: c } = this;
    c.empty();
    this.rows = null; // przy otwarciu ustawień czytamy trasy z data.json

    new Setting(c).setName('Data center').setDesc('Domena, na której masz Zoho.').addDropdown((d) => {
      d.addOptions({ eu: 'zoho.eu', com: 'zoho.com', in: 'zoho.in', 'com.au': 'zoho.com.au', jp: 'zoho.jp', ca: 'zohocloud.ca' })
        .setValue(this.plugin.settings.region)
        .onChange(async (v) => {
          this.plugin.settings.region = v;
          this.plugin.token = null;
          await this.plugin.saveData(this.plugin.settings);
        });
    });

    this.field('Client ID', `Z Zoho API Console → Self Client. Trzymane w ${storeName()}.`, 'clientId');
    this.field('Client secret', '', 'clientSecret');
    this.field('Refresh token', 'Bezterminowy, wygenerowany raz przez curl.', 'refreshToken');
    this.field('Account ID', 'Puste = wykryje samo przy pierwszym pobraniu.', 'accountId');
    this.field('Folder w Zoho', 'Np. Inbox albo własny folder z reguły filtrującej.', 'folderName');
    this.field('Filtr nadawców', 'Adresy po przecinku. Puste = wszystko z folderu.', 'senders', { placeholder: 'ktos@example.com' });
    this.field('Folder w vaulcie', 'Gdzie zapisywać notatki.', 'vaultFolder');
    this.field('Co ile minut', '0 = tylko ręcznie.', 'pollMinutes', { reschedule: true });

    new Setting(c)
      .setName('Newslettery')
      .setDesc('Folder w Zoho → folder w vaulcie, w formacie notatki jak z Web Clippera. Opcjonalnie z podfolderem na rocznik.')
      .setHeading();
    const routesEl = c.createDiv();
    this.renderRoutes(routesEl);
    // lista folderów z Zoho przychodzi po sieci — do tego czasu (albo gdy się nie uda) jest zwykłe pole tekstowe
    this.zohoFolders().then((list) => {
      if (!list.length) return;
      this.folders = list;
      this.renderRoutes(routesEl);
    });

    new Setting(c)
      .setName('Pobierz ostatnie newslettery')
      .setDesc('Test: bierze N najnowszych z folderu newsletterów, ignoruje „widziane" i NADPISUJE notatki.')
      .addText((t) => t.setValue('2').setPlaceholder('2').onChange((v) => (this.testCount = Number(v) || 2)))
      .addButton((b) => b.setButtonText('Pobierz').onClick(() => this.plugin.syncLatestPosts(this.testCount || 2)));

    new Setting(c)
      .setName('Pobierz wszystko od nowa')
      .setDesc('Czyści listę „widzianych" i pobiera od nowa. Istniejące notatki tych wiadomości zostaną NADPISANE — użyj po zmianie sposobu konwersji, nie na notatkach, które ręcznie edytowałeś.')
      .addButton((b) =>
        b.setButtonText('Wyczyść i pobierz').setWarning().onClick(async () => {
          this.plugin.settings.seen = [];
          await this.plugin.saveData(this.plugin.settings);
          await this.plugin.sync(true, true);
        })
      );

    new Setting(c).setName('Test połączenia').setDesc('Sprawdza token, konto i czy folder istnieje.').addButton((b) =>
      b.setButtonText('Testuj').onClick(async () => {
        try {
          const f = await this.plugin.resolveFolder();
          await this.plugin.saveData(this.plugin.settings);
          new Notice(`OK — konto ${this.plugin.settings.accountId}, folder "${f.folderName}" (${f.folderId}).`, 8000);
          this.display();
        } catch (e) {
          new Notice('Błąd: ' + e.message, 10000);
        }
      })
    );
  }
}
