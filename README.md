# Zoho to Vault

Wtyczka do Obsidiana: wiadomości z Zoho Mail lądują w vaulcie jako notatki.
Po REST API, więc działa tak samo na desktopie i na iOS/Androidzie (IMAP na mobile odpada).

## Instalacja

### BRAT (zalecane — aktualizacje same)

1. Zainstaluj [BRAT](https://github.com/TfTHacker/obsidian42-brat) z Community plugins.
2. `Cmd+P` → **BRAT: Add a beta plugin for testing** → wklej:

   ```
   kacperpaluch/obsidian-zoho-to-vault
   ```

3. Włącz **Zoho to Vault** w Community plugins.

BRAT sam sprawdza nowe wydania i podbija wersję. Działa też na mobile.

### Ręcznie

Pobierz `zoho-to-vault.zip` z [ostatniego wydania](https://github.com/kacperpaluch/obsidian-zoho-to-vault/releases/latest),
rozpakuj do `<vault>/.obsidian/plugins/` i włącz w Community plugins.
Bez builda — `main.js` to gotowy plik, więc równie dobrze możesz skopiować `main.js` i `manifest.json` prosto z repo.

## Konfiguracja

1. [Zoho API Console](https://api-console.zoho.eu/) → **Self Client** → Create.
2. Zakładka **Generate Code**:
   - Scope: `ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ`
   - Duration: 10 min → **Create** → skopiuj kod.
3. Wymień kod na refresh token (raz, bezterminowy):

   ```bash
   curl -s -X POST "https://accounts.zoho.eu/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=CLIENT_ID" \
     -d "client_secret=CLIENT_SECRET" \
     -d "code=KOD"
   ```

4. Wklej client ID / secret / refresh token w ustawieniach wtyczki, wybierz data center,
   kliknij **Testuj**. Account ID wykryje się samo.

Sekrety **nie trafiają do `data.json`**, więc nie jadą przez sync vaulta: na macOS lądują
w pęku kluczy (`security`, usługa `obsidian-zoho-to-vault`); na mobile, Windowsie i Linuksie
w `localStorage` urządzenia — czystym tekstem, bo systemowego pęku tam nie ma. Skutek uboczny: na każdym urządzeniu wklejasz je raz osobno.

## Filtrowanie po nadawcy

Dwie drogi:

- **Filtr w ustawieniach wtyczki** — adresy po przecinku, dopasowanie po fragmencie `fromAddress`.
- **Reguła w Zoho** (zalecane) — „od X → przenieś do folderu `Obsidian`", a we wtyczce
  ustawiasz ten folder i zostawiasz filtr pusty. Mniej odpytywania, filtrowanie po stronie serwera.

## Newslettery

Osobny format dla newsletterów: notatka jak z Web Clippera zamiast maila w notatce. W ustawieniach
→ **Newslettery** dodajesz trasę: folder w Zoho (lista zaciągana z konta, najlepiej z reguły
„od X → tutaj") → folder w vaulcie (lista folderów Obsidiana), plus przełącznik „podfolder
z rokiem". Tras może być dowolnie wiele. Notatka dostaje frontmatter
`title / source / published / Anki`, a nazwą pliku jest temat maila — bez daty z przodu,
bez emoji, z numerem wydania na początku, jeśli treść zaczyna się od `**#258**`.

Co się dzieje z treścią:

- **Substack** — z maila wyciągamy link „View in browser", a w nim siedzi token subskrybenta.
  Tym tokenem pobieramy **post ze strony** (`.body.markup`): prawdziwe adresy zamiast
  `substack.com/redirect/…`, podpisy pod obrazkami, zero zgadywania gdzie kończy się chrom.
  Token żyje ~30 dni — po wygaśnięciu (albo przy zmianie szablonu) wracamy do treści maila.
- **Reszta** — treść z maila, obcięta po markerach: nagłówek do „READ IN APP", stopka od
  „Like"/„Copyright ©"/linku wypisu, końcowe paski ikonek.
- **Google Drive** — PDF-y i nagrania linkowane w treści lądują w vaulcie (katalog załączników
  z ustawień Obsidiana, oryginalna nazwa z `Content-Disposition`), a link zamienia się w
  `[[Newsletter 258.pdf]] ([Drive](…))`. Działa też na link do **folderu** — do 3 plików, żeby
  odnośnik do archiwum nie ściągnął pół gigabajta. Plik nie do pobrania bez logowania?
  Zostaje zwykły link.
- **Obrazki zostają zdalnymi adresami** — od ściągania jest
  [Local Images Plus](https://github.com/Sergei-Korneev/obsidian-local-images-plus) z włączonym
  „process created notes".

Komenda **Zoho: pobierz 2 ostatnie newslettery (test)** (i przycisk w ustawieniach) bierze N
najnowszych z każdej trasy, ignoruje listę „widzianych" i **nadpisuje** notatki — do kalibracji
po zmianie ustawień.

## Ograniczenia

- **Na mobile nie ma tła.** Odpytywanie leci tylko przy otwartym Obsidianie — mail trafi do vaulta
  przy najbliższym uruchomieniu appki, nie w momencie doręczenia.
- Jeden przebieg zaciąga do 500 wiadomości (10 stron po 50) i zatrzymuje się na pierwszej już
  znanej. Jeśli w folderze czeka więcej, resztę dobierze kolejny przebieg.
- Bez oznaczania jako przeczytane, bez szablonów nazw notatek.
- Załączniki lądują w podfolderze `zalaczniki` obok notatek, pod nazwą `<messageId> <plik>` —
  nazwa musi być przewidywalna, żeby „Pobierz wszystko od nowa" nie dokładało kopii przy każdym
  przebiegu. Ustawienie folderu załączników vaulta jest przy tym ignorowane. Obrazki inline
  podmieniane są z `cid:` na `![[plik]]`, reszta trafia na koniec notatki pod „Załączniki".
- Tabela z nagłówkami `<th>`, bez tabeli w środku i bez `role="presentation"` zostaje tabelą —
  reszta idzie do rozpakowania, bo maile używają tabel do układu strony, a nie do danych.
- Ukryte elementy (`display:none`, `visibility:hidden`, `opacity:0`, `aria-hidden`) są wycinane —
  to preheader newslettera, który inaczej ląduje jako pierwsza linijka treści.
- Grafiki są wyjmowane z linków (`[![[x.png]]](url)` się nie renderuje), a linki śledzące
  wokół samych obrazków znikają. HTML maila parsuje `DOMParser`, więc piksele śledzące nie
  zdążą się pobrać, a skrypty z treści nie mają jak wystartować.
- Komenda **Zoho: test konwersji HTML** sprawdza tę logikę na miejscu, w konsoli.
- Deduplikacja po `messageId`, pamięć ostatnich 500 ID w `data.json`.
- Newslettery: pliki z Drive'a o tej samej nazwie, ale innym rozmiarze dostają sufiks z ID —
  wolimy dwa pliki niż nadpisanie cudzej treści. Lista plików w folderze Drive'a jest skrobana
  z HTML-a (`data-id`), bo bez klucza API nie ma się jak zapytać — zmieni się markup, zostanie
  zwykły link.
