const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, htmlToMarkdown, normalizePath, moment, Platform } = require('obsidian');

const DEFAULTS = {
  region: 'eu',
  accountId: '',
  folderName: 'Inbox',
  senders: '',
  vaultFolder: 'Emails',
  pollMinutes: 15,
  seen: []
};

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

// --- HTML -> markdown ------------------------------------------------------
function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = String(s || '');
  return el.value;
}

function addresses(raw) {
  const found = decodeEntities(raw).match(/[^\s<>,;"']+@[^\s<>,;"']+/g);
  return found ? [...new Set(found.map((a) => a.toLowerCase()))] : [];
}

// tabela z danymi zostaje tabela; tabela uzyta do ukladu strony (newslettery) idzie do rozpakowania
function unwrapTable(t) {
  const frag = document.createDocumentFragment();
  for (const cell of Array.from(t.querySelectorAll('td, th'))) {
    const div = document.createElement('div');
    while (cell.firstChild) div.appendChild(cell.firstChild);
    frag.appendChild(div);
  }
  t.replaceWith(frag);
}

function htmlToMd(html) {
  try {
    const root = document.createElement('div');
    root.innerHTML = String(html || '');
    root.querySelectorAll('style, script, meta, link, title').forEach((el) => el.remove());
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
    // ponytail: rozpakowujemy KAZDA tabele. Maile uzywaja ich do ukladu strony, a nie do danych;
    // trzy podejscia do odroznienia jednych od drugich konczyly sie pustym szkieletem |||.
    // Tresc zostaje, ginie tylko siatka. Wroc do heurystyki, jesli kiedys przyjdzie mail z prawdziwa tabela.
    // Od najglebszych, zeby zagniezdzone rozpakowac przed rodzicem.
    for (const t of Array.from(root.querySelectorAll('table')).reverse()) unwrapTable(t);
    return htmlToMarkdown(root.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) {
    // turndown potrafi paść na popsutym HTML (np. <tr> bez komórek) — wtedy goły tekst zamiast utraty maila
    console.warn('[zoho] htmlToMarkdown padł, zapisuję bez formatowania:', e.message);
    const el = document.createElement('div');
    el.innerHTML = String(html || '');
    return (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
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

    this.addSettingTab(new ZohoSettingTab(this.app, this));
    this.addRibbonIcon('mail', 'Pobierz maile z Zoho', () => this.sync(true));
    this.addCommand({ id: 'sync', name: 'Pobierz maile z Zoho', callback: () => this.sync(true) });
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
    const token = r.json && r.json.access_token;
    if (!token) throw new Error('Nie udało się odświeżyć tokenu: ' + r.text.slice(0, 200));
    this.token = { value: token, expires: Date.now() + (r.json.expires_in || 3600) * 1000 };
    return token;
  }

  async api(path, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const r = await requestUrl({
      url: `https://mail.zoho.${this.settings.region}/api${path}${qs}`,
      headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}` },
      throw: false
    });
    if (r.status !== 200) throw new Error(`${path} → HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json.data;
  }

  async resolveFolder() {
    const s = this.settings;
    if (!s.accountId) s.accountId = (await this.api('/accounts'))[0].accountId;
    const folders = await this.api(`/accounts/${s.accountId}/folders`);
    const want = s.folderName.trim().toLowerCase().replace(/^\//, '');
    const folder = folders.find((f) => [f.folderName, f.path].some((v) => (v || '').toLowerCase().replace(/^\//, '') === want));
    if (!folder) throw new Error(`Brak folderu "${s.folderName}". Dostępne: ${folders.map((f) => f.folderName).join(', ')}`);
    return folder;
  }

  async sync(manual, overwrite) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const s = this.settings;
      const folder = await this.resolveFolder();
      const msgs = await this.api(`/accounts/${s.accountId}/messages/view`, {
        folderId: folder.folderId, limit: 50, sortBy: 'date', sortorder: false
      });
      const senders = s.senders.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
      const seen = new Set(s.seen);
      let saved = 0;
      let failed = 0;
      for (const m of msgs.reverse()) {
        if (seen.has(m.messageId)) continue;
        // widok folderu zwraca całe wątki — kopie z Wysłanych mają własne folderId
        if (String(m.folderId) !== String(folder.folderId)) continue;
        const from = (m.fromAddress || '').toLowerCase();
        if (senders.length && !senders.some((x) => from.includes(x))) continue;
        try {
          await this.saveNote(folder.folderId, m, overwrite);
          s.seen.push(m.messageId);
          saved++;
        } catch (e) {
          // jedna felerna wiadomość nie może ubić całego przebiegu; przy następnym pobraniu spróbujemy znowu
          failed++;
          console.error('[zoho] pominięto', m.messageId, m.subject, e);
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
      // ponytail: ostatnie 500 ID jako deduplikacja; przejdź na receivedTime jeśli folder kiedyś urośnie
      this.settings.seen = this.settings.seen.slice(-500);
      await this.saveData(this.settings);
      this.syncing = false;
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

  async saveNote(folderId, m, overwrite) {
    const { content } = await this.api(`/accounts/${this.settings.accountId}/folders/${folderId}/messages/${m.messageId}/content`);
    const when = moment(Number(m.receivedTime || m.receivedtime || m.sentDateInGMT || Date.now()));
    const subject = decodeEntities(m.subject || '').trim();
    const title = `${when.format('YYYY-MM-DD HH-mm')} ${subject || '(bez tematu)'}`
      .replace(/[\\/:*?"<>|#^[\]]/g, '-')
      .replace(/\s+/g, ' ')
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
      else path = normalizePath(`${dir}/${title} ${m.messageId}.md`);
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
    yaml.push(`subject: "${subject.replace(/"/g, "'")}"`);
    yaml.push(`date: ${when.format('YYYY-MM-DDTHH:mm:ss')}`);
    yaml.push(`messageId: "${m.messageId}"`);
    yaml.push('---', '');

    const note = yaml.join('\n') + '\n' + htmlToMd(content) + '\n';
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
  check('każda tabela rozpakowana, treść zostaje', !data.includes('|') && data.includes('1') && data.includes('B'));

  const empty = htmlToMd('<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table><p>hej</p>');
  check('pusta tabela nie zostawia szkieletu', !empty.includes('|') && empty.includes('hej'));

  const linked = htmlToMd('<a href="http://track/x"><img src="http://x/a.png"></a>');
  check('grafika wyjęta z linku', linked.startsWith('![') && !linked.startsWith('[!'));
  check('link z tekstem zachowany', htmlToMd('<a href="http://x/">klik</a>').includes('[klik]'));

  const nested = htmlToMd('<table><tr><td><table><tr><td>środek</td></tr></table></td></tr></table>');
  check('zagnieżdżona tabela rozpakowana', !nested.includes('|') && nested.includes('środek'));
  check('ikonka wyjęta przed link', htmlToMd('<a href="http://x/"><img src="http://x/i.png">Faktura</a>').startsWith('!['));

  check('piksel śledzący usunięty', !htmlToMd('<img src="http://x/p.gif" width="1" height="1"><p>hej</p>').includes('p.gif'));
  check('style wycięte', !htmlToMd('<style>a{color:red}</style><p>hej</p>').includes('color'));
  check('popsuty HTML nie wywala', typeof htmlToMd('<table><tr></table><p>hej</p>') === 'string');

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

  display() {
    const { containerEl: c } = this;
    c.empty();

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
